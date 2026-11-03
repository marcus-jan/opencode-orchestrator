import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { findProjects, gitRoot, slug } from "./projects"
import { apply, board, EVENT_TYPES, NOTIFY_STATES, transitionFor, type Registry, type Worker } from "./registry"

const ID = "orchestrator"
const ORCHESTRATOR_KEY = "orchestrator"
const WORKERS_KEY = "workers"
const BOARD_KEY = "orchestrator-workers"

export interface Options {
  /** Directory the orchestrator lives in. Only the plugin instance for this location is active. */
  home: string
  /** Title applied to the pinned orchestrator session. */
  title: string
  /** Post a synthetic message to the orchestrator when a worker finishes, fails, or blocks. */
  notify: boolean
  /** Give workers spawned inside a git project their own worktree unless the call says otherwise. */
  worktree: boolean
}

export function parseOptions(raw: unknown, fallbackHome: string): Options {
  const options = (raw ?? {}) as Record<string, unknown>
  const pick = <T>(key: string, type: string, fallback: T): T => {
    const value = options[key]
    if (value === undefined) return fallback
    if (typeof value !== type) throw new Error(`${ID}: option "${key}" must be a ${type}`)
    return value as T
  }
  return {
    home: path.resolve(pick("home", "string", fallbackHome)),
    title: pick("title", "string", "Orchestrator"),
    notify: pick("notify", "boolean", true),
    worktree: pick("worktree", "boolean", true),
  }
}

const str = (value: unknown, name: string, required = true) => {
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${name}" must be a non-empty string`)
  return value.trim()
}

export default Plugin.define({
  id: ID,
  async setup(ctx) {
    const options = parseOptions(ctx.options, ctx.location.directory)
    // The server creates one plugin instance per location and events are global,
    // so only the instance for the orchestrator's home does any work.
    if (path.resolve(ctx.location.directory) !== options.home) return

    const controller = new AbortController()
    let registry = ((await ctx.storage.get(WORKERS_KEY)) ?? {}) as unknown as Registry
    let orchestratorID = (await ctx.storage.get(ORCHESTRATOR_KEY)) as string | undefined

    let chain = Promise.resolve()
    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
      const run = chain.then(task, task)
      chain = run.then(() => undefined, () => undefined)
      return run
    }

    const save = () => ctx.storage.set(WORKERS_KEY, registry as never)

    const publish = async () => {
      if (!orchestratorID) return
      const projects = await findProjects(options.home)
      const value = [
        `Git projects under ${options.home} (spawn_worker "project"): ${projects.join(", ") || "none"}`,
        `Workers get their own worktree by default: ${options.worktree ? "yes" : "no"}`,
        `Worker sessions you spawned:\n${board(registry)}`,
      ].join("\n\n")
      await ctx.session.instructions.entry
        .put({ sessionID: orchestratorID, key: BOARD_KEY, value })
        .catch((error: unknown) => console.warn(`[${ID}]`, "failed to publish board", error))
    }

    const notify = async (worker: Worker) => {
      if (!options.notify || !orchestratorID) return
      const detail = worker.detail ? `: ${worker.detail}` : ""
      await ctx.session
        .synthetic({
          sessionID: orchestratorID,
          text: `Worker "${worker.title}" (${worker.id}) is now ${worker.state}${detail}.`,
          description: `${worker.title} ${worker.state}`,
          delivery: "queue",
          resume: false,
        })
        .catch((error: unknown) => console.warn(`[${ID}]`, "failed to notify orchestrator", error))
    }

    const pin = async (sessionID: string) => {
      orchestratorID = sessionID
      await ctx.storage.set(ORCHESTRATOR_KEY, sessionID)
      await ctx.session.update({ sessionID, title: options.title }).catch(() => undefined)
      await publish()
    }

    const ensureOrchestrator = async () => {
      if (orchestratorID) {
        const existing = await ctx.session.get({ sessionID: orchestratorID }).catch(() => undefined)
        if (existing) return orchestratorID
      }
      const created = await ctx.session.create({ title: options.title, location: { directory: options.home } })
      await pin(created.id)
      return created.id
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "orchestrator",
        description: "Pin this session as the orchestrator (send Scrawl/Hex here)",
        execute: ({ sessionID }) =>
          enqueue(async () => {
            await pin(sessionID)
            await ctx.session.synthetic({
              sessionID,
              text: `This session is now the orchestrator. Send captures here with:\n  scrawl send <bundle> --session ${sessionID}`,
              resume: false,
            })
          }).then(() => undefined),
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: ID, description: "Spawn and track worker OpenCode sessions" })
      editor.add({
        name: "list_projects",
        description: `List the git projects (folders under ${options.home}) that workers can be spawned in.`,
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: ID },
        execute: async () => {
          const projects = await findProjects(options.home)
          return { content: projects.length ? projects.map((name) => `- ${name}`).join("\n") : "No git projects found." }
        },
      })
      editor.add({
        name: "spawn_worker",
        description:
          "Start a new OpenCode worker session with an initial prompt, optionally in its own git worktree of a project. The worker runs independently; its status appears on your worker board.",
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short title for the worker session" },
            prompt: { type: "string", description: "Full task for the worker; it has no other context" },
            project: {
              type: "string",
              description: `Project folder under ${options.home} (see list_projects), e.g. "rate.com"`,
            },
            directory: {
              type: "string",
              description: "Subdirectory inside the project (or relative to the orchestrator home when no project)",
            },
            worktree: {
              type: ["boolean", "string"],
              description: `Give the worker its own git worktree: true (named from the title) or a name. Default ${options.worktree}`,
            },
            base: { type: "string", description: "Starting ref for the worktree (default: the project's current HEAD)" },
            agent: { type: "string", description: "Agent to run (default: the configured default agent)" },
          },
          required: ["title", "prompt"],
          additionalProperties: false,
        },
        options: { namespace: ID },
        execute: async (raw) => {
          const input = raw as Record<string, unknown>
          const title = str(input.title, "title")!
          const prompt = str(input.prompt, "prompt")!
          const project = str(input.project, "project", false)
          const agent = str(input.agent, "agent", false)
          const base = str(input.base, "base", false)
          const anchor = project ? path.resolve(options.home, project) : options.home
          const target = path.resolve(anchor, str(input.directory, "directory", false) ?? ".")
          const root = await gitRoot(target)
          if (project && !root) throw new Error(`"${project}" is not a git project under ${options.home}`)

          // The configured default only applies inside a git project; an explicit request must have one.
          const wanted = input.worktree === undefined ? options.worktree && !!root : input.worktree
          if (typeof wanted !== "boolean" && typeof wanted !== "string") throw new Error(`"worktree" must be a boolean or string`)
          const worktreeName = wanted === false ? undefined : slug(wanted === true ? title : wanted)
          if (worktreeName && !root) throw new Error(`a worktree needs a git project; ${target} is not inside one`)

          return enqueue(async () => {
            const session = await ctx.session.create({
              title,
              agent,
              location: { directory: worktreeName ? root! : target },
              metadata: { orchestrator: orchestratorID ?? null },
            })
            let directory = target
            if (worktreeName) {
              const created = await ctx.worktree.create({ projectID: session.projectID, name: worktreeName, branch: base })
              directory = path.join(created.directory, path.relative(root!, target))
              await ctx.session.move({ sessionID: session.id, directory })
            }
            const now = Date.now()
            registry[session.id] = {
              id: session.id,
              title,
              directory,
              project: root,
              worktree: worktreeName,
              state: "queued",
              created: now,
              updated: now,
            }
            await save()
            await ctx.session.prompt({ sessionID: session.id, text: prompt })
            await publish()
            const where = worktreeName ? `worktree "${worktreeName}" at ${directory}` : directory
            return { content: `Spawned worker "${title}" as ${session.id} in ${where}.` }
          })
        },
      })
      editor.add({
        name: "list_workers",
        description: "Show every worker session and its current status.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: ID },
        execute: async () => ({ content: board(registry) }),
      })
      editor.add({
        name: "message_worker",
        description: "Send a follow-up prompt to an existing worker session.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string" },
            text: { type: "string" },
            steer: { type: "boolean", description: "Interject into the running turn instead of queueing" },
          },
          required: ["sessionID", "text"],
          additionalProperties: false,
        },
        options: { namespace: ID },
        execute: async (raw) => {
          const input = raw as Record<string, unknown>
          const sessionID = str(input.sessionID, "sessionID")!
          if (!registry[sessionID]) throw new Error(`${sessionID} is not a tracked worker`)
          await ctx.session.prompt({
            sessionID,
            text: str(input.text, "text")!,
            delivery: input.steer === true ? "steer" : "queue",
          })
          return { content: `Sent to ${registry[sessionID].title}.` }
        },
      })
      editor.add({
        name: "forget_worker",
        description: "Stop tracking a worker (does not delete its session).",
        input: {
          type: "object",
          properties: { sessionID: { type: "string" } },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: ID },
        execute: async (raw) => {
          const sessionID = str((raw as Record<string, unknown>).sessionID, "sessionID")!
          return enqueue(async () => {
            const existed = delete registry[sessionID]
            await save()
            await publish()
            return { content: existed ? `Forgot ${sessionID}.` : `${sessionID} was not tracked.` }
          })
        },
      })
    })

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: [...EVENT_TYPES], signal: controller.signal })) {
          const transition = transitionFor(event)
          if (!transition?.sessionID || !registry[transition.sessionID]) continue
          await enqueue(async () => {
            const worker = apply(registry, transition)
            if (!worker) return
            await save()
            await publish()
            if (NOTIFY_STATES.has(worker.state)) await notify(worker)
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) console.warn(`[${ID}]`, "event stream stopped", error)
      }
    })()

    void enqueue(async () => {
      await ensureOrchestrator()
    }).catch((error) => console.warn(`[${ID}]`, "failed to start orchestrator session", error))

    return () => controller.abort()
  },
})

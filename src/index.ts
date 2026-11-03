import { homedir } from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { branchExists, herdr, resolveBase, type Opened } from "./herdr"
import { findProjects, gitRoot, slug } from "./projects"
import { apply, board, EVENT_TYPES, NOTIFY_STATES, transitionFor, type Registry, type Worker } from "./registry"

const ID = "orchestrator"
const ORCHESTRATOR_KEY = "orchestrator"
const WORKERS_KEY = "workers"
const BOARD_KEY = "orchestrator-workers"
const ORIGIN_KEY = "orchestrator-origin"

export interface Options {
  /** Directory the orchestrator lives in. Only the plugin instance for this location is active. */
  home: string
  /** Title applied to the pinned orchestrator session. */
  title: string
  /** Post a synthetic message to the orchestrator when a worker finishes, fails, or blocks. */
  notify: boolean
  /** Give workers spawned inside a git project their own worktree unless the call says otherwise. */
  worktree: boolean
  /** Herdr binary used to open every worker in its own space, or false to keep workers headless. */
  herdr: string | false
  /** Model for workers as "providerID/modelID"; defaults to the model of the session that spawns them. */
  model?: { providerID: string; id: string }
}

export function parseOptions(raw: unknown, fallbackHome: string): Options {
  const options = (raw ?? {}) as Record<string, unknown>
  const pick = <T>(key: string, type: string, fallback: T): T => {
    const value = options[key]
    if (value === undefined) return fallback
    if (typeof value !== type) throw new Error(`${ID}: option "${key}" must be a ${type}`)
    return value as T
  }
  const defaultHerdr = process.env.HERDR_BIN_PATH ?? path.join(homedir(), ".local", "bin", "herdr")
  if (options.herdr !== undefined && options.herdr !== false && typeof options.herdr !== "string") {
    throw new Error(`${ID}: option "herdr" must be a string or false`)
  }
  const model = pick<string | undefined>("model", "string", undefined)
  const slash = model?.indexOf("/") ?? -1
  if (model !== undefined && slash < 1) throw new Error(`${ID}: option "model" must look like "providerID/modelID"`)
  return {
    model: model ? { providerID: model.slice(0, slash), id: model.slice(slash + 1) } : undefined,
    home: path.resolve(pick("home", "string", fallbackHome)),
    title: pick("title", "string", "Orchestrator"),
    notify: pick("notify", "boolean", true),
    worktree: pick("worktree", "boolean", true),
    herdr: (options.herdr as string | false | undefined) ?? defaultHerdr,
  }
}

const NAMING = `Naming (you decide; never ask): give each worker a short friendly "title" (it becomes the herdr space label and session title) and, for repo work, a "branch" that follows the repo's convention: feat/, fix/, chore/, docs/ or hotfix/ prefix, Jira keys kept uppercase, e.g. feat/ABC-123-short-description. Worktrees branch off develop (master for hotfix/ branches) unless you pass "base". Ideas not tied to a repo: omit "project"; they get a new space in the orchestrator's folder. Always pass "why": the source of the request and the outcome the user wants.`

export interface Origin {
  orchestrator?: string
  why: string
  project?: string
  branch?: string
  base?: string
  directory: string
  space?: string
  spawned: string
}

/** Standing context pinned into a worker so it knows why it exists after its first prompt is compacted away. */
export function origin(o: Origin): string {
  return [
    `You are a worker session started by the OpenCode orchestrator${o.orchestrator ? ` (${o.orchestrator})` : ""} on ${o.spawned}.`,
    `Why: ${o.why}`,
    o.project ? `Project: ${o.project}` : "Not tied to a repo: this is an idea space. Do not edit sibling repos; recommend a repo worker when code work is needed.",
    o.branch && `Branch: ${o.branch} off ${o.base}`,
    `Working directory: ${o.directory}`,
    o.space && `Herdr space: ${o.space}`,
    "The orchestrator only tracks your status (running, blocked, done, failed). Finish by summarizing what you did and what is left.",
  ]
    .filter(Boolean)
    .join("\n")
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
        `Workers in a project get their own worktree by default: ${options.worktree ? "yes" : "no"}`,
        NAMING,
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
          "Start a new OpenCode worker for an idea. Inside a project it gets a new branch + worktree opened as a herdr space nested under the repo; otherwise a new herdr space in the orchestrator's folder. Opens in the background; status appears on your worker board.",
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short friendly name: herdr space label and session title" },
            prompt: { type: "string", description: "Full task for the worker; it has no other context" },
            project: {
              type: "string",
              description: `Project folder under ${options.home} (see list_projects), e.g. "my-app". Omit for ideas not tied to a repo`,
            },
            directory: {
              type: "string",
              description: "Subdirectory inside the project (or relative to the orchestrator home when no project)",
            },
            branch: {
              type: "string",
              description: "New branch name following the repo convention, e.g. feat/ABC-123-short-description",
            },
            base: { type: "string", description: "Ref to branch from (default develop, or master for hotfix/ branches)" },
            worktree: {
              type: "boolean",
              description: `Give a project worker its own branch + worktree (default ${options.worktree}); false works in the checkout`,
            },
            why: {
              type: "string",
              description:
                "One or two sentences on why this worker exists: the source (e.g. Scrawl capture, dictation) and what the user wants out of it. Pinned in the worker's context",
            },
            agent: { type: "string", description: "Agent to run (default: the configured default agent)" },
          },
          required: ["title", "prompt", "why"],
          additionalProperties: false,
        },
        options: { namespace: ID },
        execute: async (raw, context) => {
          const input = raw as Record<string, unknown>
          const title = str(input.title, "title")!
          const prompt = str(input.prompt, "prompt")!
          const why = str(input.why, "why")!
          const project = str(input.project, "project", false)
          const agent = str(input.agent, "agent", false)
          const anchor = project ? path.resolve(options.home, project) : options.home
          const target = path.resolve(anchor, str(input.directory, "directory", false) ?? ".")
          const root = await gitRoot(target)
          if (project && !root) throw new Error(`"${project}" is not a git project under ${options.home}`)

          if (input.worktree !== undefined && typeof input.worktree !== "boolean") throw new Error(`"worktree" must be a boolean`)
          const wantTree = (input.worktree as boolean | undefined) ?? (options.worktree && !!root)
          if (wantTree && !root) throw new Error(`a worktree needs a git project; ${target} is not inside one`)

          let branch: string | undefined
          let base: string | undefined
          if (wantTree) {
            branch = str(input.branch, "branch", false) ?? `feat/${slug(title)}`
            if (await branchExists(root!, branch)) throw new Error(`branch "${branch}" already exists in ${root}`)
            const explicit = str(input.base, "base", false)
            const candidates = explicit ? [explicit] : branch.startsWith("hotfix/") ? ["master", "main"] : ["develop", "master", "main"]
            base = await resolveBase(root!, candidates)
          }

          const mux = options.herdr ? herdr(options.herdr) : undefined
          const useHerdr = !!mux && (await mux.available())
          let space: Opened | undefined
          let directory = target
          if (useHerdr && branch) {
            const parent = await mux!.repoSpace(root!).catch(() => undefined)
            space = await mux!.worktree({ root: root!, space: parent?.workspace_id, branch, base: base!, label: title })
            directory = path.join(space.directory, path.relative(root!, target))
          } else if (useHerdr) {
            space = await mux!.workspace({ cwd: target, label: title })
          }

          // Without herdr, fall back to an OpenCode-managed worktree for project workers.
          const headlessTree = !!branch && !space
          // Without an explicit model a worker falls back to OpenCode's free models, so inherit the caller's.
          const model = options.model ?? (await ctx.session.get({ sessionID: context.sessionID }).catch(() => undefined))?.model
          const session = await ctx.session.create({
            title,
            agent,
            model,
            location: { directory: headlessTree ? root! : directory },
            metadata: { orchestrator: orchestratorID ?? null },
          })
          if (headlessTree) {
            const created = await ctx.worktree.create({ projectID: session.projectID, name: slug(branch!), branch: base })
            directory = path.join(created.directory, path.relative(root!, target))
            await ctx.session.move({ sessionID: session.id, directory })
          }

          await enqueue(async () => {
            const now = Date.now()
            registry[session.id] = {
              id: session.id,
              title,
              directory,
              project: root,
              worktree: branch,
              space: space?.workspace,
              why,
              state: "queued",
              created: now,
              updated: now,
            }
            await save()
          })

          await ctx.session.instructions.entry.put({
            sessionID: session.id,
            key: ORIGIN_KEY,
            value: origin({
              orchestrator: orchestratorID,
              why,
              project: root,
              branch,
              base,
              directory,
              space: space?.workspace,
              spawned: new Date().toISOString(),
            }),
          })

          let warning = ""
          if (space) {
            await mux!
              .startOpencode({ label: title, pane: space.pane, sessionID: session.id })
              .catch((error: unknown) => (warning = ` Could not attach OpenCode in herdr ${space!.workspace}: ${error}`))
          }
          await ctx.session.prompt({ sessionID: session.id, text: prompt })
          await enqueue(publish)

          const where = [
            branch && `branch ${branch} off ${base}`,
            directory,
            space ? `herdr space ${space.workspace}` : !options.herdr ? undefined : "headless (herdr unavailable)",
          ].filter(Boolean)
          return { content: `Spawned worker "${title}" as ${session.id}: ${where.join(", ")}.${warning}` }
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

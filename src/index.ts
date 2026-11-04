import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  branchExists,
  branchOnOrigin,
  checkoutInfo,
  deleteBranch,
  herdr,
  paneSession,
  removeGitWorktree,
  resolveBase,
  type Opened,
} from "./herdr"
import { findProjects, gitRoot, slug } from "./projects"
import {
  apply,
  board,
  checkoutOf,
  closure,
  EVENT_TYPES,
  isClosed,
  leftovers,
  NOTIFY_STATES,
  transitionFor,
  type Presence,
  type Registry,
  type Worker,
  type WorkerState,
} from "./registry"
import { Orchestrator, type Snapshot } from "./rpc"

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
  /** How often to check whether workers were closed by hand (herdr space, worktree or session gone). 0 disables. */
  sweepSeconds: number
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
    sweepSeconds: pick("sweepSeconds", "number", 60),
  }
}

const notFound = (error: unknown) => {
  const e = error as { _tag?: string; message?: string } | undefined
  return /not ?found/i.test(`${e?._tag} ${e?.message} ${String(error)}`)
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
  /** The session existed before and was attached to the orchestrator later. */
  attached?: boolean
}

/** Standing context pinned into a worker so it knows why it exists after its first prompt is compacted away. */
export function origin(o: Origin): string {
  const by = `the OpenCode orchestrator${o.orchestrator ? ` (${o.orchestrator})` : ""}`
  return [
    o.attached
      ? `This session was attached to ${by} on ${o.spawned}; it now tracks you as a worker.`
      : `You are a worker session started by ${by} on ${o.spawned}.`,
    `Why: ${o.why}`,
    o.project ? `Project: ${o.project}` : o.attached ? undefined : "Not tied to a repo: this is an idea space. Do not edit sibling repos; recommend a repo worker when code work is needed.",
    o.branch && `Branch: ${o.branch}${o.base ? ` off ${o.base}` : ""}`,
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

/** Session metadata key /join-orchestrator sets; the home instance sees it through the global event stream. */
export const JOIN_KEY = "orchestratorJoin"

const JOIN_COMMAND = {
  name: "join-orchestrator",
  description: "Ask the orchestrator to track this session as a worker (optional: why)",
}

/** Works from any location: it only flags the session, so it doesn't need the home instance's state. */
const requestJoin = (ctx: Plugin.Context) => async ({ sessionID, prompt }: { sessionID: string; prompt?: { text?: string } }) => {
  const info = await ctx.session.get({ sessionID })
  const why = prompt?.text?.trim() || null
  await ctx.session.update({ sessionID, metadata: { ...(info.metadata ?? {}), [JOIN_KEY]: { why, at: Date.now() } } })
  await ctx.session.synthetic({
    sessionID,
    text: "Asked the orchestrator to track this session. It will appear on its worker board and sidebar.",
    resume: false,
  })
}

export default Plugin.define({
  id: ID,
  async setup(ctx) {
    const options = parseOptions(ctx.options, ctx.location.directory)
    // The server creates one plugin instance per location and events are global,
    // so only the instance for the orchestrator's home does any work.
    if (path.resolve(ctx.location.directory) !== options.home) {
      // Answer the sidebar with an empty board so TUIs on other sessions don't log errors.
      const idle = await ctx.rpc.register(Orchestrator, { snapshot: async () => ({ workers: [] }) })
      await ctx.command.transform((editor) => editor.add({ ...JOIN_COMMAND, execute: requestJoin(ctx) }))
      return () => void idle.dispose()
    }

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

    // Feeds the TUI sidebar shown in the orchestrator session.
    const rpc = await ctx.rpc.register(Orchestrator, {
      // RPC output must be plain JSON, so drop undefined fields.
      snapshot: async () =>
        JSON.parse(
          JSON.stringify({
            orchestrator: orchestratorID,
            workers: Object.values(registry).map(({ id, title, state, detail, space, updated }) => ({
              id,
              title,
              state,
              detail,
              space,
              updated,
            })),
          } satisfies Snapshot),
        ),
    })
    const changed = () =>
      rpc.events.emit("changed", {}).catch((error: unknown) => console.warn(`[${ID}]`, "failed to emit change", error))

    const publish = async () => {
      void changed()
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

    // Alerts that could not be delivered because the orchestrator session was gone; replayed on re-pin.
    const missed: { text: string; resume: boolean }[] = []

    /**
     * Pins a replacement after the orchestrator session disappears: the most recently used other root
     * session in home that is not a worker, else a new one. It gets a catch-up of missed alerts.
     */
    const repin = async (previous?: string) => {
      const listed = previous
        ? await ctx.session
            .list({ directory: options.home, parentID: null, order: "desc", limit: 20 })
            .catch(() => undefined)
        : undefined
      const candidate = listed?.data.find((session) => session.id !== previous && !session.parentID && !registry[session.id])
      const sessionID =
        candidate?.id ?? (await ctx.session.create({ title: options.title, location: { directory: options.home } })).id
      if (previous) console.warn(`[${ID}]`, `orchestrator ${previous} is gone; pinned ${sessionID}`)
      await pin(sessionID)
      const replay = missed.splice(0)
      if (previous || replay.length) {
        const text = [
          previous
            ? `The previous orchestrator session (${previous}) was deleted, so this session is now the orchestrator.`
            : "This session is now the orchestrator.",
          replay.length ? `Missed while there was no orchestrator:\n${replay.map((m) => `- ${m.text}`).join("\n")}` : "",
          `Send captures here with: scrawl send <bundle> --session ${sessionID}`,
        ]
          .filter(Boolean)
          .join("\n\n")
        await ctx.session
          .synthetic({
            sessionID,
            text,
            description: "Orchestrator re-pinned",
            delivery: "queue",
            resume: replay.some((m) => m.resume),
          })
          .catch((error: unknown) => console.warn(`[${ID}]`, "failed to post catch-up", error))
      }
      return sessionID
    }

    /** Posts an alert to the orchestrator, re-pinning first if its session was deleted. */
    const tell = async (text: string, description: string, resume: boolean) => {
      if (!options.notify) return
      const sessionID = orchestratorID
      if (!sessionID) {
        missed.push({ text, resume })
        await repin()
        return
      }
      await ctx.session
        .synthetic({ sessionID, text, description, delivery: "queue", resume })
        .catch(async (error: unknown) => {
          if (!notFound(error)) return console.warn(`[${ID}]`, "failed to notify orchestrator", error)
          missed.push({ text, resume })
          await repin(sessionID)
        })
    }

    const notify = async (worker: Worker) => {
      const detail = worker.detail ? `: ${worker.detail}` : ""
      await tell(`Worker "${worker.title}" (${worker.id}) is now ${worker.state}${detail}.`, `${worker.title} ${worker.state}`, false)
    }

    const mux = options.herdr ? herdr(options.herdr) : undefined

    const presence = async (worker: Worker, spaces: Set<string> | undefined): Promise<Presence> => {
      const checkout = checkoutOf(worker)
      const exists = worker.project && worker.worktree ? await branchExists(worker.project, worker.worktree) : false
      return {
        session: await ctx.session.get({ sessionID: worker.id }).then(
          () => true,
          (error: unknown) => !notFound(error),
        ),
        space: worker.space && spaces ? spaces.has(worker.space) : undefined,
        worktree: checkout ? existsSync(checkout) : undefined,
        branch: exists ? { exists, pushed: await branchOnOrigin(worker.project!, worker.worktree!) } : undefined,
      }
    }

    const notifyClosed = async (worker: Worker) => {
      const left = worker.leftovers ?? []
      const text = left.length
        ? `Worker "${worker.title}" (${worker.id}) was ${worker.detail}. Still left: ${left.join("; ")}. ` +
          `Ask the user whether to clean these up. If they agree, call close_worker for ${worker.id} ` +
          `(pass branch: true only if they want the branch deleted). Do not clean up without asking.`
        : `Worker "${worker.title}" (${worker.id}) was ${worker.detail}; nothing left to clean up.`
      // Only wake the orchestrator when there is something to ask about.
      await tell(text, `${worker.title} closed`, left.length > 0)
    }

    // Workers close_worker is tearing down, so a sweep mid-way doesn't report them as closed by hand.
    const closing = new Set<string>()

    /** Marks workers whose herdr space, worktree or session disappeared without close_worker as closed by the user. */
    const sweep = () =>
      enqueue(async () => {
        const open = Object.values(registry).filter((worker) => !isClosed(worker) && !closing.has(worker.id))
        if (!open.length) return
        const spaces = mux ? await mux.spaces() : undefined
        const closed: Worker[] = []
        for (const worker of open) {
          const found = closure(worker, await presence(worker, spaces))
          if (!found) continue
          const next: Worker = { ...worker, state: "closed", closedBy: "user", ...found, updated: Date.now() }
          registry[worker.id] = next
          closed.push(next)
        }
        if (!closed.length) return
        await save()
        await publish()
        for (const worker of closed) await notifyClosed(worker)
      }).catch((error: unknown) => console.warn(`[${ID}]`, "sweep failed", error))

    const pin = async (sessionID: string) => {
      orchestratorID = sessionID
      await ctx.storage.set(ORCHESTRATOR_KEY, sessionID)
      await ctx.session.update({ sessionID, title: options.title }).catch(() => undefined)
      await publish()
    }

    const ensureOrchestrator = async () => {
      if (orchestratorID) {
        const exists = await ctx.session.get({ sessionID: orchestratorID }).then(
          () => true,
          (error: unknown) => !notFound(error),
        )
        if (exists) return orchestratorID
      }
      return repin(orchestratorID)
    }

    /**
     * Workers without a model fall back to OpenCode's free models, and a stale configured model fails
     * every turn, so use the first of (option, spawning session's model) that is actually available.
     */
    const workerModel = async (callerID: string, directory: string) => {
      const caller = (await ctx.session.get({ sessionID: callerID }).catch(() => undefined))?.model
      const candidates = [options.model, caller].filter((ref): ref is NonNullable<typeof ref> => !!ref)
      const name = (ref: { providerID: string; id: string }) => `${ref.providerID}/${ref.id}`
      if (!candidates.length) {
        throw new Error(`no worker model: set the "model" option or give the orchestrator session a model`)
      }
      const available = await ctx.model.list({ location: { directory } }).catch(() => undefined)
      if (!available) return { model: candidates[0], note: "" }
      const exists = (ref: { providerID: string; id: string }) =>
        available.data.some((info) => info.providerID === ref.providerID && (info.modelID ?? info.id) === ref.id)
      const model = candidates.find(exists)
      if (!model) {
        throw new Error(`no worker model available (tried ${candidates.map(name).join(", ")}); fix the "model" option`)
      }
      const note = model === candidates[0] ? "" : ` Model ${name(candidates[0])} is unavailable; using ${name(model)}.`
      return { model, note }
    }

    /**
     * Tracks a session that was started outside the orchestrator. Repo, branch and worktree come from its
     * folder and the herdr space from the pane running it; nothing new is created.
     */
    const adopt = async (sessionID: string, why: string | undefined) => {
      if (sessionID === orchestratorID) throw new Error("that is the orchestrator session itself")
      const info = await ctx.session.get({ sessionID }).catch((error: unknown) => {
        throw notFound(error) ? new Error(`session ${sessionID} does not exist`) : error
      })
      if (info.parentID) throw new Error(`${sessionID} is a subagent session; attach its parent ${info.parentID} instead`)
      const current = registry[sessionID]
      if (current && !isClosed(current)) return `"${current.title}" (${sessionID}) is already tracked.`

      const directory = info.location.directory
      const git = await checkoutInfo(directory)
      const linked = git?.linked && git.branch ? git : undefined
      const panes = mux && (await mux.available()) ? await mux.panes().catch(() => []) : []
      // A session in a repo's main checkout shares the repo's own space; close_worker must never close that.
      const found = panes.find((pane) => paneSession(pane) === sessionID)?.workspace_id
      const space = linked || !git ? found : undefined
      const time = info.time as { busy?: number; idle?: number }
      const state: WorkerState =
        time.busy && (!time.idle || time.busy > time.idle) ? "running" : info.outcome === "failed" ? "failed" : "done"
      const title = info.title || sessionID
      const reason = why ?? `Attached by the user; continue what "${title}" was doing.`

      await enqueue(async () => {
        const now = Date.now()
        registry[sessionID] = {
          id: sessionID,
          title,
          directory,
          project: git?.root,
          worktree: linked?.branch,
          checkout: linked?.checkout,
          space,
          why: reason,
          attached: true,
          state,
          created: now,
          updated: now,
        }
        await save()
        await publish()
      })
      await ctx.session.instructions.entry.put({
        sessionID,
        key: ORIGIN_KEY,
        value: origin({
          orchestrator: orchestratorID,
          why: reason,
          project: git?.root,
          branch: git?.branch,
          directory,
          space,
          spawned: new Date().toISOString(),
          attached: true,
        }),
      })
      const where = [git?.branch && `branch ${git.branch}${linked ? " (worktree)" : ""}`, directory, space && `herdr space ${space}`]
      return `Attached "${title}" (${sessionID}) as ${state}: ${where.filter(Boolean).join(", ")}.`
    }

    /**
     * Finds sessions matching what the user said: a session id, a herdr space id or label, or words from
     * the session title. Root sessions only, newest first, never the orchestrator.
     */
    const findSessions = async (query: string) => {
      const q = query.trim()
      if (/^ses_\w+$/.test(q)) return [q]
      const found = new Set<string>()
      if (mux && (await mux.available())) {
        const spaces = await mux.list().catch(() => [])
        const lower = q.toLowerCase()
        const hits = spaces.filter((s) => s.workspace_id.toLowerCase() === lower || s.label.toLowerCase().includes(lower))
        for (const space of hits) {
          for (const pane of await mux.panes(space.workspace_id).catch(() => [])) {
            const id = paneSession(pane)
            if (id) found.add(id)
          }
        }
      }
      const listed = await ctx.session.list({ search: q, parentID: null, order: "desc", limit: 10 }).catch(() => undefined)
      for (const session of listed?.data ?? []) if (!session.parentID) found.add(session.id)
      found.delete(orchestratorID ?? "")
      return [...found]
    }

    const attach = async (query: string, why: string | undefined) => {
      const matches = await findSessions(query)
      if (matches.length === 1) return adopt(matches[0], why)
      if (!matches.length) return `No session matches "${query}". Try its session id, herdr space (e.g. w4K) or title words.`
      const lines = await Promise.all(
        matches.map(async (id) => {
          const info = await ctx.session.get({ sessionID: id }).catch(() => undefined)
          return `- ${id} — ${info?.title ?? "?"} — ${info?.location.directory ?? "?"}${registry[id] && !isClosed(registry[id]) ? " (already tracked)" : ""}`
        }),
      )
      return `Several sessions match "${query}"; ask the user which one, then call attach_worker with its session id:\n${lines.join("\n")}`
    }

    await ctx.command.transform((editor) => {
      editor.add({ ...JOIN_COMMAND, execute: requestJoin(ctx) })
      editor.add({
        name: "attach",
        description: "Track an existing session as a worker: session id, herdr space (w4K) or title words",
        execute: ({ sessionID, prompt }) =>
          (async () => {
            const query = prompt?.text?.trim()
            const text = query
              ? await attach(query, undefined).catch((error: unknown) => `Could not attach "${query}": ${String(error).replace(/^Error: /, "")}`)
              : "Usage: /attach <session id | herdr space id or label | title words>"
            await ctx.session.synthetic({ sessionID, text, description: "Attach worker", resume: false })
          })(),
      })
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

    /** Removes what is left of a worker; failures (dirty worktree, unmerged branch) are reported, not forced. */
    const closeWorker = async (worker: Worker, input: Record<string, unknown>) => {
      const sessionID = worker.id
      const force = input.force === true
      const done: string[] = []
      const kept: string[] = []
      const attempt = async (label: string, task: () => Promise<unknown>) =>
        task().then(
          () => done.push(label),
          (error: unknown) => kept.push(`${label} failed: ${String(error).replace(/^Error: /, "")}`),
        )

      const spaces = mux ? await mux.spaces() : undefined
      const before = await presence(worker, spaces)
      const checkout = checkoutOf(worker)
      if (input.worktree !== false && before.worktree && checkout) {
        if (worker.space && before.space) {
          await attempt(`removed worktree and closed herdr space ${worker.space}`, () =>
            mux!.removeWorktree(worker.space!, force),
          )
        } else {
          await attempt("removed worktree", () => removeGitWorktree(worker.project!, checkout, force))
        }
      }
      if (worker.space && before.space && !done.some((d) => d.includes(worker.space!))) {
        await attempt(`closed herdr space ${worker.space}`, () => mux!.closeSpace(worker.space!))
      }
      if (input.branch === true && before.branch?.exists) {
        await attempt(`deleted branch ${worker.worktree}`, () => deleteBranch(worker.project!, worker.worktree!, force))
      }
      if (input.session === true && before.session) {
        await attempt("deleted session", () => ctx.session.remove({ sessionID }))
      }

      return enqueue(async () => {
        const after = await presence(worker, mux ? await mux.spaces() : undefined)
        const left = leftovers(worker, after)
        registry[sessionID] = {
          ...registry[sessionID],
          state: "closed",
          closedBy: registry[sessionID].closedBy ?? "orchestrator",
          detail: registry[sessionID].closedBy === "user" ? registry[sessionID].detail : "closed by orchestrator",
          leftovers: left,
          updated: Date.now(),
        }
        await save()
        await publish()
        const lines = [
          `${worker.title}: ${done.join(", ") || "nothing to remove"}.`,
          kept.length && `Not done: ${kept.join("; ")}. Pass force: true only if the user confirms discarding it.`,
          left.length && `Still left: ${left.join("; ")}.`,
        ]
        return { content: lines.filter(Boolean).join("\n") }
      })
    }

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

          // Checked before opening any space so a bad model doesn't leave an empty worktree behind.
          const { model, note } = await workerModel(context.sessionID, target)
          const useHerdr = !!mux && (await mux.available())
          let space: Opened | undefined
          let directory = target
          let checkout: string | undefined
          if (useHerdr && branch) {
            const parent = await mux!.repoSpace(root!).catch(() => undefined)
            space = await mux!.worktree({ root: root!, space: parent?.workspace_id, branch, base: base!, label: title })
            checkout = space.directory
            directory = path.join(space.directory, path.relative(root!, target))
          } else if (useHerdr) {
            space = await mux!.workspace({ cwd: target, label: title })
          }

          // Without herdr, fall back to an OpenCode-managed worktree for project workers.
          const headlessTree = !!branch && !space
          const session = await ctx.session.create({
            title,
            agent,
            model,
            location: { directory: headlessTree ? root! : directory },
            metadata: { orchestrator: orchestratorID ?? null },
          })
          if (headlessTree) {
            const created = await ctx.worktree.create({ projectID: session.projectID, name: slug(branch!), branch: base })
            checkout = created.directory
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
              checkout,
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
          return { content: `Spawned worker "${title}" as ${session.id}: ${where.join(", ")}.${note}${warning}` }
        },
      })
      editor.add({
        name: "list_workers",
        description: "Show every worker session and its current status.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: ID },
        execute: async () => {
          await sweep()
          return { content: board(registry) }
        },
      })
      editor.add({
        name: "close_worker",
        description:
          "Close a worker the user is finished with, or clean up what is left after they closed one by hand: removes its worktree (closing its herdr space) and optionally its branch and session. Only call when the user asks.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string" },
            worktree: { type: "boolean", description: "Remove the worktree checkout (default true)" },
            branch: { type: "boolean", description: "Also delete the local branch (default false)" },
            session: { type: "boolean", description: "Also delete the OpenCode session (default false)" },
            force: {
              type: "boolean",
              description: "Discard uncommitted changes and delete unmerged branches. Only when the user confirms",
            },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: ID },
        execute: async (raw) => {
          const input = raw as Record<string, unknown>
          const sessionID = str(input.sessionID, "sessionID")!
          const worker = registry[sessionID]
          if (!worker) throw new Error(`${sessionID} is not a tracked worker`)
          closing.add(sessionID)
          try {
            return await closeWorker(worker, input)
          } finally {
            closing.delete(sessionID)
          }
        },
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
        name: "attach_worker",
        description:
          "Start tracking a session the orchestrator did not spawn (status, alerts, close detection, sidebar). Only when the user asks. If several sessions match, ask the user which one.",
        input: {
          type: "object",
          properties: {
            session: {
              type: "string",
              description: "Session id, herdr space id or label (e.g. w4K), or words from the session title",
            },
            why: { type: "string", description: "What the user wants from this session, if they said. Pinned in its context" },
          },
          required: ["session"],
          additionalProperties: false,
        },
        options: { namespace: ID },
        execute: async (raw) => {
          const input = raw as Record<string, unknown>
          return { content: await attach(str(input.session, "session")!, str(input.why, "why", false)) }
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
        const types = [...EVENT_TYPES, "session.metadata.updated"] as const
        for await (const event of ctx.event.subscribe({ types: [...types], signal: controller.signal })) {
          if (event.type === "session.metadata.updated") {
            const data = event.data as { sessionID?: string; metadata?: Record<string, unknown> }
            const join = data.metadata?.[JOIN_KEY] as { why?: string | null } | null | undefined
            if (!data.sessionID || !join || typeof join !== "object") continue
            const sessionID = data.sessionID
            // Clear the request first so later metadata updates don't re-attach a worker the user forgot.
            await ctx.session
              .update({ sessionID, metadata: { ...data.metadata, [JOIN_KEY]: null } as never })
              .catch((error: unknown) => console.warn(`[${ID}]`, "failed to clear join request", error))
            void adopt(sessionID, join.why ?? undefined)
              .then((text) => tell(text, "Session joined", false))
              .catch((error: unknown) => console.warn(`[${ID}]`, `failed to attach ${sessionID}`, error))
            continue
          }
          if (event.type === "session.deleted") {
            const data = event.data as { sessionID?: string }
            if (data.sessionID && data.sessionID === orchestratorID) {
              const previous = data.sessionID
              void enqueue(async () => {
                if (orchestratorID === previous) await repin(previous)
              }).catch((error) => console.warn(`[${ID}]`, "failed to re-pin orchestrator", error))
            } else if (data.sessionID && registry[data.sessionID]) void sweep()
            continue
          }
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

    void sweep()
    const timer = options.sweepSeconds > 0 ? setInterval(() => void sweep(), options.sweepSeconds * 1000) : undefined

    return () => {
      controller.abort()
      if (timer) clearInterval(timer)
      void rpc.dispose()
    }
  },
})

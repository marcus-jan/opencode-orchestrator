import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  branchExists,
  branchOnOrigin,
  checkoutInfo,
  createWorktree,
  deleteBranch,
  herdr,
  isDirty,
  removeGitWorktree,
  resolveBase,
} from "./herdr"
import { findProjects, gitRoot, slug } from "./projects"
import { board, checkoutOf, migrate, type Registry, type Worker } from "./registry"

const ID = "orchestrator"
const ORCHESTRATOR_KEY = "orchestrator"
const WORKERS_KEY = "workers"
const BOARD_KEY = "orchestrator-workers"
const ORIGIN_KEY = "orchestrator-origin"
/** Batched worker updates from v0.2; deleted on load. */
const PENDING_KEY = "pending"

export interface Options {
  /** Directory the orchestrator lives in. Only the plugin instance for this location is active. */
  home: string
  /** Title applied to the pinned orchestrator session. */
  title: string
  /** Give workers spawned inside a git project their own worktree unless the call says otherwise. */
  worktree: boolean
  /** herdr desktop app CLI (`herdr-app`) used to open every worker in its own space, or false to keep workers headless. */
  herdr: string | false
  /** herdr-core CLI (`hc`), used to find the space a joining session runs in. */
  hc: string
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
  const bin = path.join(homedir(), ".local", "bin")
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
    worktree: pick("worktree", "boolean", true),
    herdr: (options.herdr as string | false | undefined) ?? path.join(bin, "herdr-app"),
    hc: pick("hc", "string", path.join(bin, "hc")),
  }
}

const notFound = (error: unknown) => {
  const e = error as { _tag?: string; message?: string } | undefined
  return /not ?found/i.test(`${e?._tag} ${e?.message} ${String(error)}`)
}

const NAMING = `orchestrator_worker_spawn: you pick a short "title" and, for repo work, a "branch" (feat/ fix/ chore/ docs/ hotfix/, Jira key uppercase, e.g. feat/ABC-123-short-name; base develop, master for hotfix/). No repo: omit "project". Always pass "why". Keep worker prompts and your replies brief.`

export interface Origin {
  orchestrator?: string
  why: string
  project?: string
  branch?: string
  base?: string
  directory: string
  space?: string
  spawned: string
  /** The session existed before and joined the orchestrator later. */
  joined?: boolean
}

/** Standing context pinned into a worker so it knows why it exists after its first prompt is compacted away. */
export function origin(o: Origin): string {
  const by = `the OpenCode orchestrator${o.orchestrator ? ` (${o.orchestrator})` : ""}`
  return [
    o.joined
      ? `This session joined ${by} on ${o.spawned}; it is now on its worker list.`
      : `You are a worker session started by ${by} on ${o.spawned}.`,
    `Why: ${o.why}`,
    o.project ? `Project: ${o.project}` : o.joined ? undefined : "Not tied to a repo: this is an idea space. Do not edit sibling repos; recommend a repo worker when code work is needed.",
    o.branch && `Branch: ${o.branch}${o.base ? ` off ${o.base}` : ""}`,
    `Working directory: ${o.directory}`,
    o.space && `Herdr space: ${o.space}`,
    "End your final message with one line: `Outcome: <what you did and what is left>`.",
  ]
    .filter(Boolean)
    .join("\n")
}

const str = (value: unknown, name: string, required = true) => {
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${name}" must be a non-empty string`)
  return value.trim()
}

/** Session metadata key /orchestrator-worker-join sets; the home instance sees it through the global event stream. */
export const JOIN_KEY = "orchestratorJoin"

const JOIN_COMMAND = {
  name: "orchestrator-worker-join",
  description: "Add this session to the orchestrator's worker list (optional: why)",
}

/** Works from any location: it only flags the session, so it doesn't need the home instance's state. */
const requestJoin = (ctx: Plugin.Context) => async ({ sessionID, prompt }: { sessionID: string; prompt?: { text?: string } }) => {
  const info = await ctx.session.get({ sessionID })
  const why = prompt?.text?.trim() || null
  await ctx.session.update({ sessionID, metadata: { ...(info.metadata ?? {}), [JOIN_KEY]: { why, at: Date.now() } } })
  await ctx.session.synthetic({
    sessionID,
    text: "Asked the orchestrator to add this session to its worker list.",
    resume: false,
  })
}

/** Session metadata key /orchestrator-worker-close sets; the home instance closes the worker when it sees it. */
export const CLOSE_KEY = "orchestratorClose"

const CLOSE_COMMAND = {
  name: "orchestrator-worker-close",
  description: "Close this worker: remove its worktree and herdr space (add: branch, session, force)",
}

const requestClose = (ctx: Plugin.Context) => async ({ sessionID, prompt }: { sessionID: string; prompt?: { text?: string } }) => {
  const info = await ctx.session.get({ sessionID })
  const words = new Set((prompt?.text ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean))
  const request = { branch: words.has("branch"), session: words.has("session"), force: words.has("force"), at: Date.now() }
  await ctx.session.update({ sessionID, metadata: { ...(info.metadata ?? {}), [CLOSE_KEY]: request } })
  const extras = [request.branch && "delete its branch", request.session && "delete this session", request.force && "discard uncommitted changes"]
  await ctx.session.synthetic({
    sessionID,
    text: `Asked the orchestrator to close this worker: remove its worktree and herdr space${extras.some(Boolean) ? `, ${extras.filter(Boolean).join(", ")}` : ""}. This space closes when it's done.`,
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
      await ctx.command.transform((editor) => {
        editor.add({ ...JOIN_COMMAND, execute: requestJoin(ctx) })
        editor.add({ ...CLOSE_COMMAND, execute: requestClose(ctx) })
      })
      return
    }

    const controller = new AbortController()
    let registry: Registry = migrate(await ctx.storage.get(WORKERS_KEY))
    let orchestratorID = (await ctx.storage.get(ORCHESTRATOR_KEY)) as string | undefined
    await ctx.storage.set(WORKERS_KEY, registry as never)
    await ctx.storage.remove(PENDING_KEY).catch(() => ctx.storage.set(PENDING_KEY, {}))

    let chain = Promise.resolve()
    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
      const run = chain.then(task, task)
      chain = run.then(() => undefined, () => undefined)
      return run
    }

    const save = () => ctx.storage.set(WORKERS_KEY, registry as never)

    const published = new Map<string, string>()
    const publish = async () => {
      if (!orchestratorID) return
      const projects = await findProjects(options.home)
      const value = [
        `Git projects under ${options.home} (orchestrator_worker_spawn "project"): ${projects.join(", ") || "none"}`,
        `Workers in a project get their own worktree by default: ${options.worktree ? "yes" : "no"}`,
        NAMING,
        `Workers:\n${board(registry)}`,
      ].join("\n\n")
      // Every change re-sends the whole block to the model, so skip identical boards.
      if (value === published.get(orchestratorID)) return
      published.set(orchestratorID, value)
      await ctx.session.instructions.entry
        .put({ sessionID: orchestratorID, key: BOARD_KEY, value })
        .catch((error: unknown) => console.warn(`[${ID}]`, "failed to publish board", error))
    }

    /**
     * Pins a replacement after the orchestrator session disappears: the most recently used other root
     * session in home that is not a worker, else a new one.
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
      await pin(sessionID)
      if (previous) {
        console.warn(`[${ID}]`, `orchestrator ${previous} is gone; pinned ${sessionID}`)
        await ctx.session
          .synthetic({
            sessionID,
            text: `The previous orchestrator session (${previous}) was deleted, so this session is now the orchestrator.\n\nSend captures here with: scrawl send <bundle> --session ${sessionID}`,
            description: "Orchestrator re-pinned",
            delivery: "queue",
            resume: false,
          })
          .catch((error: unknown) => console.warn(`[${ID}]`, "failed to post re-pin note", error))
      }
      return sessionID
    }

    const mux = options.herdr ? herdr(options.herdr, options.hc) : undefined

    /**
     * Space ids from the herdr CLI (w53…) mean nothing to the desktop app: find each worker's app space by
     * folder (its worktree; idea spaces also by name, since the orchestrator's own space shares their
     * folder) or forget the space. Waits for a run where the app is up.
     */
    const migrateSpaces = async () => {
      const stale = Object.values(registry).filter((worker) => worker.space && !worker.space.startsWith("sp"))
      if (!stale.length || !mux) return
      const spaces = await mux.list().catch(() => undefined)
      if (!spaces) return
      const claimed = new Set(Object.values(registry).map((worker) => worker.space))
      for (const worker of stale) {
        const tree = checkoutOf(worker)
        const match = spaces.find(
          (space) =>
            !claimed.has(space.id) &&
            !!space.folder &&
            (tree
              ? path.resolve(space.folder) === path.resolve(tree)
              : !worker.project && path.resolve(space.folder) === path.resolve(worker.directory) && space.name === worker.title),
        )
        const { space: _old, ...rest } = worker
        registry[worker.id] = match ? { ...rest, space: match.id } : rest
        if (match) claimed.add(match.id)
      }
      await save()
    }

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
     * Adds a session that joined from inside itself. Repo, branch and worktree come from its folder and
     * the herdr space from the terminal running it (via hc); nothing new is created.
     */
    const adopt = async (sessionID: string, why: string | undefined) => {
      if (sessionID === orchestratorID) throw new Error("that is the orchestrator session itself")
      const info = await ctx.session.get({ sessionID })
      if (info.parentID) throw new Error(`${sessionID} is a subagent session`)
      if (registry[sessionID]) return

      const directory = info.location.directory
      const git = await checkoutInfo(directory)
      const linked = git?.linked && git.branch ? git : undefined
      // A session in a repo's main checkout shares the repo's own space; closing the worker must never close that.
      const space = (linked || !git) && mux ? await mux.findSession(sessionID).catch(() => undefined) : undefined
      const title = info.title || sessionID
      const reason = why ?? `Joined by the user; continue what "${title}" was doing.`

      await enqueue(async () => {
        registry[sessionID] = {
          id: sessionID,
          title,
          directory,
          project: git?.root,
          worktree: linked?.branch,
          checkout: linked?.checkout,
          space,
          why: reason,
          created: Date.now(),
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
          joined: true,
        }),
      })
    }

    await ctx.command.transform((editor) => {
      editor.add({ ...JOIN_COMMAND, execute: requestJoin(ctx) })
      editor.add({ ...CLOSE_COMMAND, execute: requestClose(ctx) })
      editor.add({
        name: "orchestrator-pin",
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

    // Workers being closed, so a second close request doesn't race the first.
    const closing = new Set<string>()

    /**
     * Removes a worker's worktree and herdr space (and optionally branch and session), then drops it from
     * the list. Refuses a dirty worktree unless forced; any failure keeps the worker on the list.
     */
    const closeWorker = async (worker: Worker, input: Record<string, unknown>) => {
      const sessionID = worker.id
      const force = input.force === true
      const checkout = checkoutOf(worker)
      const tree = input.worktree !== false && !!checkout && existsSync(checkout)
      if (tree && !force && (await isDirty(checkout!))) {
        return { content: `${worker.title}: not closed; ${checkout} has uncommitted changes.`, failed: true }
      }

      const done: string[] = []
      const kept: string[] = []
      const attempt = async (label: string, task: () => Promise<unknown>) =>
        task().then(
          () => done.push(label),
          (error: unknown) => kept.push(`${label} failed: ${String(error).replace(/^Error: /, "")}`),
        )

      const spaces = mux ? await mux.spaces() : undefined
      const space = !!worker.space && !!spaces?.has(worker.space)
      // Close the space first so its shell isn't left sitting in a deleted folder; a space that won't
      // close keeps its worktree too.
      if (space) await attempt(`closed herdr space ${worker.space}`, () => mux!.closeSpace(worker.space!))
      if (tree && !kept.length) await attempt("removed worktree", () => removeGitWorktree(worker.project!, checkout!, force))
      const branch = !!worker.project && !!worker.worktree && (await branchExists(worker.project, worker.worktree))
      if (input.branch === true && branch) {
        await attempt(`deleted branch ${worker.worktree}`, () => deleteBranch(worker.project!, worker.worktree!, force))
      }
      if (input.session === true) {
        await attempt("deleted session", () =>
          ctx.session.remove({ sessionID }).catch((error: unknown) => {
            if (!notFound(error)) throw error
          }),
        )
      }

      const left = [
        checkout && existsSync(checkout) && `worktree ${checkout}`,
        worker.project && worker.worktree && (await branchExists(worker.project, worker.worktree)) &&
          `branch ${worker.worktree} (${(await branchOnOrigin(worker.project, worker.worktree)) ? "pushed to origin" : "not on origin"})`,
      ].filter((part): part is string => !!part)

      return enqueue(async () => {
        if (!kept.length) delete registry[sessionID]
        await save()
        await publish()
        const lines = [
          `${worker.title}: ${done.join(", ") || "nothing to remove"}.`,
          kept.length ? `Not done: ${kept.join("; ")}. Still on the list.` : "Removed from the list.",
          left.length && `Left: ${left.join("; ")}.`,
        ]
        return { content: lines.filter(Boolean).join("\n"), failed: kept.length > 0 }
      })
    }

    /** /orchestrator-worker-close from inside a worker; the worker only hears back if something was not done. */
    const closeFromWorker = async (sessionID: string, request: Record<string, unknown>) => {
      const worker = registry[sessionID]
      const reply = (text: string) =>
        ctx.session.synthetic({ sessionID, text, description: "Close worker", resume: false }).catch(() => undefined)
      if (!worker) {
        return void (await reply("This session is not on the orchestrator's worker list. Run /orchestrator-worker-join first, or close it by hand."))
      }
      if (closing.has(sessionID)) return
      closing.add(sessionID)
      try {
        const result = await closeWorker(worker, request)
        if (result.failed) {
          await reply(
            `${result.content}\nCommit or stash your changes and run /orchestrator-worker-close again, or run /orchestrator-worker-close force to discard them.`,
          )
        }
      } finally {
        closing.delete(sessionID)
      }
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: ID, description: "Spawn and manage worker OpenCode sessions" })
      editor.add({
        name: "orchestrator_projects",
        description: `List the git projects (folders under ${options.home}) that workers can be spawned in.`,
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: ID },
        execute: async () => {
          const projects = await findProjects(options.home)
          return { content: projects.length ? projects.map((name) => `- ${name}`).join("\n") : "No git projects found." }
        },
      })
      editor.add({
        name: "orchestrator_worker_spawn",
        description:
          "Start a new OpenCode worker for an idea. Inside a project it gets a branch (new off origin, or an existing local one) + worktree opened as its own herdr space (shown under its repo); otherwise a new herdr space in the orchestrator's folder. Opens in the background and appears on your worker list.",
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short friendly name: herdr space label and session title" },
            prompt: { type: "string", description: "Full task for the worker; it has no other context" },
            project: {
              type: "string",
              description: `Project folder under ${options.home} (see orchestrator_projects), e.g. "my-app". Omit for ideas not tied to a repo`,
            },
            directory: {
              type: "string",
              description: "Subdirectory inside the project (or relative to the orchestrator home when no project)",
            },
            branch: {
              type: "string",
              description:
                "Branch name following the repo convention, e.g. feat/ABC-123-short-description; an existing local branch is checked out as is",
            },
            base: {
              type: "string",
              description: "Branch to start a new branch from, always origin/<base> after a fetch (default develop, or master for hotfix/ branches)",
            },
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

          // Checked before creating anything so a bad model doesn't leave an empty worktree behind.
          const { model, note } = await workerModel(context.sessionID, target)
          const useHerdr = !!mux && (await mux.available())

          let branch: string | undefined
          let base: string | undefined
          let existing = false
          if (wantTree) {
            branch = str(input.branch, "branch", false) ?? `feat/${slug(title)}`
            existing = await branchExists(root!, branch)
            if (existing && !useHerdr) throw new Error(`branch "${branch}" already exists in ${root}`)
            const explicit = str(input.base, "base", false)
            const candidates = explicit ? [explicit] : branch.startsWith("hotfix/") ? ["master", "main"] : ["develop", "master", "main"]
            if (!existing) base = await resolveBase(root!, candidates, !!explicit)
          }

          let directory = target
          let checkout: string | undefined
          if (useHerdr && branch) {
            checkout = await createWorktree(root!, branch, base)
            directory = path.join(checkout, path.relative(root!, target))
          }

          // Without herdr, fall back to an OpenCode-managed worktree for project workers.
          const headlessTree = !!branch && !useHerdr
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

          let space: string | undefined
          let warning = ""
          if (useHerdr) {
            // Named after the title; the sidebar still nests a worktree space under its repo's space.
            space = await mux!
              .openSpace({ folder: checkout ?? directory, name: title, argv: ["opencode", "--session", session.id] })
              .catch((error: unknown) => void (warning = ` Could not open a herdr space: ${String(error).replace(/^Error: /, "")}`))
          }

          await enqueue(async () => {
            registry[session.id] = {
              id: session.id,
              title,
              directory,
              project: root,
              worktree: branch,
              checkout,
              space,
              why,
              created: Date.now(),
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
              space,
              spawned: new Date().toISOString(),
            }),
          })

          await ctx.session.prompt({ sessionID: session.id, text: prompt })
          await enqueue(publish)

          const where = [
            branch && (existing ? `existing branch ${branch}` : `branch ${branch} off ${base}`),
            directory,
            space ? `herdr space ${space}` : !options.herdr || warning ? undefined : "headless (herdr unavailable)",
          ].filter(Boolean)
          return { content: `Spawned worker "${title}" as ${session.id}: ${where.join(", ")}.${note}${warning}` }
        },
      })
      editor.add({
        name: "orchestrator_worker_list",
        description: "Show every worker on the list.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: ID },
        execute: async () => ({ content: board(registry) }),
      })
      editor.add({
        name: "orchestrator_worker_close",
        description:
          "Close a worker the user is finished with: closes its herdr space, removes its worktree and optionally its branch and session, then drops it from the list. The result says what is left (e.g. whether the branch is pushed) so you can ask the user. Only call when the user asks.",
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
          if (!worker) throw new Error(`${sessionID} is not on the worker list`)
          if (closing.has(sessionID)) return { content: `${worker.title} is already being closed.` }
          closing.add(sessionID)
          try {
            const result = await closeWorker(worker, input)
            const hint = result.failed ? "\nPass force: true only if the user confirms discarding it." : ""
            return { content: `${result.content}${hint}` }
          } finally {
            closing.delete(sessionID)
          }
        },
      })
      editor.add({
        name: "orchestrator_worker_message",
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
          if (!registry[sessionID]) throw new Error(`${sessionID} is not on the worker list`)
          await ctx.session.prompt({
            sessionID,
            text: str(input.text, "text")!,
            delivery: input.steer === true ? "steer" : "queue",
          })
          return { content: `Sent to ${registry[sessionID].title}.` }
        },
      })
      editor.add({
        name: "orchestrator_worker_forget",
        description: "Drop a worker from the list without closing anything (does not delete its session).",
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
            const existed = sessionID in registry
            delete registry[sessionID]
            await save()
            await publish()
            return { content: existed ? `Forgot ${sessionID}.` : `${sessionID} was not on the list.` }
          })
        },
      })
    })

    void (async () => {
      try {
        const types = ["session.metadata.updated", "session.deleted"] as const
        for await (const event of ctx.event.subscribe({ types: [...types], signal: controller.signal })) {
          if (event.type === "session.deleted") {
            const data = event.data as { sessionID?: string }
            if (data.sessionID && data.sessionID === orchestratorID) {
              const previous = data.sessionID
              void enqueue(async () => {
                if (orchestratorID === previous) await repin(previous)
              }).catch((error) => console.warn(`[${ID}]`, "failed to re-pin orchestrator", error))
            }
            continue
          }
          if (event.type !== "session.metadata.updated") continue
          const data = event.data as { sessionID?: string; metadata?: Record<string, unknown> }
          const join = data.metadata?.[JOIN_KEY] as { why?: string | null } | null | undefined
          const close = data.metadata?.[CLOSE_KEY] as Record<string, unknown> | null | undefined
          if (data.sessionID && close && typeof close === "object") {
            const sessionID = data.sessionID
            await ctx.session
              .update({ sessionID, metadata: { ...data.metadata, [CLOSE_KEY]: null } as never })
              .catch((error: unknown) => console.warn(`[${ID}]`, "failed to clear close request", error))
            void closeFromWorker(sessionID, close).catch((error: unknown) =>
              console.warn(`[${ID}]`, `failed to close ${sessionID}`, error),
            )
            continue
          }
          if (!data.sessionID || !join || typeof join !== "object") continue
          const sessionID = data.sessionID
          // Clear the request first so later metadata updates don't re-add a worker the user forgot.
          await ctx.session
            .update({ sessionID, metadata: { ...data.metadata, [JOIN_KEY]: null } as never })
            .catch((error: unknown) => console.warn(`[${ID}]`, "failed to clear join request", error))
          void adopt(sessionID, join.why ?? undefined).catch((error: unknown) =>
            console.warn(`[${ID}]`, `failed to add ${sessionID}`, error),
          )
        }
      } catch (error) {
        if (!controller.signal.aborted) console.warn(`[${ID}]`, "event stream stopped", error)
      }
    })()

    void enqueue(async () => {
      await migrateSpaces().catch((error: unknown) => console.warn(`[${ID}]`, "failed to migrate herdr spaces", error))
      await ensureOrchestrator()
    }).catch((error) => console.warn(`[${ID}]`, "failed to start orchestrator session", error))

    return () => controller.abort()
  },
})

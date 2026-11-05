export type WorkerState = "queued" | "running" | "blocked" | "done" | "failed" | "interrupted" | "closed" | "gone"

export interface Worker {
  id: string
  title: string
  directory: string
  /** Git project root the worker belongs to, when it was spawned inside one. */
  project?: string
  /** Branch name, when the worker was given its own worktree. */
  worktree?: string
  /** Root of the worker's worktree checkout (directory may be a subfolder of it). */
  checkout?: string
  /** Who closed the worker: the user by hand, or the orchestrator via close_worker. */
  closedBy?: "user" | "orchestrator"
  /** Parts still around after a close (worktree, branch, herdr space). */
  leftovers?: string[]
  /** Herdr workspace ID the worker's TUI was opened in. */
  space?: string
  /** Why the orchestrator started this worker. */
  why?: string
  /** Started outside the orchestrator and attached later. */
  attached?: boolean
  /** The orchestrator started the current turn, so its end is worth an alert. */
  asked?: boolean
  state: WorkerState
  detail?: string
  created: number
  updated: number
}

export type Registry = Record<string, Worker>

export interface Transition {
  sessionID: string
  state: WorkerState
  detail?: string
  unblock?: boolean
}

// States that always need the user's attention. "done" only alerts for turns the orchestrator started.
export const ATTENTION_STATES: ReadonlySet<WorkerState> = new Set(["failed", "blocked"])

type AnyEvent = { type: string; data?: any }

export function transitionFor(event: AnyEvent): Transition | undefined {
  const data = event.data ?? {}
  switch (event.type) {
    case "session.execution.started":
      return { sessionID: data.sessionID, state: "running" }
    // execution.succeeded fires for every run inside a turn; the turn only ends when the session goes idle.
    case "session.idle":
      return { sessionID: data.sessionID, state: "done" }
    case "session.execution.failed":
      return { sessionID: data.sessionID, state: "failed", detail: data.error?.message }
    case "session.execution.interrupted":
      return { sessionID: data.sessionID, state: "interrupted", detail: data.reason }
    case "permission.asked":
      return { sessionID: data.sessionID, state: "blocked", detail: `permission: ${data.action}` }
    case "permission.replied":
      return { sessionID: data.sessionID, state: "running", unblock: true }
    case "form.created":
      return { sessionID: data.form?.sessionID, state: "blocked", detail: `question: ${data.form?.title}` }
    case "form.replied":
    case "form.cancelled":
      return { sessionID: data.sessionID, state: "running", unblock: true }
  }
  return undefined
}

export const isClosed = (worker: Worker) => worker.state === "closed" || worker.state === "gone"

/** Worktree root for a worker; older entries only recorded the directory. */
export const checkoutOf = (worker: Worker) => worker.checkout ?? (worker.worktree ? worker.directory : undefined)

/** What still exists for a worker. `space` is undefined when unknown (herdr unreachable) or not used. */
export interface Presence {
  session: boolean
  space?: boolean
  worktree?: boolean
  branch?: { exists: boolean; pushed: boolean }
}

/** Anything the user would want cleaned up. A lingering session doesn't count: it costs nothing. */
export function leftovers(worker: Worker, p: Presence) {
  return [
    worker.space && p.space && `herdr space ${worker.space}`,
    p.worktree && `worktree ${checkoutOf(worker)}`,
    p.branch?.exists && `branch ${worker.worktree} (${p.branch.pushed ? "pushed to origin" : "not on origin"})`,
  ].filter((part): part is string => !!part)
}

/** Detects a worker closed outside the orchestrator: any of its space, worktree or session is gone. */
export function closure(worker: Worker, p: Presence) {
  const missing = [
    worker.space && p.space === false && `herdr space ${worker.space} closed`,
    checkoutOf(worker) && p.worktree === false && "worktree removed",
    !p.session && "session deleted",
  ].filter((part): part is string => !!part)
  if (!missing.length) return undefined
  return { detail: `closed manually: ${missing.join(", ")}`, leftovers: leftovers(worker, p) }
}

export const EVENT_TYPES = [
  "session.execution.started",
  "session.idle",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
  "session.deleted",
] as const

/** Applies a transition. Returns the updated worker, or undefined when nothing changed. */
export function apply(registry: Registry, t: Transition, now = Date.now()): Worker | undefined {
  const worker = registry[t.sessionID]
  if (!worker || isClosed(worker)) return undefined
  if (worker.state === t.state && worker.detail === t.detail) return undefined
  // A late permission/form reply must not resurrect a worker that already finished.
  if (t.unblock && worker.state !== "blocked") return undefined
  const next: Worker = { ...worker, state: t.state, detail: t.detail, updated: now }
  registry[t.sessionID] = next
  return next
}

/** Compact board for the orchestrator's context: open workers only, no paths or ages. */
export function board(registry: Registry) {
  const workers = Object.values(registry).sort((a, b) => a.created - b.created)
  const open = workers.filter((w) => !isClosed(w))
  const lines = open.map((w) => {
    const detail = w.detail ? ` (${w.detail})` : ""
    const space = w.space ? ` ${w.space}` : ""
    return `- ${w.state}: ${w.title} ${w.id}${space}${detail}`
  })
  const closed = workers.length - open.length
  const left = workers.filter((w) => isClosed(w) && w.leftovers?.length).map((w) => `- closed, left ${w.leftovers!.join(", ")}: ${w.title} ${w.id}`)
  if (!lines.length && !left.length) return closed ? `No open workers (${closed} closed).` : "No workers yet."
  return [...lines, ...left, ...(closed > left.length ? [`(${closed - left.length} more closed)`] : [])].join("\n")
}

export function formatAge(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

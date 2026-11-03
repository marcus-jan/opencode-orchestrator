export type WorkerState = "queued" | "running" | "blocked" | "done" | "failed" | "interrupted" | "gone"

export interface Worker {
  id: string
  title: string
  directory: string
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

// States worth interrupting the orchestrator for. Everything else only updates the board.
export const NOTIFY_STATES: ReadonlySet<WorkerState> = new Set(["done", "failed", "blocked"])

type AnyEvent = { type: string; data?: any }

export function transitionFor(event: AnyEvent): Transition | undefined {
  const data = event.data ?? {}
  switch (event.type) {
    case "session.execution.started":
      return { sessionID: data.sessionID, state: "running" }
    case "session.execution.succeeded":
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
    case "session.deleted":
      return { sessionID: data.sessionID, state: "gone" }
  }
  return undefined
}

export const EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
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
  if (!worker) return undefined
  if (worker.state === t.state && worker.detail === t.detail) return undefined
  // A late permission/form reply must not resurrect a worker that already finished.
  if (t.unblock && worker.state !== "blocked") return undefined
  const next: Worker = { ...worker, state: t.state, detail: t.detail, updated: now }
  registry[t.sessionID] = next
  return next
}

export function board(registry: Registry, now = Date.now()) {
  const workers = Object.values(registry).sort((a, b) => a.created - b.created)
  if (workers.length === 0) return "No workers yet."
  return workers
    .map((w) => {
      const age = formatAge(now - w.updated)
      const detail = w.detail ? ` (${w.detail})` : ""
      return `- [${w.state}] ${w.title} — ${w.id} — ${w.directory} — ${age} ago${detail}`
    })
    .join("\n")
}

export function formatAge(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

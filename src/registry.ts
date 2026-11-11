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
  /** herdr app space id (sp…) the worker's TUI was opened in. */
  space?: string
  /** Why the orchestrator started this worker. */
  why?: string
  created: number
}

export type Registry = Record<string, Worker>

/** Worktree root for a worker; older entries only recorded the directory. */
export const checkoutOf = (worker: Worker) => worker.checkout ?? (worker.worktree ? worker.directory : undefined)

const KEPT = ["id", "title", "directory", "project", "worktree", "checkout", "space", "why", "created"] as const

/** Upgrades a v0.2 registry: drops closed workers and every status field. */
export function migrate(stored: unknown): Registry {
  const registry: Registry = {}
  for (const [id, raw] of Object.entries((stored ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!raw || typeof raw !== "object" || raw.state === "closed" || raw.state === "gone") continue
    const worker: Record<string, unknown> = {}
    for (const key of KEPT) if (raw[key] !== undefined) worker[key] = raw[key]
    registry[id] = worker as unknown as Worker
  }
  return registry
}

/** Compact list for the orchestrator's context: one line per worker, no paths. */
export function board(registry: Registry) {
  const workers = Object.values(registry).sort((a, b) => a.created - b.created)
  if (!workers.length) return "No workers yet."
  return workers.map((w) => ["-", w.title, w.id, w.space, w.worktree].filter(Boolean).join(" ")).join("\n")
}

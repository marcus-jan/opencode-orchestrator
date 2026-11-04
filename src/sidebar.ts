import { formatAge, type WorkerState } from "./registry"
import type { Snapshot } from "./rpc"

export type Tone = "info" | "warning" | "success" | "error" | "muted"

export interface Row {
  id: string
  title: string
  marker: string
  tone: Tone
  meta: string
}

export interface View {
  heading: string
  rows: Row[]
  closed: number
}

const LOOK: Record<WorkerState, { marker: string; tone: Tone; rank: number }> = {
  blocked: { marker: "!", tone: "warning", rank: 0 },
  failed: { marker: "✗", tone: "error", rank: 1 },
  running: { marker: "●", tone: "info", rank: 2 },
  queued: { marker: "○", tone: "info", rank: 3 },
  done: { marker: "✓", tone: "success", rank: 4 },
  interrupted: { marker: "◌", tone: "muted", rank: 5 },
  closed: { marker: "·", tone: "muted", rank: 6 },
  gone: { marker: "·", tone: "muted", rank: 6 },
}

const isOpen = (state: WorkerState) => state !== "closed" && state !== "gone"

export interface Membership {
  heading: string
  marker: string
  tone: Tone
  meta: string
}

/** The note shown in a worker's own sidebar: it is joined to the orchestrator and how it is tracked. */
export function membership(snapshot: Snapshot, sessionID: string, now = Date.now()): Membership | undefined {
  const worker = snapshot.workers.find((w) => w.id === sessionID)
  if (!worker || !isOpen(worker.state) || !snapshot.orchestrator) return undefined
  return {
    heading: worker.attached ? "Orchestrator · joined" : "Orchestrator · worker",
    marker: LOOK[worker.state].marker,
    tone: LOOK[worker.state].tone,
    meta: [worker.detail ? `${worker.state}: ${worker.detail}` : worker.state, worker.space, `${formatAge(now - worker.updated)} ago`]
      .filter(Boolean)
      .join(" · "),
  }
}

/** Open workers sorted by what needs attention first; closed ones are only counted. */
export function view(snapshot: Snapshot, now = Date.now()): View {
  const open = snapshot.workers.filter((w) => isOpen(w.state))
  const rows = open
    .toSorted((a, b) => LOOK[a.state].rank - LOOK[b.state].rank || b.updated - a.updated)
    .map((w) => ({
      id: w.id,
      title: w.title,
      marker: LOOK[w.state].marker,
      tone: LOOK[w.state].tone,
      meta: [w.detail ? `${w.state}: ${w.detail}` : w.state, w.space, `${formatAge(now - w.updated)} ago`]
        .filter(Boolean)
        .join(" · "),
    }))
  const counts = new Map<WorkerState, number>()
  for (const w of open) counts.set(w.state, (counts.get(w.state) ?? 0) + 1)
  const summary = [...counts]
    .toSorted(([a], [b]) => LOOK[a].rank - LOOK[b].rank)
    .map(([state, n]) => `${n} ${state}`)
    .join(" · ")
  return {
    heading: summary ? `Workers · ${summary}` : "Workers · none open",
    rows,
    closed: snapshot.workers.length - open.length,
  }
}

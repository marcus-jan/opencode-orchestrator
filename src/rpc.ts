import { Rpc } from "@opencode/plugin/rpc"
import type { WorkerState } from "./registry"

/** What the sidebar needs to draw the worker list. */
export interface Snapshot {
  orchestrator?: string
  workers: { id: string; title: string; state: WorkerState; detail?: string; space?: string; updated: number }[]
}

export const Orchestrator = Rpc.define({
  id: "orchestrator",
  methods: {
    snapshot: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object" },
    },
  },
  events: {
    changed: { schema: { type: "object", additionalProperties: false } },
  },
})

import { describe, expect, test } from "bun:test"
import { apply, board, transitionFor, type Registry } from "../src/registry"

const worker = (state: Registry[string]["state"] = "queued"): Registry => ({
  ses_a: { id: "ses_a", title: "Fix login", directory: "/repo", state, created: 0, updated: 0 },
})

describe("transitionFor", () => {
  test("maps execution lifecycle", () => {
    expect(transitionFor({ type: "session.execution.started", data: { sessionID: "s" } })?.state).toBe("running")
    expect(transitionFor({ type: "session.execution.succeeded", data: { sessionID: "s" } })?.state).toBe("done")
    expect(transitionFor({ type: "session.execution.failed", data: { sessionID: "s", error: { message: "boom" } } })).toEqual({
      sessionID: "s",
      state: "failed",
      detail: "boom",
    })
  })

  test("maps permission and form prompts to blocked", () => {
    expect(transitionFor({ type: "permission.asked", data: { sessionID: "s", action: "bash" } })?.state).toBe("blocked")
    expect(transitionFor({ type: "form.created", data: { form: { sessionID: "s", title: "Which DB?" } } })).toEqual({
      sessionID: "s",
      state: "blocked",
      detail: "question: Which DB?",
    })
  })

  test("ignores unrelated events", () => {
    expect(transitionFor({ type: "session.renamed", data: { sessionID: "s" } })).toBeUndefined()
  })
})

describe("apply", () => {
  test("ignores untracked sessions", () => {
    expect(apply(worker(), { sessionID: "other", state: "running" })).toBeUndefined()
  })

  test("updates tracked workers", () => {
    const registry = worker()
    expect(apply(registry, { sessionID: "ses_a", state: "running" }, 5)?.state).toBe("running")
    expect(registry.ses_a.updated).toBe(5)
  })

  test("skips no-op transitions", () => {
    expect(apply(worker("running"), { sessionID: "ses_a", state: "running" })).toBeUndefined()
  })

  test("unblock only applies to blocked workers", () => {
    expect(apply(worker("done"), { sessionID: "ses_a", state: "running", unblock: true })).toBeUndefined()
    expect(apply(worker("blocked"), { sessionID: "ses_a", state: "running", unblock: true })?.state).toBe("running")
  })
})

test("board renders workers", () => {
  expect(board({})).toBe("No workers yet.")
  expect(board(worker("blocked"), 90_000)).toBe("- [blocked] Fix login — ses_a — /repo — 2m ago")
})

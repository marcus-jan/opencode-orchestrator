import { expect, test } from "bun:test"
import { board, migrate, type Registry } from "../src/registry"

test("board renders one line per worker, oldest first", () => {
  expect(board({})).toBe("No workers yet.")
  const registry: Registry = {
    ses_b: { id: "ses_b", title: "Idea", directory: "/home", space: "w2", created: 2 },
    ses_a: { id: "ses_a", title: "Fix login", directory: "/repo", space: "w1", worktree: "fix/login", created: 1 },
    ses_c: { id: "ses_c", title: "Headless", directory: "/repo", created: 3 },
  }
  expect(board(registry)).toBe("- Fix login ses_a w1 fix/login\n- Idea ses_b w2\n- Headless ses_c")
})

test("migrate drops closed workers and status fields", () => {
  const stored = {
    ses_a: {
      id: "ses_a",
      title: "Fix login",
      directory: "/repo/tree",
      project: "/repo",
      worktree: "fix/login",
      checkout: "/repo/tree",
      space: "w1",
      why: "capture",
      state: "running",
      detail: "x",
      asked: true,
      attached: true,
      created: 1,
      updated: 5,
    },
    ses_b: { id: "ses_b", title: "Old", directory: "/home", state: "closed", closedBy: "user", leftovers: ["branch x"], created: 2, updated: 3 },
    ses_c: { id: "ses_c", title: "Gone", directory: "/home", state: "gone", created: 2, updated: 3 },
    ses_d: { id: "ses_d", title: "Blocked", directory: "/home", state: "blocked", detail: "permission: bash", created: 4, updated: 4 },
  }
  expect(migrate(stored)).toEqual({
    ses_a: {
      id: "ses_a",
      title: "Fix login",
      directory: "/repo/tree",
      project: "/repo",
      worktree: "fix/login",
      checkout: "/repo/tree",
      space: "w1",
      why: "capture",
      created: 1,
    },
    ses_d: { id: "ses_d", title: "Blocked", directory: "/home", created: 4 },
  })
  expect(migrate(undefined)).toEqual({})
})

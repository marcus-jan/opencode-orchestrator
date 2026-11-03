import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin, { parseOptions } from "../src/index"

const home = mkdtempSync(path.join(tmpdir(), "orchestrator-"))
mkdirSync(path.join(home, "web", ".git"), { recursive: true })
mkdirSync(path.join(home, "web", "packages", "ui"), { recursive: true })
mkdirSync(path.join(home, "api", ".git"), { recursive: true })
mkdirSync(path.join(home, "notes"), { recursive: true })
afterAll(() => rmSync(home, { recursive: true, force: true }))

function fakeContext(directory: string, options: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>()
  const tools = new Map<string, any>()
  const calls: { method: string; input: any }[] = []
  let next = 0
  let push: ((event: unknown) => void) | undefined
  const queue: unknown[] = []
  const record = (method: string, result: (input: any) => unknown = () => ({})) => async (input: any) => {
    calls.push({ method, input })
    return result(input)
  }
  const ctx = {
    options,
    location: { directory },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
    session: {
      create: record("create", () => ({ id: `ses_${++next}`, projectID: "prj_1" })),
      get: record("get"),
      update: record("update"),
      move: record("move"),
      prompt: record("prompt"),
      synthetic: record("synthetic"),
      instructions: { entry: { put: record("board") } },
    },
    worktree: {
      create: record("worktree", (input) => ({ directory: path.join(home, ".worktrees", input.name) })),
    },
    command: { transform: async () => {} },
    tool: {
      transform: async (fn: (editor: any) => void) =>
        fn({ namespace: () => {}, add: (tool: any) => tools.set(tool.name, tool) }),
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (queue.length) yield queue.shift()
            else await new Promise<void>((resolve) => (push = (e) => (queue.push(e), resolve())))
          }
        },
      }),
    },
  }
  return { ctx, tools, calls, store, emit: (event: unknown) => (push ? push(event) : queue.push(event)) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

async function started(options: Record<string, unknown> = {}) {
  const fake = fakeContext(home, options)
  const cleanup = await plugin.setup(fake.ctx as never)
  await settle()
  return { ...fake, cleanup: async () => void (cleanup && (await cleanup())) }
}

test("parseOptions resolves defaults and validates types", () => {
  expect(parseOptions(undefined, "/home")).toEqual({ home: "/home", title: "Orchestrator", notify: true, worktree: true })
  expect(() => parseOptions({ notify: "yes" }, "/home")).toThrow('option "notify" must be a boolean')
})

test("stays inactive outside its home directory", async () => {
  const { ctx, tools, calls } = fakeContext("/elsewhere", { home })
  await plugin.setup(ctx as never)
  expect(tools.size).toBe(0)
  expect(calls).toEqual([])
})

test("lists git projects and tells the orchestrator about them", async () => {
  const { tools, calls, cleanup } = await started()
  expect((await tools.get("list_projects").execute({})).content).toBe("- api\n- web")
  expect(calls.find((c) => c.method === "board")?.input.value).toContain("api, web")
  await cleanup()
})

test("spawns workers in a fresh worktree of a project", async () => {
  const { tools, calls, emit, cleanup } = await started()
  expect(calls.find((c) => c.method === "create")?.input.title).toBe("Orchestrator")

  const result = await tools
    .get("spawn_worker")
    .execute({ title: "Fix Login!", prompt: "do it", project: "web", directory: "packages/ui", base: "develop" })
  const worktree = path.join(home, ".worktrees", "fix-login", "packages", "ui")
  expect(result.content).toContain(`ses_2 in worktree "fix-login" at ${worktree}`)
  expect(calls.filter((c) => c.method === "create")[1].input.location).toEqual({ directory: path.join(home, "web") })
  expect(calls.find((c) => c.method === "worktree")?.input).toEqual({ projectID: "prj_1", name: "fix-login", branch: "develop" })
  expect(calls.find((c) => c.method === "move")?.input).toEqual({ sessionID: "ses_2", directory: worktree })
  expect(calls.find((c) => c.method === "prompt")?.input).toEqual({ sessionID: "ses_2", text: "do it" })

  emit({ type: "session.execution.started", data: { sessionID: "ses_2" } })
  emit({ type: "session.execution.succeeded", data: { sessionID: "ses_2" } })
  emit({ type: "session.execution.succeeded", data: { sessionID: "ses_unrelated" } })
  await settle()

  const notes = calls.filter((c) => c.method === "synthetic")
  expect(notes).toHaveLength(1)
  expect(notes[0].input.sessionID).toBe("ses_1")
  expect(notes[0].input.text).toContain("is now done")
  expect((await tools.get("list_workers").execute({})).content).toContain(
    `[done] Fix Login! — ses_2 — ${worktree} [worktree fix-login]`,
  )
  await cleanup()
})

test("works in place when asked, and outside git projects", async () => {
  const { tools, calls, cleanup } = await started()
  const spawn = tools.get("spawn_worker")

  await spawn.execute({ title: "Read", prompt: "look", project: "api", worktree: false })
  expect(calls.filter((c) => c.method === "create")[1].input.location).toEqual({ directory: path.join(home, "api") })

  await spawn.execute({ title: "Notes", prompt: "write", directory: "notes" })
  expect(calls.filter((c) => c.method === "create")[2].input.location).toEqual({ directory: path.join(home, "notes") })
  expect(calls.some((c) => c.method === "worktree" || c.method === "move")).toBe(false)

  await expect(spawn.execute({ title: "x", prompt: "y", project: "notes" })).rejects.toThrow("not a git project")
  await expect(spawn.execute({ title: "x", prompt: "y", directory: "notes", worktree: true })).rejects.toThrow(
    "a worktree needs a git project",
  )
  await cleanup()
})

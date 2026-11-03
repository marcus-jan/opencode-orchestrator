import { expect, test } from "bun:test"
import plugin, { parseOptions } from "../src/index"

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
      create: record("create", () => ({ id: `ses_${++next}` })),
      get: record("get"),
      update: record("update"),
      prompt: record("prompt"),
      synthetic: record("synthetic"),
      instructions: { entry: { put: record("board") } },
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

test("parseOptions resolves defaults and validates types", () => {
  expect(parseOptions(undefined, "/home")).toEqual({ home: "/home", title: "Orchestrator", notify: true })
  expect(() => parseOptions({ notify: "yes" }, "/home")).toThrow('option "notify" must be a boolean')
})

test("stays inactive outside its home directory", async () => {
  const { ctx, tools, calls } = fakeContext("/elsewhere", { home: "/home" })
  await plugin.setup(ctx as never)
  expect(tools.size).toBe(0)
  expect(calls).toEqual([])
})

test("spawns workers and reports status changes to the orchestrator", async () => {
  const { ctx, tools, calls, emit } = fakeContext("/home")
  const cleanup = await plugin.setup(ctx as never)
  await settle()
  expect(calls.find((c) => c.method === "create")?.input.title).toBe("Orchestrator")

  const result = await tools.get("spawn_worker").execute({ title: "Fix login", prompt: "do it", directory: "repo" })
  expect(result.content).toContain("ses_2")
  expect(calls.find((c) => c.method === "prompt")?.input).toEqual({ sessionID: "ses_2", text: "do it" })

  emit({ type: "session.execution.started", data: { sessionID: "ses_2" } })
  emit({ type: "session.execution.succeeded", data: { sessionID: "ses_2" } })
  emit({ type: "session.execution.succeeded", data: { sessionID: "ses_unrelated" } })
  await settle()

  const notes = calls.filter((c) => c.method === "synthetic")
  expect(notes).toHaveLength(1)
  expect(notes[0].input.sessionID).toBe("ses_1")
  expect(notes[0].input.text).toContain("is now done")
  expect((await tools.get("list_workers").execute({})).content).toContain("[done] Fix login — ses_2 — /home/repo")
  if (cleanup) await cleanup()
})

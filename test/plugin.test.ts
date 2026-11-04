import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runtime } from "../src/herdr"
import plugin, { parseOptions } from "../src/index"

const home = mkdtempSync(path.join(tmpdir(), "orchestrator-"))
mkdirSync(path.join(home, "web", ".git"), { recursive: true })
writeFileSync(path.join(home, "web", ".git", "HEAD"), "ref: refs/heads/develop\n")
mkdirSync(path.join(home, "web", "packages", "ui"), { recursive: true })
mkdirSync(path.join(home, "api"), { recursive: true })
writeFileSync(path.join(home, "api", ".git"), "gitdir: /elsewhere\n")
mkdirSync(path.join(home, "notes"), { recursive: true })
// A stray tool folder (e.g. GitKraken's .git/gk) must not make home look like a repo
mkdirSync(path.join(home, ".git", "gk"), { recursive: true })
afterAll(() => rmSync(home, { recursive: true, force: true }))

const realExec = runtime.exec
const realSleep = runtime.sleep
afterEach(() => void Object.assign(runtime, { exec: realExec, sleep: realSleep }))

/** Fake git + herdr. `web` has develop/master; `api` only main; branch feat/taken exists. */
function fakeShell({ herdr = true, busy = 0 } = {}) {
  const runs: string[][] = []
  const spaces = new Map<string, string | undefined>([["w1", undefined]])
  const branches = new Set(["feat/taken"])
  runtime.sleep = async () => {}
  const refs: Record<string, string[]> = { web: ["origin/develop", "origin/master"], api: ["main"] }
  let next = 9
  runtime.exec = async (file, args) => {
    runs.push([path.basename(file), ...args])
    if (file === "git") {
      const repo = path.basename(args[1])
      const ref = args.at(-1)!
      if (args[2] === "fetch") return ""
      if (ref.startsWith("refs/heads/") && branches.has(ref.slice(11))) return "ok"
      if (args[2] === "worktree" && args[3] === "remove") return void rmSync(ref, { recursive: true, force: true }), ""
      if (args[2] === "branch" && branches.delete(ref)) return ""
      if (ref.endsWith("^{commit}") && refs[repo]?.includes(ref.slice(0, -9))) return "ok"
      throw new Error("missing")
    }
    if (!herdr) throw new Error("herdr: no server")
    const flag = (name: string) => args[args.indexOf(name) + 1]
    const json = (result: unknown) => JSON.stringify({ id: "cli", result })
    const opened = (cwd: string, extra = {}) => {
      const id = `w${++next}`
      spaces.set(id, (extra as { worktree?: { path: string } }).worktree?.path)
      return json({ workspace: { workspace_id: id }, root_pane: { pane_id: `${id}:p1`, cwd }, ...extra })
    }
    if (args[0] === "workspace" && args[1] === "list") {
      const main = { repo_root: path.join(home, "web"), is_linked_worktree: false }
      return json({ workspaces: [...spaces.keys()].map((id) => ({ workspace_id: id, label: id, ...(id === "w1" && { worktree: main }) })) })
    }
    if (args[0] === "workspace" && args[1] === "close") return spaces.delete(args[2]), json({})
    if (args[0] === "worktree" && args[1] === "remove") {
      rmSync(spaces.get(flag("--workspace"))!, { recursive: true, force: true })
      spaces.delete(flag("--workspace"))
      return json({})
    }
    if (args[0] === "worktree") {
      const dir = path.join(home, ".herdr", "web", flag("--branch").replace(/\//g, "-"))
      mkdirSync(dir, { recursive: true })
      branches.add(flag("--branch"))
      return opened(dir, { worktree: { path: dir } })
    }
    if (args[0] === "workspace" && args[1] === "create") return opened(flag("--cwd"))
    if (args[0] === "agent" && busy-- > 0) {
      throw new Error(`herdr agent start: {"error":{"code":"agent_pane_busy","message":"not an available shell"}}`)
    }
    return json({})
  }
  return Object.assign(runs, { spaces, branches })
}

function fakeContext(directory: string, options: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>()
  const tools = new Map<string, any>()
  const calls: { method: string; input: any }[] = []
  const deleted = new Set<string>()
  let next = 0
  let push: ((event: unknown) => void) | undefined
  const queue: unknown[] = []
  const record = (method: string, result: (input: any) => unknown = () => ({})) => async (input: any) => {
    calls.push({ method, input })
    return result(input)
  }
  const ctx = {
    options: { herdr: "/bin/herdr", sweepSeconds: 0, ...options },
    location: { directory },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
    session: {
      create: record("create", () => ({ id: `ses_${++next}`, projectID: "prj_1" })),
      get: record("get", (input) => {
        if (deleted.has(input.sessionID)) throw { _tag: "SessionNotFoundError", message: `Session not found: ${input.sessionID}` }
        return { id: input.sessionID, model: { id: "opus", providerID: "anthropic" } }
      }),
      remove: record("remove", (input) => void deleted.add(input.sessionID)),
      update: record("update"),
      move: record("move"),
      prompt: record("prompt"),
      synthetic: record("synthetic"),
      instructions: { entry: { put: record("board") } },
    },
    model: {
      list: async () => ({ data: [{ id: "opus", modelID: "opus", providerID: "anthropic" }] }),
    },
    worktree: {
      create: record("worktree", (input) => ({ directory: path.join(home, ".worktrees", input.name) })),
    },
    command: { transform: async () => {} },
    tool: {
      transform: async (fn: (editor: any) => void) =>
        fn({
          namespace: () => {},
          add: (tool: any) =>
            tools.set(tool.name, { ...tool, execute: (input: unknown) => tool.execute(input, { sessionID: "ses_1" }) }),
        }),
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
  return { ctx, tools, calls, store, deleted, emit: (event: unknown) => (push ? push(event) : queue.push(event)) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

async function started(options: Record<string, unknown> = {}) {
  const fake = fakeContext(home, options)
  const cleanup = await plugin.setup(fake.ctx as never)
  await settle()
  return { ...fake, cleanup: async () => void (cleanup && (await cleanup())) }
}

const created = (calls: { method: string; input: any }[]) => calls.filter((c) => c.method === "create").slice(1)

test("parseOptions resolves defaults and validates types", () => {
  expect(parseOptions(undefined, "/home")).toMatchObject({ home: "/home", title: "Orchestrator", notify: true, worktree: true })
  expect(parseOptions({ herdr: false }, "/home").herdr).toBe(false)
  expect(() => parseOptions({ notify: "yes" }, "/home")).toThrow('option "notify" must be a boolean')
  expect(() => parseOptions({ herdr: 1 }, "/home")).toThrow('option "herdr" must be a string or false')
  expect(parseOptions({ model: "claude-local/claude-opus-5-5" }, "/home").model).toEqual({
    providerID: "claude-local",
    id: "claude-opus-5-5",
  })
  expect(() => parseOptions({ model: "opus" }, "/home")).toThrow('option "model" must look like')
})

test("stays inactive outside its home directory", async () => {
  const { ctx, tools, calls } = fakeContext("/elsewhere", { home })
  await plugin.setup(ctx as never)
  expect(tools.size).toBe(0)
  expect(calls).toEqual([])
})

test("lists git projects and tells the orchestrator how to name workers", async () => {
  const { tools, calls, cleanup } = await started()
  expect((await tools.get("list_projects").execute({})).content).toBe("- api\n- web")
  const value = calls.find((c) => c.method === "board")?.input.value
  expect(value).toContain("api, web")
  expect(value).toContain("feat/ABC-123")
  await cleanup()
})

test("opens project workers as a herdr worktree space nested under the repo", async () => {
  const runs = fakeShell()
  const { tools, calls, emit, cleanup } = await started()
  expect(calls.find((c) => c.method === "create")?.input.title).toBe("Orchestrator")

  const result = await tools.get("spawn_worker").execute({
    title: "Fix Login",
    prompt: "do it",
    why: "Login redirect bug from a capture",
    project: "web",
    directory: "packages/ui",
    branch: "fix/ABC-1-login",
  })
  const worktree = path.join(home, ".herdr", "web", "fix-ABC-1-login", "packages", "ui")
  expect(result.content).toBe(`Spawned worker "Fix Login" as ses_2: branch fix/ABC-1-login off origin/develop, ${worktree}, herdr space w10.`)
  expect(runs).toContainEqual([
    "herdr", "worktree", "create", "--workspace", "w1", "--branch", "fix/ABC-1-login",
    "--base", "origin/develop", "--label", "Fix Login", "--no-focus",
  ])
  expect(runs).toContainEqual([
    "herdr", "agent", "start", "fix-login", "--kind", "opencode", "--pane", "w10:p1", "--timeout", "90000", "--", "--session", "ses_2",
  ])
  expect(created(calls)[0].input.location).toEqual({ directory: worktree })
  expect(created(calls)[0].input.model).toEqual({ id: "opus", providerID: "anthropic" })
  expect(calls.some((c) => c.method === "worktree" || c.method === "move")).toBe(false)
  expect(calls.find((c) => c.method === "prompt")?.input).toEqual({ sessionID: "ses_2", text: "do it" })
  const pinned = calls.find((c) => c.method === "board" && c.input.sessionID === "ses_2")?.input.value
  expect(pinned).toContain(`Project: ${path.join(home, "web")}`)
  expect(pinned).toContain("Branch: fix/ABC-1-login off origin/develop")
  expect(pinned).toContain("Herdr space: w10")
  expect(calls.findIndex((c) => c.input?.key === "orchestrator-origin")).toBeLessThan(calls.findIndex((c) => c.method === "prompt"))

  emit({ type: "session.execution.started", data: { sessionID: "ses_2" } })
  emit({ type: "session.execution.succeeded", data: { sessionID: "ses_2" } })
  emit({ type: "session.execution.succeeded", data: { sessionID: "ses_unrelated" } })
  await settle()

  const notes = calls.filter((c) => c.method === "synthetic")
  expect(notes).toHaveLength(1)
  expect(notes[0].input.sessionID).toBe("ses_1")
  expect(notes[0].input.text).toContain("is now done")
  expect((await tools.get("list_workers").execute({})).content).toContain(
    `[done] Fix Login — ses_2 — ${worktree} [worktree fix/ABC-1-login] [herdr w10]`,
  )
  await cleanup()
})

test("picks branch and base defaults: develop, master for hotfixes, main as a fallback", async () => {
  const runs = fakeShell()
  const { tools, cleanup } = await started()
  const spawn = tools.get("spawn_worker")
  const bases = () => runs.filter((r) => r[1] === "worktree").map((r) => [r.at(-6), r.at(-4)])

  await spawn.execute({ title: "New Thing", prompt: "p", why: "w", project: "web" })
  await spawn.execute({ title: "Urgent", prompt: "p", why: "w", project: "web", branch: "hotfix/prod-down" })
  await spawn.execute({ title: "Api", prompt: "p", why: "w", project: "api", branch: "chore/x" })
  expect(bases()).toEqual([
    ["feat/new-thing", "origin/develop"],
    ["hotfix/prod-down", "origin/master"],
    ["chore/x", "main"],
  ])
  // No main space for api, so herdr places it by cwd.
  expect(runs.find((r) => r.includes("chore/x"))).toContain("--cwd")

  await expect(spawn.execute({ title: "t", prompt: "p", why: "w", project: "web", branch: "feat/taken" })).rejects.toThrow("already exists")
  await expect(spawn.execute({ title: "t", prompt: "p", why: "w", project: "web", base: "nope" })).rejects.toThrow("none of nope exist")
  await cleanup()
})

test("ideas outside a repo get a new herdr space in the orchestrator's folder", async () => {
  const runs = fakeShell()
  const { tools, calls, cleanup } = await started()
  const result = await tools.get("spawn_worker").execute({
    title: "Research idea",
    prompt: "think",
    why: "From a Scrawl capture; user wants options",
  })
  expect(runs).toContainEqual(["herdr", "workspace", "create", "--cwd", home, "--label", "Research idea", "--no-focus"])
  const pinned = calls.find((c) => c.method === "board" && c.input.sessionID === "ses_2")?.input
  expect(pinned.key).toBe("orchestrator-origin")
  expect(pinned.value).toContain("started by the OpenCode orchestrator (ses_1)")
  expect(pinned.value).toContain("Why: From a Scrawl capture; user wants options")
  expect(pinned.value).toContain("Not tied to a repo")
  expect(created(calls)[0].input.location).toEqual({ directory: home })
  expect(result.content).toContain("herdr space w10")
  expect(runs.some((r) => r[0] === "git")).toBe(false)

  await expect(tools.get("spawn_worker").execute({ title: "x", prompt: "y", why: "w", project: "notes" })).rejects.toThrow("not a git project")
  await expect(
    tools.get("spawn_worker").execute({ title: "x", prompt: "y", why: "w", directory: "notes", worktree: true }),
  ).rejects.toThrow("a worktree needs a git project")
  await cleanup()
})

test("retries herdr agent start while a new pane's shell is still busy", async () => {
  const runs = fakeShell({ busy: 2 })
  const { tools, cleanup } = await started()
  const result = await tools.get("spawn_worker").execute({ title: "Idea", prompt: "p", why: "w" })
  expect(runs.filter((r) => r[1] === "agent")).toHaveLength(3)
  expect(result.content).not.toContain("Could not attach")
  await cleanup()
})

test("falls back to an available model and refuses to spawn without one", async () => {
  const runs = fakeShell()
  const fallback = await started({ model: "gone/old-model" })
  const result = await fallback.tools.get("spawn_worker").execute({ title: "Idea", prompt: "p", why: "w" })
  expect(created(fallback.calls)[0].input.model).toEqual({ id: "opus", providerID: "anthropic" })
  expect(result.content).toContain("Model gone/old-model is unavailable; using anthropic/opus.")
  await fallback.cleanup()

  const broken = await started({ model: "gone/old-model" })
  broken.ctx.session.get = async () => ({ model: { id: "also-gone", providerID: "gone" } }) as never
  const before = runs.length
  await expect(broken.tools.get("spawn_worker").execute({ title: "Idea 2", prompt: "p", why: "w" })).rejects.toThrow(
    "no worker model available (tried gone/old-model, gone/also-gone)",
  )
  expect(runs.slice(before).some((r) => r[1] === "workspace" && r[2] === "create")).toBe(false)
  await broken.cleanup()
})

test("falls back to headless OpenCode worktrees when herdr is unavailable", async () => {
  fakeShell({ herdr: false })
  const { tools, calls, cleanup } = await started()
  const result = await tools.get("spawn_worker").execute({ title: "Fix", prompt: "p", why: "w", project: "web", branch: "fix/a" })
  expect(created(calls)[0].input.location).toEqual({ directory: path.join(home, "web") })
  expect(calls.find((c) => c.method === "worktree")?.input).toEqual({ projectID: "prj_1", name: "fix-a", branch: "origin/develop" })
  expect(calls.find((c) => c.method === "move")?.input.directory).toBe(path.join(home, ".worktrees", "fix-a"))
  expect(result.content).toContain("headless (herdr unavailable)")
  await cleanup()
})

const spawnLogin = (tools: Map<string, any>) =>
  tools.get("spawn_worker").execute({ title: "Fix Login", prompt: "p", why: "w", project: "web", branch: "fix/ABC-1-login" })
const loginTree = path.join(home, ".herdr", "web", "fix-ABC-1-login")
const closedNotes = (calls: { method: string; input: any }[]) =>
  calls.filter((c) => c.method === "synthetic" && c.input.description?.endsWith("closed")).map((c) => c.input)

test("asks about leftovers when the user closes a worker's herdr space and worktree by hand", async () => {
  const shell = fakeShell()
  const { tools, calls, cleanup } = await started()
  await spawnLogin(tools)
  rmSync(loginTree, { recursive: true, force: true })
  shell.spaces.delete("w10")

  const listed = (await tools.get("list_workers").execute({})).content
  expect(listed).toContain("[closed] Fix Login")
  expect(listed).toContain("closed manually: herdr space w10 closed, worktree removed; left: branch fix/ABC-1-login (not on origin)")
  const [note] = closedNotes(calls)
  expect(note.resume).toBe(true)
  expect(note.text).toContain("Still left: branch fix/ABC-1-login (not on origin)")
  expect(note.text).toContain("Ask the user whether to clean these up")

  // Cleaning up after a manual close keeps it marked as closed by the user.
  const result = await tools.get("close_worker").execute({ sessionID: "ses_2", branch: true })
  expect(result.content).toBe("Fix Login: deleted branch fix/ABC-1-login.")
  expect(shell.branches.has("fix/ABC-1-login")).toBe(false)
  expect((await tools.get("list_workers").execute({})).content).not.toContain("left:")
  expect(closedNotes(calls)).toHaveLength(1)
  await cleanup()
})

test("a deleted session with its worktree still around asks about the worktree", async () => {
  fakeShell()
  const { tools, calls, deleted, emit, cleanup } = await started()
  await spawnLogin(tools)
  deleted.add("ses_2")
  emit({ type: "session.deleted", data: { sessionID: "ses_2" } })
  await settle()
  const [note] = closedNotes(calls)
  expect(note.text).toContain("was closed manually: session deleted")
  expect(note.text).toContain(`herdr space w10; worktree ${loginTree}; branch fix/ABC-1-login`)
  expect(note.resume).toBe(true)
  await cleanup()
})

test("records a closed idea space with nothing left without waking the orchestrator", async () => {
  const shell = fakeShell()
  const { tools, calls, cleanup } = await started()
  await tools.get("spawn_worker").execute({ title: "Idea", prompt: "p", why: "w" })
  shell.spaces.delete("w10")
  await tools.get("list_workers").execute({})
  const [note] = closedNotes(calls)
  expect(note.text).toBe('Worker "Idea" (ses_2) was closed manually: herdr space w10 closed; nothing left to clean up.')
  expect(note.resume).toBe(false)
  await cleanup()
})

test("close_worker removes the worktree and space without reporting a manual close", async () => {
  const shell = fakeShell()
  const { tools, calls, cleanup } = await started()
  await spawnLogin(tools)
  const result = await tools.get("close_worker").execute({ sessionID: "ses_2" })
  expect(result.content).toBe(
    "Fix Login: removed worktree and closed herdr space w10.\nStill left: branch fix/ABC-1-login (not on origin).",
  )
  expect(shell).toContainEqual(["herdr", "worktree", "remove", "--workspace", "w10"])
  expect(shell.spaces.has("w10")).toBe(false)
  expect((await tools.get("list_workers").execute({})).content).toContain("[closed] Fix Login")
  expect((await tools.get("list_workers").execute({})).content).toContain("closed by orchestrator")
  expect(closedNotes(calls)).toHaveLength(0)
  await cleanup()
})

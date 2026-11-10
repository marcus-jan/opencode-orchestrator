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
  /** Branches pushed to origin, and checkouts with uncommitted changes. */
  const pushed = new Set<string>()
  const dirty = new Set<string>()
  /** Directories that are git checkouts, for sessions that join. */
  const checkouts = new Map<string, { root: string; checkout: string; branch?: string }>()
  /** herdr pane running each OpenCode session, by space id. */
  const panes = new Map<string, string>()
  runtime.sleep = async () => {}
  const refs: Record<string, string[]> = { web: ["origin/develop", "origin/master"], api: ["main"] }
  let next = 9
  runtime.exec = async (file, args) => {
    runs.push([path.basename(file), ...args])
    if (file === "git") {
      const repo = path.basename(args[1])
      const ref = args.at(-1)!
      const checkout = checkouts.get(args[1])
      if (args[2] === "rev-parse" && ref === "--show-toplevel") return checkout ? checkout.checkout : Promise.reject(new Error("not a git repo"))
      if (args[2] === "rev-parse" && ref === "--git-common-dir") return checkout ? path.join(checkout.root, ".git") : Promise.reject(new Error("not a git repo"))
      if (args[2] === "branch" && ref === "--show-current") return checkout?.branch ?? ""
      if (args[2] === "fetch") return ""
      if (args[2] === "status") return dirty.has(args[1]) ? " M file.ts\n" : ""
      if (ref.startsWith("refs/remotes/origin/") && pushed.has(ref.slice(20))) return "ok"
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
      return json({
        workspaces: [...spaces.keys()].map((id) => ({ workspace_id: id, label: id, ...(id === "w1" && { worktree: main }) })),
      })
    }
    if (args[0] === "pane" && args[1] === "list") {
      const only = args.includes("--workspace") ? flag("--workspace") : undefined
      const list = [...panes].filter(([space]) => !only || space === only)
      return json({
        panes: list.map(([space, session]) => ({ pane_id: `${space}:p1`, workspace_id: space, agent_session: { kind: "id", value: session } })),
      })
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
  return Object.assign(runs, { spaces, branches, checkouts, panes, pushed, dirty })
}

function fakeContext(directory: string, options: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>()
  const tools = new Map<string, any>()
  const calls: { method: string; input: any }[] = []
  const deleted = new Set<string>()
  const sessions: { id: string; parentID?: string }[] = []
  /** Extra SessionInfo fields for sessions the orchestrator did not create. */
  const infos = new Map<string, Record<string, unknown>>()
  const commands = new Map<string, any>()
  let next = 0
  let push: ((event: unknown) => void) | undefined
  const queue: unknown[] = []
  const record = (method: string, result: (input: any) => unknown = () => ({})) => async (input: any) => {
    calls.push({ method, input })
    return result(input)
  }
  const ctx = {
    options: { herdr: "/bin/herdr", ...options },
    location: { directory },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
    },
    session: {
      create: record("create", () => ({ id: `ses_${++next}`, projectID: "prj_1" })),
      get: record("get", (input) => {
        if (deleted.has(input.sessionID)) throw { _tag: "SessionNotFoundError", message: `Session not found: ${input.sessionID}` }
        return { id: input.sessionID, model: { id: "opus", providerID: "anthropic" }, ...infos.get(input.sessionID) }
      }),
      remove: record("remove", (input) => void deleted.add(input.sessionID)),
      update: record("update"),
      move: record("move"),
      prompt: record("prompt"),
      synthetic: record("synthetic", (input) => {
        if (deleted.has(input.sessionID)) throw { _tag: "SessionNotFoundError", message: `Session not found: ${input.sessionID}` }
        return {}
      }),
      list: record("list", (input) => ({
        data: sessions.filter((s) => !deleted.has(s.id) && (!input.search || String(infos.get(s.id)?.title ?? "").includes(input.search))),
      })),
      instructions: { entry: { put: record("board") } },
    },
    model: {
      list: async () => ({ data: [{ id: "opus", modelID: "opus", providerID: "anthropic" }] }),
    },
    worktree: {
      create: record("worktree", (input) => ({ directory: path.join(home, ".worktrees", input.name) })),
    },
    command: {
      transform: async (fn: (editor: any) => void) => fn({ add: (command: any) => commands.set(command.name, command) }),
    },
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
  return { ctx, tools, commands, calls, store, deleted, sessions, infos, emit: (event: unknown) => (push ? push(event) : queue.push(event)) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

async function started(options: Record<string, unknown> = {}, stored: Record<string, unknown> = {}) {
  const fake = fakeContext(home, options)
  for (const [key, value] of Object.entries(stored)) fake.store.set(key, value)
  const cleanup = await plugin.setup(fake.ctx as never)
  await settle()
  return { ...fake, cleanup: async () => void (cleanup && (await cleanup())) }
}

const created = (calls: { method: string; input: any }[]) => calls.filter((c) => c.method === "create").slice(1)

test("parseOptions resolves defaults, validates types and ignores retired options", () => {
  expect(parseOptions(undefined, "/home")).toEqual({
    home: "/home",
    title: "Orchestrator",
    worktree: true,
    herdr: expect.any(String),
    model: undefined,
  })
  expect(parseOptions({ notify: "yes", sweepSeconds: "x" }, "/home")).not.toHaveProperty("notify")
  expect(parseOptions({ herdr: false }, "/home").herdr).toBe(false)
  expect(() => parseOptions({ herdr: 1 }, "/home")).toThrow('option "herdr" must be a string or false')
  expect(parseOptions({ model: "claude-local/claude-opus-5-5" }, "/home").model).toEqual({
    providerID: "claude-local",
    id: "claude-opus-5-5",
  })
  expect(() => parseOptions({ model: "opus" }, "/home")).toThrow('option "model" must look like')
})

test("stays inactive outside its home directory", async () => {
  const { ctx, tools, commands, calls } = fakeContext("/elsewhere", { home })
  await plugin.setup(ctx as never)
  expect(tools.size).toBe(0)
  expect([...commands.keys()]).toEqual(["orchestrator-worker-join", "orchestrator-worker-close"])
  expect(calls).toEqual([])
})

test("lists git projects and tells the orchestrator how to name workers", async () => {
  const { tools, commands, calls, cleanup } = await started()
  expect([...tools.keys()]).toEqual([
    "orchestrator_projects",
    "orchestrator_worker_spawn",
    "orchestrator_worker_list",
    "orchestrator_worker_close",
    "orchestrator_worker_message",
    "orchestrator_worker_forget",
  ])
  expect([...commands.keys()]).toEqual(["orchestrator-worker-join", "orchestrator-worker-close", "orchestrator-pin"])
  expect((await tools.get("orchestrator_projects").execute({})).content).toBe("- api\n- web")
  const value = calls.find((c) => c.method === "board")?.input.value
  expect(value).toContain("api, web")
  expect(value).toContain("orchestrator_worker_spawn")
  expect(value).toContain("feat/ABC-123")
  expect(value).not.toContain("batched")
  expect(value).toContain("Workers:\nNo workers yet.")
  await cleanup()
})

test("opens project workers as a herdr worktree space nested under the repo", async () => {
  const runs = fakeShell()
  const { tools, calls, cleanup } = await started()
  expect(calls.find((c) => c.method === "create")?.input.title).toBe("Orchestrator")

  const result = await tools.get("orchestrator_worker_spawn").execute({
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
  expect(pinned).toContain("Outcome: <what you did and what is left>")
  expect(pinned).not.toContain("status")
  expect(calls.findIndex((c) => c.input?.key === "orchestrator-origin")).toBeLessThan(calls.findIndex((c) => c.method === "prompt"))

  expect((await tools.get("orchestrator_worker_list").execute({})).content).toBe("- Fix Login ses_2 w10 fix/ABC-1-login")
  const boardValue = calls.filter((c) => c.method === "board" && c.input.sessionID === "ses_1").at(-1)?.input.value
  expect(boardValue).toEndWith("Workers:\n- Fix Login ses_2 w10 fix/ABC-1-login")

  expect((await tools.get("orchestrator_worker_message").execute({ sessionID: "ses_2", text: "also logout", steer: true })).content).toBe(
    "Sent to Fix Login.",
  )
  expect(calls.filter((c) => c.method === "prompt").at(-1)?.input).toEqual({ sessionID: "ses_2", text: "also logout", delivery: "steer" })
  await expect(tools.get("orchestrator_worker_message").execute({ sessionID: "ses_x", text: "hi" })).rejects.toThrow("not on the worker list")
  await cleanup()
})

test("picks branch and base defaults: develop, master for hotfixes, main as a fallback", async () => {
  const runs = fakeShell()
  const { tools, cleanup } = await started()
  const spawn = tools.get("orchestrator_worker_spawn")
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
  const result = await tools.get("orchestrator_worker_spawn").execute({
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
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toBe("- Research idea ses_2 w10")

  await expect(tools.get("orchestrator_worker_spawn").execute({ title: "x", prompt: "y", why: "w", project: "notes" })).rejects.toThrow(
    "not a git project",
  )
  await expect(
    tools.get("orchestrator_worker_spawn").execute({ title: "x", prompt: "y", why: "w", directory: "notes", worktree: true }),
  ).rejects.toThrow("a worktree needs a git project")
  await cleanup()
})

test("retries herdr agent start while a new pane's shell is still busy", async () => {
  const runs = fakeShell({ busy: 2 })
  const { tools, cleanup } = await started()
  const result = await tools.get("orchestrator_worker_spawn").execute({ title: "Idea", prompt: "p", why: "w" })
  expect(runs.filter((r) => r[1] === "agent")).toHaveLength(3)
  expect(result.content).not.toContain("Could not attach")
  await cleanup()
})

test("falls back to an available model and refuses to spawn without one", async () => {
  const runs = fakeShell()
  const fallback = await started({ model: "gone/old-model" })
  const result = await fallback.tools.get("orchestrator_worker_spawn").execute({ title: "Idea", prompt: "p", why: "w" })
  expect(created(fallback.calls)[0].input.model).toEqual({ id: "opus", providerID: "anthropic" })
  expect(result.content).toContain("Model gone/old-model is unavailable; using anthropic/opus.")
  await fallback.cleanup()

  const broken = await started({ model: "gone/old-model" })
  broken.ctx.session.get = async () => ({ model: { id: "also-gone", providerID: "gone" } }) as never
  const before = runs.length
  await expect(broken.tools.get("orchestrator_worker_spawn").execute({ title: "Idea 2", prompt: "p", why: "w" })).rejects.toThrow(
    "no worker model available (tried gone/old-model, gone/also-gone)",
  )
  expect(runs.slice(before).some((r) => r[1] === "workspace" && r[2] === "create")).toBe(false)
  await broken.cleanup()
})

test("falls back to headless OpenCode worktrees when herdr is unavailable", async () => {
  fakeShell({ herdr: false })
  const { tools, calls, cleanup } = await started()
  const result = await tools.get("orchestrator_worker_spawn").execute({ title: "Fix", prompt: "p", why: "w", project: "web", branch: "fix/a" })
  expect(created(calls)[0].input.location).toEqual({ directory: path.join(home, "web") })
  expect(calls.find((c) => c.method === "worktree")?.input).toEqual({ projectID: "prj_1", name: "fix-a", branch: "origin/develop" })
  expect(calls.find((c) => c.method === "move")?.input.directory).toBe(path.join(home, ".worktrees", "fix-a"))
  expect(result.content).toContain("headless (herdr unavailable)")
  await cleanup()
})

const spawnLogin = (tools: Map<string, any>) =>
  tools
    .get("orchestrator_worker_spawn")
    .execute({ title: "Fix Login", prompt: "p", why: "w", project: "web", branch: "fix/ABC-1-login" })
const loginTree = path.join(home, ".herdr", "web", "fix-ABC-1-login")

test("closing a worker removes its worktree and space, keeps the branch and drops it from the list", async () => {
  const shell = fakeShell()
  const { tools, calls, cleanup } = await started()
  await spawnLogin(tools)
  shell.pushed.add("fix/ABC-1-login")
  const result = await tools.get("orchestrator_worker_close").execute({ sessionID: "ses_2" })
  expect(result.content).toBe(
    "Fix Login: removed worktree and closed herdr space w10.\nRemoved from the list.\nLeft: branch fix/ABC-1-login (pushed to origin).",
  )
  expect(shell).toContainEqual(["herdr", "worktree", "remove", "--workspace", "w10"])
  expect(shell.spaces.has("w10")).toBe(false)
  expect(shell.branches.has("fix/ABC-1-login")).toBe(true)
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toBe("No workers yet.")
  expect(calls.filter((c) => c.method === "board" && c.input.sessionID === "ses_1").at(-1)?.input.value).toEndWith("No workers yet.")
  await expect(tools.get("orchestrator_worker_close").execute({ sessionID: "ses_2" })).rejects.toThrow("not on the worker list")
  await cleanup()
})

test("closing with branch and session deletes them too", async () => {
  const shell = fakeShell()
  const { tools, deleted, cleanup } = await started()
  await spawnLogin(tools)
  const result = await tools.get("orchestrator_worker_close").execute({ sessionID: "ses_2", branch: true, session: true })
  expect(result.content).toBe(
    "Fix Login: removed worktree and closed herdr space w10, deleted branch fix/ABC-1-login, deleted session.\nRemoved from the list.",
  )
  expect(shell.branches.has("fix/ABC-1-login")).toBe(false)
  expect(deleted.has("ses_2")).toBe(true)
  await cleanup()
})

test("closing refuses a worktree with uncommitted changes unless forced", async () => {
  const shell = fakeShell()
  const { tools, cleanup } = await started()
  await spawnLogin(tools)
  shell.dirty.add(loginTree)
  const refused = await tools.get("orchestrator_worker_close").execute({ sessionID: "ses_2" })
  expect(refused.content).toBe(
    `Fix Login: not closed; ${loginTree} has uncommitted changes.\nPass force: true only if the user confirms discarding it.`,
  )
  expect(shell.spaces.has("w10")).toBe(true)
  expect(shell.some((r) => r[1] === "worktree" && r[2] === "remove")).toBe(false)
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toContain("ses_2")

  const forced = await tools.get("orchestrator_worker_close").execute({ sessionID: "ses_2", force: true })
  expect(shell).toContainEqual(["herdr", "worktree", "remove", "--workspace", "w10", "--force"])
  expect(forced.content).toContain("Removed from the list.")
  await cleanup()
})

test("forget drops a worker without closing anything", async () => {
  const shell = fakeShell()
  const { tools, cleanup } = await started()
  await spawnLogin(tools)
  expect((await tools.get("orchestrator_worker_forget").execute({ sessionID: "ses_2" })).content).toBe("Forgot ses_2.")
  expect((await tools.get("orchestrator_worker_forget").execute({ sessionID: "ses_2" })).content).toBe("ses_2 was not on the list.")
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toBe("No workers yet.")
  expect(shell.spaces.has("w10")).toBe(true)
  await cleanup()
})

test("re-pins the most recent other session when the orchestrator is deleted", async () => {
  fakeShell()
  const { tools, calls, deleted, sessions, emit, store, cleanup } = await started()
  await tools.get("orchestrator_worker_spawn").execute({ title: "Idea", prompt: "think", why: "dictation" })
  sessions.push({ id: "ses_2" }, { id: "ses_sub", parentID: "ses_9" }, { id: "ses_9" })
  deleted.add("ses_1")
  emit({ type: "session.deleted", data: { sessionID: "ses_1" } })
  await settle()
  expect(store.get("orchestrator")).toBe("ses_9")
  const note = calls.find((c) => c.method === "synthetic" && c.input.sessionID === "ses_9")?.input
  expect(note.text).toContain("previous orchestrator session (ses_1) was deleted")
  expect(note.resume).toBe(false)
  expect(calls.find((c) => c.method === "board" && c.input.sessionID === "ses_9")?.input.value).toContain("- Idea ses_2 w10")

  // Deleting a worker's session changes nothing: the list only changes through the tools.
  emit({ type: "session.deleted", data: { sessionID: "ses_2" } })
  await settle()
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toBe("- Idea ses_2 w10")
  await cleanup()
})

test("creates a new orchestrator when no other session is around", async () => {
  fakeShell()
  const { deleted, emit, store, cleanup } = await started()
  deleted.add("ses_1")
  emit({ type: "session.deleted", data: { sessionID: "ses_1" } })
  await settle()
  expect(store.get("orchestrator")).toBe("ses_2")
  await cleanup()
})

test("/orchestrator-pin pins the current session", async () => {
  const { commands, store, calls, cleanup } = await started()
  await commands.get("orchestrator-pin").execute({ sessionID: "ses_7" })
  expect(store.get("orchestrator")).toBe("ses_7")
  expect(calls.find((c) => c.method === "synthetic" && c.input.sessionID === "ses_7")?.input.text).toContain(
    "scrawl send <bundle> --session ses_7",
  )
  await cleanup()
})

/** An existing session in a herdr worktree space the orchestrator did not open. */
function externalWorker(shell: ReturnType<typeof fakeShell>, infos: Map<string, Record<string, unknown>>) {
  const tree = path.join(home, ".herdr", "web", "feat-metrics")
  mkdirSync(tree, { recursive: true })
  shell.checkouts.set(tree, { root: path.join(home, "web"), checkout: tree, branch: "feat/metrics" })
  shell.spaces.set("w20", tree)
  shell.panes.set("w20", "ses_ext")
  infos.set("ses_ext", { title: "Contentstack metrics", location: { directory: tree } })
  return tree
}

test("/orchestrator-worker-join in another session flags it and the orchestrator adds it", async () => {
  const away = fakeContext("/elsewhere", { home })
  await plugin.setup(away.ctx as never)
  await away.commands.get("orchestrator-worker-join").execute({ sessionID: "ses_ext", prompt: { text: "finish the PR" } })
  const flagged = away.calls.find((c) => c.method === "update")?.input
  expect(flagged.metadata.orchestratorJoin).toEqual({ why: "finish the PR", at: expect.any(Number) })
  expect(away.calls.find((c) => c.method === "synthetic")?.input.text).toContain("worker list")

  const shell = fakeShell()
  const { tools, calls, infos, emit, cleanup } = await started()
  externalWorker(shell, infos)
  emit({ type: "session.metadata.updated", data: { sessionID: "ses_ext", metadata: flagged.metadata } })
  await settle()
  expect(calls.find((c) => c.method === "update" && c.input.sessionID === "ses_ext")?.input.metadata.orchestratorJoin).toBeNull()
  const pinned = calls.find((c) => c.method === "board" && c.input.sessionID === "ses_ext")?.input.value
  expect(pinned).toContain("This session joined the OpenCode orchestrator (ses_1)")
  expect(pinned).toContain("Why: finish the PR")
  expect(calls.some((c) => c.method === "synthetic" && c.input.sessionID === "ses_1")).toBe(false)
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toBe("- Contentstack metrics ses_ext w20 feat/metrics")

  // The cleared flag echoes back as another metadata update; it must not add it again after a forget.
  await tools.get("orchestrator_worker_forget").execute({ sessionID: "ses_ext" })
  emit({ type: "session.metadata.updated", data: { sessionID: "ses_ext", metadata: { orchestratorJoin: null } } })
  await settle()
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toBe("No workers yet.")
  await cleanup()
})

test("a session in a repo's main checkout joins without claiming the repo's herdr space", async () => {
  const shell = fakeShell()
  const { tools, infos, emit, cleanup } = await started()
  const web = path.join(home, "web")
  shell.checkouts.set(web, { root: web, checkout: web, branch: "develop" })
  shell.panes.set("w1", "ses_main")
  infos.set("ses_main", { title: "Main work", location: { directory: web } })
  emit({ type: "session.metadata.updated", data: { sessionID: "ses_main", metadata: { orchestratorJoin: { why: null } } } })
  await settle()
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toBe("- Main work ses_main")
  await cleanup()
})

test("/orchestrator-worker-close in a worker flags it and the orchestrator closes it", async () => {
  const away = fakeContext("/elsewhere", { home })
  await plugin.setup(away.ctx as never)
  await away.commands.get("orchestrator-worker-close").execute({ sessionID: "ses_2", prompt: { text: "" } })
  const flagged = away.calls.find((c) => c.method === "update")?.input
  expect(flagged.metadata.orchestratorClose).toEqual({ branch: false, session: false, force: false, at: expect.any(Number) })

  const shell = fakeShell()
  const { tools, calls, emit, cleanup } = await started()
  await spawnLogin(tools)
  emit({ type: "session.metadata.updated", data: { sessionID: "ses_2", metadata: flagged.metadata } })
  await settle()
  expect(calls.find((c) => c.method === "update" && c.input.sessionID === "ses_2")?.input.metadata.orchestratorClose).toBeNull()
  expect(shell).toContainEqual(["herdr", "worktree", "remove", "--workspace", "w10"])
  expect(shell.branches.has("fix/ABC-1-login")).toBe(true)
  expect(calls.filter((c) => c.method === "synthetic")).toHaveLength(0)
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toBe("No workers yet.")
  await cleanup()
})

test("/orchestrator-worker-close in a dirty worker refuses and tells the worker", async () => {
  const shell = fakeShell()
  const { tools, calls, emit, cleanup } = await started()
  await spawnLogin(tools)
  shell.dirty.add(loginTree)
  emit({ type: "session.metadata.updated", data: { sessionID: "ses_2", metadata: { orchestratorClose: { at: 1 } } } })
  await settle()
  const reply = calls.find((c) => c.method === "synthetic" && c.input.sessionID === "ses_2")?.input.text
  expect(reply).toContain("has uncommitted changes")
  expect(reply).toContain("/orchestrator-worker-close force")
  expect(shell.spaces.has("w10")).toBe(true)
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toContain("ses_2")
  await cleanup()
})

test("/orchestrator-worker-close in an untracked session says so", async () => {
  fakeShell()
  const { calls, emit, cleanup } = await started()
  emit({ type: "session.metadata.updated", data: { sessionID: "ses_x", metadata: { orchestratorClose: { at: 1 } } } })
  await settle()
  const reply = calls.find((c) => c.method === "synthetic" && c.input.sessionID === "ses_x")
  expect(reply?.input.text).toContain("not on the orchestrator's worker list")
  await cleanup()
})

test("migrates a v0.2 registry on load and drops pending updates", async () => {
  fakeShell()
  const { tools, store, cleanup } = await started(
    {},
    {
      workers: {
        ses_a: { id: "ses_a", title: "Open", directory: home, space: "w1", state: "blocked", detail: "permission", asked: true, created: 1, updated: 2 },
        ses_b: { id: "ses_b", title: "Done", directory: home, state: "closed", closedBy: "user", leftovers: [], created: 2, updated: 3 },
      },
      pending: { ses_a: "Open ses_a: blocked" },
    },
  )
  expect(store.get("workers")).toEqual({ ses_a: { id: "ses_a", title: "Open", directory: home, space: "w1", created: 1 } })
  expect(store.has("pending")).toBe(false)
  expect((await tools.get("orchestrator_worker_list").execute({})).content).toBe("- Open ses_a w1")
  await cleanup()
})

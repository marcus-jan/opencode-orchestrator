import { execFile } from "node:child_process"

export type Exec = (file: string, args: string[]) => Promise<string>

export const exec: Exec = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`${file} ${args[0]} ${args[1] ?? ""}: ${stderr.trim() || error.message}`)) : resolve(stdout),
    ),
  )

/** Swappable process runner and clock (tests replace them). */
export const runtime = { exec, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }
const run: Exec = (file, args) => runtime.exec(file, args)

export interface Space {
  workspace_id: string
  label: string
  worktree?: { repo_root: string; checkout_path: string; is_linked_worktree: boolean }
}

export interface Opened {
  workspace: string
  pane: string
  directory: string
}

/** Herdr agent names: lowercase [a-z0-9_-], starting with a letter, at most 32 chars. */
export function agentName(label: string) {
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "")
  return name || "worker"
}

export function herdr(bin: string) {
  const call = async (args: string[]) => JSON.parse(await run(bin, args)).result
  const opened = (result: any): Opened => ({
    workspace: result.workspace.workspace_id,
    pane: result.root_pane.pane_id,
    directory: result.worktree?.path ?? result.root_pane.cwd,
  })
  return {
    available: () => run(bin, ["workspace", "list"]).then(() => true, () => false),
    /** IDs of every open space, or undefined when herdr can't be reached (so nothing looks closed). */
    spaces: async () =>
      call(["workspace", "list"]).then(
        (result) => new Set<string>((result.workspaces ?? []).map((space: Space) => space.workspace_id)),
        () => undefined,
      ),
    closeSpace: (id: string) => call(["workspace", "close", id]),
    /** Removes the space's worktree checkout and closes the space. */
    removeWorktree: (space: string, force: boolean) =>
      call(["worktree", "remove", "--workspace", space, ...(force ? ["--force"] : [])]),
    /** Repo's main (non-linked) space, so new worktrees nest under it in the sidebar. */
    repoSpace: async (root: string) =>
      (await call(["workspace", "list"])).workspaces?.find(
        (space: Space) => space.worktree?.repo_root === root && !space.worktree.is_linked_worktree,
      ) as Space | undefined,
    worktree: async (input: { root: string; space?: string; branch: string; base: string; label: string }) =>
      opened(
        await call([
          "worktree",
          "create",
          ...(input.space ? ["--workspace", input.space] : ["--cwd", input.root]),
          "--branch",
          input.branch,
          "--base",
          input.base,
          "--label",
          input.label,
          "--no-focus",
        ]),
      ),
    workspace: async (input: { cwd: string; label: string }) =>
      opened(await call(["workspace", "create", "--cwd", input.cwd, "--label", input.label, "--no-focus"])),
    /** A freshly created pane needs a moment before its shell accepts an agent, so retry while it is busy. */
    startOpencode: async (input: { label: string; pane: string; sessionID: string }, attempts = 15) => {
      const args = ["agent", "start", agentName(input.label), "--kind", "opencode", "--pane", input.pane]
      for (let attempt = 1; ; attempt++) {
        try {
          return await call([...args, "--timeout", "90000", "--", "--session", input.sessionID])
        } catch (error) {
          if (attempt >= attempts || !String(error).includes("agent_pane_busy")) throw error
          await runtime.sleep(1000)
        }
      }
    },
  }
}

export type Herdr = ReturnType<typeof herdr>

/** First candidate that exists, preferring `origin/<base>` (after a fetch) over the local ref. */
export async function resolveBase(root: string, candidates: string[]) {
  const git = (...args: string[]) => run("git", ["-C", root, ...args])
  await git("fetch", "origin", "--quiet").catch(() => undefined)
  for (const base of candidates) {
    for (const ref of [`origin/${base}`, base]) {
      if (await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).then(() => true, () => false)) return ref
    }
  }
  throw new Error(`none of ${candidates.join(", ")} exist (locally or on origin) in ${root}`)
}

export const branchExists = (root: string, branch: string) =>
  run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false)

export const branchOnOrigin = (root: string, branch: string) =>
  run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).then(() => true, () => false)

export const removeGitWorktree = (root: string, checkout: string, force: boolean) =>
  run("git", ["-C", root, "worktree", "remove", ...(force ? ["--force"] : []), checkout])

export const deleteBranch = (root: string, branch: string, force: boolean) =>
  run("git", ["-C", root, "branch", force ? "-D" : "-d", branch])

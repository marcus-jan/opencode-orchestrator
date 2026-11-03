import { execFile } from "node:child_process"

export type Exec = (file: string, args: string[]) => Promise<string>

export const exec: Exec = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`${file} ${args[0]} ${args[1] ?? ""}: ${stderr.trim() || error.message}`)) : resolve(stdout),
    ),
  )

/** Swappable process runner (tests replace `runtime.exec`). */
export const runtime = { exec }
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
    startOpencode: (input: { label: string; pane: string; sessionID: string }) =>
      call([
        "agent",
        "start",
        agentName(input.label),
        "--kind",
        "opencode",
        "--pane",
        input.pane,
        "--timeout",
        "90000",
        "--",
        "--session",
        input.sessionID,
      ]),
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

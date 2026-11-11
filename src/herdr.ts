import { execFile } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"

export type Exec = (file: string, args: string[]) => Promise<string>

export const exec: Exec = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      error
        ? reject(new Error(`${path.basename(file)} ${args[0]} ${args[1] ?? ""}: ${stderr.trim() || stdout.trim() || error.message}`))
        : resolve(stdout),
    ),
  )

/** Swappable process runner and worktree folder (tests replace them). */
export const runtime = { exec, worktrees: path.join(homedir(), ".herdr", "worktrees") }
const run: Exec = (file, args) => runtime.exec(file, args)

/** A space in the herdr desktop app (`herdr-app ls`). */
export interface Space {
  id: string
  name?: string
  folder?: string
}

/** Folder name the herdr app's "New worktree" uses for a branch. */
export const worktreeSlug = (branch: string) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")

/**
 * The herdr desktop app (`herdr-app`) plus herdr-core (`hc`), which knows which terminal runs which
 * OpenCode session. Spaces have no parent: the sidebar nests a space under its repo because its folder
 * is a linked worktree of that repo.
 */
export function herdr(bin: string, hc: string) {
  const json = async (file: string, args: string[]) => JSON.parse(await run(file, args))
  const command = (name: string, input: Record<string, unknown>) => json(bin, ["do", name, JSON.stringify(input)])
  const list = async () => ((await json(bin, ["ls"])).spaces ?? []) as Space[]
  return {
    available: () => run(bin, ["status"]).then(() => true, () => false),
    list,
    /** IDs of every open space, or undefined when the app can't be reached (so nothing looks closed). */
    spaces: () => list().then((spaces) => new Set(spaces.map((space) => space.id)), () => undefined),
    /** Opens a space running `argv` in `folder` and returns its id; focus stays on the space the user was in. */
    openSpace: async (input: { folder: string; name: string; argv: string[] }) => {
      const focused = (await json(bin, ["status"]).catch(() => undefined))?.space as string | undefined
      const opened = await command("space.new", { name: input.name, folder: input.folder, argv: input.argv })
      if (typeof opened?.space !== "string") throw new Error(`herdr-app space.new returned no space: ${JSON.stringify(opened)}`)
      if (focused && focused !== opened.space) await command("space.select", { id: focused }).catch(() => undefined)
      return opened.space as string
    },
    closeSpace: (id: string) => command("space.close", { id, confirmed: true }),
    /** Space whose terminal runs `opencode --session <sessionID>`, if any. */
    findSession: async (sessionID: string) => {
      const terminals = ((await json(hc, ["ls", "--json"])).terminals ?? []) as { address: string; agent?: string }[]
      const details = await Promise.all(
        terminals
          .filter((terminal) => !terminal.agent || terminal.agent === "opencode")
          .map((terminal) => json(hc, ["get", terminal.address, "--json"]).catch(() => undefined)),
      )
      const runs = (info: any) => [info?.argv, info?.foreground?.argv].some((argv) => Array.isArray(argv) && argv.includes(sessionID))
      return details.find(runs)?.labels?.["herdr.space"] as string | undefined
    },
  }
}

export type Herdr = ReturnType<typeof herdr>

/**
 * First candidate on origin (after a fetch). Workers always start from origin, never a stale local
 * branch; only an explicitly requested base may also be a local ref.
 */
export async function resolveBase(root: string, candidates: string[], explicit = false) {
  const git = (...args: string[]) => run("git", ["-C", root, ...args])
  await git("fetch", "origin", "--quiet").catch(() => undefined)
  for (const base of candidates) {
    for (const ref of explicit ? [`origin/${base}`, base] : [`origin/${base}`]) {
      if (await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).then(() => true, () => false)) return ref
    }
  }
  throw new Error(`none of ${candidates.join(", ")} exist ${explicit ? "(locally or on origin)" : "on origin"} in ${root}`)
}

/**
 * Adds a worktree where the herdr app's "New worktree" puts it (<worktrees>/<repo>/<slug>): a new branch
 * off `base`, or the existing local branch checked out as is.
 */
export async function createWorktree(root: string, branch: string, base: string | undefined) {
  const checkout = path.join(runtime.worktrees, path.basename(root), worktreeSlug(branch))
  const args = base ? ["-b", branch, checkout, base] : [checkout, branch]
  await run("git", ["-C", root, "worktree", "add", ...args])
  return checkout
}

export const branchExists = (root: string, branch: string) =>
  run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false)

export const branchOnOrigin = (root: string, branch: string) =>
  run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).then(() => true, () => false)

/** Uncommitted or untracked changes in a checkout. */
export const isDirty = (checkout: string) =>
  run("git", ["-C", checkout, "status", "--porcelain"]).then(
    (out) => out.trim().length > 0,
    () => false,
  )

export const removeGitWorktree = (root: string, checkout: string, force: boolean) =>
  run("git", ["-C", root, "worktree", "remove", ...(force ? ["--force"] : []), checkout])

/**
 * Git facts for a directory: the main repo root, the checkout it sits in, its branch, and whether the
 * checkout is a linked worktree (only those are ever removed). Undefined outside git.
 */
export async function checkoutInfo(dir: string) {
  const git = (...args: string[]) => run("git", ["-C", dir, ...args]).then((out) => out.trim())
  try {
    const checkout = await git("rev-parse", "--show-toplevel")
    const root = path.dirname(await git("rev-parse", "--path-format=absolute", "--git-common-dir"))
    const branch = (await git("branch", "--show-current").catch(() => "")) || undefined
    return { root, checkout, branch, linked: path.resolve(checkout) !== path.resolve(root) }
  } catch {
    return undefined
  }
}

export const deleteBranch = (root: string, branch: string, force: boolean) =>
  run("git", ["-C", root, "branch", force ? "-D" : "-d", branch])

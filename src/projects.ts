import { readdir, stat } from "node:fs/promises"
import path from "node:path"

const exists = (file: string) => stat(file).then(() => true, () => false)

/** Git repositories that are immediate children of `home`, by folder name. */
export async function findProjects(home: string) {
  const entries = await readdir(home, { withFileTypes: true }).catch(() => [])
  const names = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => ((await exists(path.join(home, entry.name, ".git"))) ? entry.name : undefined)),
  )
  return names.filter((name): name is string => !!name).sort((a, b) => a.localeCompare(b))
}

/** Nearest ancestor of `directory` (inclusive) that contains `.git`. */
export async function gitRoot(directory: string) {
  let current = path.resolve(directory)
  while (true) {
    if (await exists(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Worktree-safe name: lowercase words joined by dashes. */
export function slug(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "worker"
  )
}

# opencode-orchestrator

An OpenCode plugin that keeps one long-lived **orchestrator** session. It spawns worker sessions, each in its own herdr space (and worktree, for repo work), and keeps a list of them. It does not track what the workers are doing.

Built to be the fixed destination for Scrawl/Hex captures: send a recording to the orchestrator, and it starts workers for the tasks.

> v0.3.0 is a slimmed-down release. Worker status tracking, the TUI sidebar, the `[Worker updates]` digest, close detection and `attach_worker` / `/attach` were removed. v0.2.3 is the last version with them: install `#v0.2.3` to get them back.

## How it works

- On startup, the plugin creates (or reuses) a session titled **Orchestrator** in `home`.
- The orchestrator gets these tools:
  - `orchestrator_projects` lists the git repos directly under `home` (also shown in the orchestrator's context)
  - `orchestrator_worker_spawn` starts a worker for an idea and sends it the task, always in the background:
    - **Project ideas** (`project`, optional `directory` inside it): creates a new `branch` off `develop`
      (`master` for `hotfix/` branches; falls back to `master`/`main` when there's no `develop`; `base`
      overrides). It opens the branch with `herdr worktree create` as a space nested under the repo's
      existing space, then attaches OpenCode to the new session in that space. `worktree: false` works in
      the checkout instead.
    - **Other ideas** (no `project`): a new herdr space in `home`, running a fresh OpenCode session.
    - The orchestrator picks the title (space label) and branch name itself, following the repo's
      convention (`feat/`, `fix/`, `chore/`, `docs/`, `hotfix/`; Jira keys stay uppercase).
    - Without herdr, project workers fall back to a headless OpenCode worktree.
    - `why` (required) is a sentence or two on where the request came from and what the user wants. It
      is pinned into the worker as a standing context entry (`orchestrator-origin`) together with the
      orchestrator session, project, branch, base, directory and herdr space, so the worker still knows
      why it exists after its first prompt is compacted away. Workers are asked to end their final
      message with `Outcome: <one line>`.
  - `orchestrator_worker_list` shows the list: one line per worker, `- title id [space] [branch]`
  - `orchestrator_worker_message` sends a follow-up (queued, or `steer` to interject)
  - `orchestrator_worker_close` closes a worker when you ask: removes its worktree and closes its herdr space, keeps the branch unless `branch: true`, and deletes the session only with `session: true`. It refuses a worktree with uncommitted changes; `force` is only for when you confirm. The worker is then dropped from the list, and the result says what is left (e.g. the branch and whether it is pushed) so the orchestrator can ask you about it.
  - `orchestrator_worker_forget` drops a worker from the list without closing anything
- The list changes only through spawn, join, close and forget. Closing a space or deleting a session by hand does not update it; use `orchestrator_worker_forget`.
- The list is attached to the orchestrator as a context entry (with the projects and naming guidance). It refreshes on every change and costs no extra turns.
- An `AGENTS.md` in `home` gives the orchestrator and non-repo idea spaces a map of the repos. Sessions
  inside a repo or a herdr worktree don't load it (OpenCode stops at the project root).
- `/orchestrator-worker-join [why]`, run inside any other session, adds that session to the list. It works from any folder. Its repo, branch, worktree and herdr space are read from the session's folder and pane. A session in a repo's main checkout is never linked to the repo's own herdr space, so closing it can't close that space.
- `/orchestrator-worker-close [branch] [session] [force]`, run inside a worker, closes it the same way `orchestrator_worker_close` does. If it has uncommitted changes (or something else fails), the worker is told what to do instead.
- `/orchestrator-pin` pins the current session as the orchestrator instead and prints the `scrawl send` command for it.
- If the orchestrator session is deleted, the plugin re-pins the most recently used other session in `home` (not a worker), or creates a new one, and posts a short note there.

Only the plugin instance whose location matches `home` is active. That way, installing the plugin globally doesn't create duplicate orchestrators.

Upgrading from v0.2.x: on first load the stored list drops closed workers and every status field, and the pending update digest is deleted.

## Install

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "github:marcus-jan/opencode-orchestrator#v0.3.0", "options": { "home": "/path/to/your/repos" } }
  ]
}
```

| Option   | Default                  | Description                                          |
| -------- | ------------------------ | ---------------------------------------------------- |
| `home`   | the plugin's location    | Directory the orchestrator session lives in          |
| `title`  | `"Orchestrator"`         | Title for the orchestrator session                   |
| `worktree` | `true`                 | Default to a fresh worktree for workers in a git project |
| `herdr`  | `$HERDR_BIN_PATH` or `~/.local/bin/herdr` | Herdr binary used to open worker spaces; `false` keeps workers headless |
| `model`  | the spawning session's model | Worker model as `providerID/modelID`. If it isn't available, workers use the spawning session's model (noted in the spawn result); with neither, the spawn fails instead of using OpenCode's free models |

The v0.2 options `notify` and `sweepSeconds` are ignored.

## Sending captures

```sh
scrawl send <bundle> --session <orchestrator-session-id>
```

## Development

```sh
bun install
bun run check
```

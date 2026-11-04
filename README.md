# opencode-orchestrator

An OpenCode plugin that keeps one long-lived **orchestrator** session. It spawns worker sessions and keeps track of their status. The orchestrator does not direct the work; it only records where each worker stands.

Built to be the fixed destination for Scrawl/Hex captures: send a recording to the orchestrator, and it starts workers for the tasks.

## How it works

- On startup, the plugin creates (or reuses) a session titled **Orchestrator** in `home`.
- The orchestrator gets these tools:
  - `list_projects` lists the git repos directly under `home` (also shown in the orchestrator's context)
  - `spawn_worker` starts a worker for an idea and sends it the task, always in the background:
    - **Project ideas** (`project`, optional `directory` inside it): creates a new `branch` off `develop`
      (`master` for `hotfix/` branches; falls back to `master`/`main` when there's no `develop`; `base`
      overrides). It opens the branch with `herdr worktree create` as a space nested under the repo's
      existing space, then attaches OpenCode to the new session in that space. `worktree: false` works in
      the checkout instead.
    - **Other ideas** (no `project`): a new herdr space in `home`, running a fresh OpenCode session.
    - The orchestrator picks the title (space label) and branch name itself, following the repo's
      convention (`feat/`, `fix/`, `chore/`, `docs/`, `hotfix/`; Jira keys stay uppercase).
    - Without herdr, project workers fall back to a headless OpenCode worktree.
    - Worktrees, spaces and branches are never removed automatically; only `close_worker` removes them.
    - `why` (required) is a sentence or two on where the request came from and what the user wants. It
      is pinned into the worker as a standing context entry (`orchestrator-origin`) together with the
      orchestrator session, project, branch, base, directory and herdr space, so the worker still knows
      why it exists after its first prompt is compacted away.
- An `AGENTS.md` in `home` gives the orchestrator and non-repo idea spaces a map of the repos. Sessions
  inside a repo or a herdr worktree don't load it (OpenCode stops at the project root).
  - `list_workers` shows the board
  - `message_worker` sends a follow-up (queued, or `steer` to interject)
  - `close_worker` cleans up a worker when you ask: removes its worktree and closes its herdr space, and optionally deletes its branch (`branch: true`) and session (`session: true`). Failures are reported; `force` is only for when you confirm
  - `attach_worker` starts tracking a session the orchestrator didn't spawn. Find it by session id, herdr space id or label (e.g. `w4K`), or words from its title. The repo, branch, worktree and herdr space are read from the session's folder and pane. Nothing new is created. If several sessions match, the orchestrator asks which one. `/attach <query>` does the same from the orchestrator's prompt.
  - `forget_worker` stops tracking a worker
- `/join-orchestrator [why]`, run inside any other session, asks the orchestrator to track that session. It works from any folder. The orchestrator gets a one-line note when the session is attached.
- Attached workers get the same `orchestrator-origin` context entry, status alerts, close detection, `close_worker` cleanup and sidebar row as spawned ones. A session in a repo's main checkout is never linked to the repo's own herdr space, so `close_worker` can't close that space.
- In the TUI, the orchestrator session's sidebar lists its open workers: a status marker, title, state, herdr space and age. Workers that need attention come first. Click a worker to open its session. Other sessions don't show the panel.
- The plugin watches server events and tracks each worker as `queued → running → done | failed | interrupted`. A worker waiting on a permission prompt or a question shows as `blocked`.
- Every `sweepSeconds` (and on `list_workers` or a deleted session) the plugin checks each worker's herdr space, worktree and session. If you closed any of them yourself, the worker becomes `closed` with a "closed manually" note. If something is left (an open space, a worktree on disk, the branch), the orchestrator is woken to ask whether to clean it up; otherwise it only gets a one-line note.
- The board is attached to the orchestrator as a context entry. It refreshes on every change and costs no extra turns.
- When a worker is `done`, `failed`, or `blocked`, the plugin queues a short synthetic note in the orchestrator without starting a turn.
- `/orchestrator` pins the current session as the orchestrator instead and prints the `scrawl send` command for it.
- If the orchestrator session is deleted, the plugin re-pins the most recently used other session in `home` (not a worker), or creates a new one, and posts a catch-up there with any alerts it could not deliver.

Only the plugin instance whose location matches `home` is active. That way, installing the plugin globally doesn't create duplicate trackers.

## Install

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "github:marcus-jan/opencode-orchestrator#v0.2.0", "options": { "home": "/path/to/your/repos" } }
  ]
}
```

| Option   | Default                  | Description                                          |
| -------- | ------------------------ | ---------------------------------------------------- |
| `home`   | the plugin's location    | Directory the orchestrator session lives in          |
| `title`  | `"Orchestrator"`         | Title for the orchestrator session                   |
| `notify` | `true`                   | Queue a note when a worker is done, failed, or blocked |
| `worktree` | `true`                 | Default to a fresh worktree for workers in a git project |
| `herdr`  | `$HERDR_BIN_PATH` or `~/.local/bin/herdr` | Herdr binary used to open worker spaces; `false` keeps workers headless |
| `model`  | the spawning session's model | Worker model as `providerID/modelID`. If it isn't available, workers use the spawning session's model (noted in the spawn result); with neither, the spawn fails instead of using OpenCode's free models |
| `sweepSeconds` | `60`             | How often to check for workers you closed by hand; `0` disables the timer |

## Sending captures

```sh
scrawl send <bundle> --session <orchestrator-session-id>
```

## Development

```sh
bun install
bun run check
```

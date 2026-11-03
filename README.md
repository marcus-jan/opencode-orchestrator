# opencode-orchestrator

An OpenCode plugin that keeps one long-lived **orchestrator** session. It spawns worker sessions and keeps track of their status. The orchestrator does not direct the work; it only records where each worker stands.

Built to be the fixed destination for Scrawl/Hex captures: send a recording to the orchestrator, and it starts workers for the tasks.

## How it works

- On startup, the plugin creates (or reuses) a session titled **Orchestrator** in `home`.
- The orchestrator gets these tools:
  - `spawn_worker` creates a session in any directory and sends it the task
  - `list_workers` shows the board
  - `message_worker` sends a follow-up (queued, or `steer` to interject)
  - `forget_worker` stops tracking a worker
- The plugin watches server events and tracks each worker as `queued → running → done | failed | interrupted`. A worker waiting on a permission prompt or a question shows as `blocked`.
- The board is attached to the orchestrator as a context entry. It refreshes on every change and costs no extra turns.
- When a worker is `done`, `failed`, or `blocked`, the plugin queues a short synthetic note in the orchestrator without starting a turn.
- `/orchestrator` pins the current session as the orchestrator instead and prints the `scrawl send` command for it.

Only the plugin instance whose location matches `home` is active. That way, installing the plugin globally doesn't create duplicate trackers.

## Install

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "/Volumes/Workspace/git/opencode-orchestrator", "options": { "home": "/Volumes/Workspace/git" } }
  ]
}
```

| Option   | Default                  | Description                                          |
| -------- | ------------------------ | ---------------------------------------------------- |
| `home`   | the plugin's location    | Directory the orchestrator session lives in          |
| `title`  | `"Orchestrator"`         | Title for the orchestrator session                   |
| `notify` | `true`                   | Queue a note when a worker is done, failed, or blocked |

## Sending captures

```sh
scrawl send <bundle> --session <orchestrator-session-id>
```

## Development

```sh
bun install
bun run check
```

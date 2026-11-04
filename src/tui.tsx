/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Orchestrator, type Snapshot } from "./rpc"
import { membership, view, type Tone } from "./sidebar"

export default Plugin.define({
  id: "orchestrator.tui",
  setup(context) {
    const rpc = () => context.client.rpc(Orchestrator)
    // Bumped whenever the server reports a worker change, and on a timer so ages stay fresh.
    const [version, setVersion] = createSignal(0)
    const bump = () => void setVersion((n) => n + 1)
    const stopChanged = rpc().events.on("changed", bump)
    const timer = setInterval(bump, 30_000)

    const color = (tone: Tone) =>
      tone === "muted" ? context.theme.text.muted : context.theme.text.feedback[tone].base

    const open = (sessionID: string) => {
      if (context.ui.tabs.enabled() && context.ui.tabs.focus(sessionID)) return
      context.ui.router.navigate({ type: "session", sessionID })
    }

    const Panel = (props: { sessionID: string }) => {
      const [snapshot, setSnapshot] = createSignal<Snapshot>()
      createEffect(() => {
        version()
        const sessionID = props.sessionID
        const location = context.data.session.get(sessionID)?.location
        let live = true
        onCleanup(() => (live = false))
        if (!location) return setSnapshot(undefined)
        // Instances outside the orchestrator's home answer with an empty board and the home
        // directory, so worker sessions ask the home instance whether they are tracked.
        const load = async () => {
          const local = (await rpc().snapshot({}, { location })) as Snapshot
          if (!local.home || local.home === location.directory) return local
          return (await rpc().snapshot({}, { location: { directory: local.home } })) as Snapshot
        }
        load()
          .then((result) => live && setSnapshot(result))
          .catch(() => live && setSnapshot(undefined))
      })
      const shown = () => {
        const current = snapshot()
        return current && current.orchestrator === props.sessionID ? view(current) : undefined
      }
      const member = () => {
        const current = snapshot()
        return current ? membership(current, props.sessionID) : undefined
      }
      const openOrchestrator = () => {
        const id = snapshot()?.orchestrator
        if (id) open(id)
      }
      return (
        <>
        <Show when={member()}>
          {(note) => (
            <box flexDirection="column" flexShrink={0} onMouseUp={openOrchestrator}>
              <text fg={context.theme.text.base}>
                <b>{note().heading}</b>
              </text>
              <text>
                <span style={{ fg: color(note().tone) }}>{note().marker} </span>
                <span style={{ fg: context.theme.text.muted }}>{note().meta}</span>
              </text>
            </box>
          )}
        </Show>
        <Show when={shown()}>
          {(board) => (
            <box flexDirection="column" flexShrink={0}>
              <text fg={context.theme.text.base}>
                <b>{board().heading}</b>
              </text>
              <For each={board().rows}>
                {(row) => (
                  <box flexDirection="column" onMouseUp={() => open(row.id)}>
                    <text>
                      <span style={{ fg: color(row.tone) }}>{row.marker} </span>
                      <span style={{ fg: context.theme.text.base }}>{row.title}</span>
                    </text>
                    <text fg={context.theme.text.muted}>{`  ${row.meta}`}</text>
                  </box>
                )}
              </For>
              <Show when={board().closed > 0}>
                <text fg={context.theme.text.muted}>{`${board().closed} closed`}</text>
              </Show>
            </box>
          )}
        </Show>
        </>
      )
    }

    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <Panel sessionID={props.sessionID} />,
    })

    return () => {
      stopChanged()
      clearInterval(timer)
    }
  },
})

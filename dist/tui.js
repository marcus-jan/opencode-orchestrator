// @bun
// src/tui.tsx
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, For, onCleanup, Show } from "opentui:runtime-module:solid-js";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var Orchestrator = Rpc.define({
  id: "orchestrator",
  methods: {
    snapshot: {
      input: {
        type: "object",
        additionalProperties: false
      },
      output: {
        type: "object"
      }
    }
  },
  events: {
    changed: {
      schema: {
        type: "object",
        additionalProperties: false
      }
    }
  }
});

// src/registry.ts
var ATTENTION_STATES = new Set(["failed", "blocked"]);
function formatAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60)
    return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60)
    return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// src/sidebar.ts
var LOOK = {
  blocked: {
    marker: "!",
    tone: "warning",
    rank: 0
  },
  failed: {
    marker: "\u2717",
    tone: "error",
    rank: 1
  },
  running: {
    marker: "\u25CF",
    tone: "info",
    rank: 2
  },
  queued: {
    marker: "\u25CB",
    tone: "info",
    rank: 3
  },
  done: {
    marker: "\u2713",
    tone: "success",
    rank: 4
  },
  interrupted: {
    marker: "\u25CC",
    tone: "muted",
    rank: 5
  },
  closed: {
    marker: "\xB7",
    tone: "muted",
    rank: 6
  },
  gone: {
    marker: "\xB7",
    tone: "muted",
    rank: 6
  }
};
var isOpen = (state) => state !== "closed" && state !== "gone";
function membership(snapshot, sessionID, now = Date.now()) {
  const worker = snapshot.workers.find((w) => w.id === sessionID);
  if (!worker || !isOpen(worker.state) || !snapshot.orchestrator)
    return;
  return {
    heading: worker.attached ? "Orchestrator \xB7 joined" : "Orchestrator \xB7 worker",
    marker: LOOK[worker.state].marker,
    tone: LOOK[worker.state].tone,
    meta: [worker.detail ? `${worker.state}: ${worker.detail}` : worker.state, worker.space, `${formatAge(now - worker.updated)} ago`].filter(Boolean).join(" \xB7 ")
  };
}
function view(snapshot, now = Date.now()) {
  const open = snapshot.workers.filter((w) => isOpen(w.state));
  const rows = open.toSorted((a, b) => LOOK[a.state].rank - LOOK[b.state].rank || b.updated - a.updated).map((w) => ({
    id: w.id,
    title: w.title,
    marker: LOOK[w.state].marker,
    tone: LOOK[w.state].tone,
    meta: [w.detail ? `${w.state}: ${w.detail}` : w.state, w.space, `${formatAge(now - w.updated)} ago`].filter(Boolean).join(" \xB7 ")
  }));
  const counts = new Map;
  for (const w of open)
    counts.set(w.state, (counts.get(w.state) ?? 0) + 1);
  const summary = [...counts].toSorted(([a], [b]) => LOOK[a].rank - LOOK[b].rank).map(([state, n]) => `${n} ${state}`).join(" \xB7 ");
  return {
    heading: summary ? `Workers \xB7 ${summary}` : "Workers \xB7 none open",
    rows,
    closed: snapshot.workers.length - open.length
  };
}

// src/tui.tsx
var tui_default = Plugin.define({
  id: "orchestrator.tui",
  setup(context) {
    const rpc = () => context.client.rpc(Orchestrator);
    const [version, setVersion] = createSignal(0);
    const bump = () => void setVersion((n) => n + 1);
    const stopChanged = rpc().events.on("changed", bump);
    const timer = setInterval(bump, 30000);
    const color = (tone) => tone === "muted" ? context.theme.text.muted : context.theme.text.feedback[tone].base;
    const open = (sessionID) => {
      if (context.ui.tabs.enabled() && context.ui.tabs.focus(sessionID))
        return;
      context.ui.router.navigate({
        type: "session",
        sessionID
      });
    };
    const Panel = (props) => {
      const [snapshot, setSnapshot] = createSignal();
      createEffect(() => {
        version();
        const sessionID = props.sessionID;
        const location = context.data.session.get(sessionID)?.location;
        let live = true;
        onCleanup(() => live = false);
        if (!location)
          return setSnapshot(undefined);
        const load = async () => {
          const local = await rpc().snapshot({}, {
            location
          });
          if (!local.home || local.home === location.directory)
            return local;
          return await rpc().snapshot({}, {
            location: {
              directory: local.home
            }
          });
        };
        load().then((result) => live && setSnapshot(result)).catch(() => live && setSnapshot(undefined));
      });
      const shown = () => {
        const current = snapshot();
        return current && current.orchestrator === props.sessionID ? view(current) : undefined;
      };
      const member = () => {
        const current = snapshot();
        return current ? membership(current, props.sessionID) : undefined;
      };
      const openOrchestrator = () => {
        const id = snapshot()?.orchestrator;
        if (id)
          open(id);
      };
      return [_$createComponent(Show, {
        get when() {
          return member();
        },
        children: (note) => (() => {
          var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("b"), _el$4 = _$createElement("text"), _el$5 = _$createElement("span"), _el$6 = _$createTextNode(` `), _el$7 = _$createElement("span");
          _$insertNode(_el$, _el$2);
          _$insertNode(_el$, _el$4);
          _$setProp(_el$, "flexDirection", "column");
          _$setProp(_el$, "flexShrink", 0);
          _$setProp(_el$, "onMouseUp", openOrchestrator);
          _$insertNode(_el$2, _el$3);
          _$insert(_el$3, () => note().heading);
          _$insertNode(_el$4, _el$5);
          _$insertNode(_el$4, _el$7);
          _$insertNode(_el$5, _el$6);
          _$insert(_el$5, () => note().marker, _el$6);
          _$insert(_el$7, () => note().meta);
          _$effect((_p$) => {
            var _v$ = context.theme.text.base, _v$2 = {
              fg: color(note().tone)
            }, _v$3 = {
              fg: context.theme.text.muted
            };
            _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
            _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "style", _v$2, _p$.t));
            _v$3 !== _p$.a && (_p$.a = _$setProp(_el$7, "style", _v$3, _p$.a));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined
          });
          return _el$;
        })()
      }), _$createComponent(Show, {
        get when() {
          return shown();
        },
        children: (board) => (() => {
          var _el$8 = _$createElement("box"), _el$9 = _$createElement("text"), _el$0 = _$createElement("b");
          _$insertNode(_el$8, _el$9);
          _$setProp(_el$8, "flexDirection", "column");
          _$setProp(_el$8, "flexShrink", 0);
          _$insertNode(_el$9, _el$0);
          _$insert(_el$0, () => board().heading);
          _$insert(_el$8, _$createComponent(For, {
            get each() {
              return board().rows;
            },
            children: (row) => (() => {
              var _el$10 = _$createElement("box"), _el$11 = _$createElement("text"), _el$12 = _$createElement("span"), _el$13 = _$createTextNode(` `), _el$14 = _$createElement("span"), _el$15 = _$createElement("text");
              _$insertNode(_el$10, _el$11);
              _$insertNode(_el$10, _el$15);
              _$setProp(_el$10, "flexDirection", "column");
              _$setProp(_el$10, "onMouseUp", () => open(row.id));
              _$insertNode(_el$11, _el$12);
              _$insertNode(_el$11, _el$14);
              _$insertNode(_el$12, _el$13);
              _$insert(_el$12, () => row.marker, _el$13);
              _$insert(_el$14, () => row.title);
              _$insert(_el$15, () => `  ${row.meta}`);
              _$effect((_p$) => {
                var _v$4 = {
                  fg: color(row.tone)
                }, _v$5 = {
                  fg: context.theme.text.base
                }, _v$6 = context.theme.text.muted;
                _v$4 !== _p$.e && (_p$.e = _$setProp(_el$12, "style", _v$4, _p$.e));
                _v$5 !== _p$.t && (_p$.t = _$setProp(_el$14, "style", _v$5, _p$.t));
                _v$6 !== _p$.a && (_p$.a = _$setProp(_el$15, "fg", _v$6, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$10;
            })()
          }), null);
          _$insert(_el$8, _$createComponent(Show, {
            get when() {
              return board().closed > 0;
            },
            get children() {
              var _el$1 = _$createElement("text");
              _$insert(_el$1, () => `${board().closed} closed`);
              _$effect((_$p) => _$setProp(_el$1, "fg", context.theme.text.muted, _$p));
              return _el$1;
            }
          }), null);
          _$effect((_$p) => _$setProp(_el$9, "fg", context.theme.text.base, _$p));
          return _el$8;
        })()
      })];
    };
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => _$createComponent(Panel, {
        get sessionID() {
          return props.sessionID;
        }
      })
    });
    return () => {
      stopChanged();
      clearInterval(timer);
    };
  }
});
export {
  tui_default as default
};

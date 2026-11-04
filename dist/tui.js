// @bun
// src/tui.tsx
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
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
var NOTIFY_STATES = new Set(["done", "failed", "blocked"]);
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
        rpc().snapshot({}, {
          location
        }).then((result) => live && setSnapshot(result)).catch(() => live && setSnapshot(undefined));
      });
      const shown = () => {
        const current = snapshot();
        return current && current.orchestrator === props.sessionID ? view(current) : undefined;
      };
      return _$createComponent(Show, {
        get when() {
          return shown();
        },
        children: (board) => (() => {
          var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("b");
          _$insertNode(_el$, _el$2);
          _$setProp(_el$, "flexDirection", "column");
          _$setProp(_el$, "flexShrink", 0);
          _$insertNode(_el$2, _el$3);
          _$insert(_el$3, () => board().heading);
          _$insert(_el$, _$createComponent(For, {
            get each() {
              return board().rows;
            },
            children: (row) => (() => {
              var _el$5 = _$createElement("box"), _el$6 = _$createElement("text"), _el$7 = _$createElement("span"), _el$8 = _$createTextNode(` `), _el$9 = _$createElement("span"), _el$0 = _$createElement("text");
              _$insertNode(_el$5, _el$6);
              _$insertNode(_el$5, _el$0);
              _$setProp(_el$5, "flexDirection", "column");
              _$setProp(_el$5, "onMouseUp", () => open(row.id));
              _$insertNode(_el$6, _el$7);
              _$insertNode(_el$6, _el$9);
              _$insertNode(_el$7, _el$8);
              _$insert(_el$7, () => row.marker, _el$8);
              _$insert(_el$9, () => row.title);
              _$insert(_el$0, () => `  ${row.meta}`);
              _$effect((_p$) => {
                var _v$ = {
                  fg: color(row.tone)
                }, _v$2 = {
                  fg: context.theme.text.base
                }, _v$3 = context.theme.text.muted;
                _v$ !== _p$.e && (_p$.e = _$setProp(_el$7, "style", _v$, _p$.e));
                _v$2 !== _p$.t && (_p$.t = _$setProp(_el$9, "style", _v$2, _p$.t));
                _v$3 !== _p$.a && (_p$.a = _$setProp(_el$0, "fg", _v$3, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$5;
            })()
          }), null);
          _$insert(_el$, _$createComponent(Show, {
            get when() {
              return board().closed > 0;
            },
            get children() {
              var _el$4 = _$createElement("text");
              _$insert(_el$4, () => `${board().closed} closed`);
              _$effect((_$p) => _$setProp(_el$4, "fg", context.theme.text.muted, _$p));
              return _el$4;
            }
          }), null);
          _$effect((_$p) => _$setProp(_el$2, "fg", context.theme.text.base, _$p));
          return _el$;
        })()
      });
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

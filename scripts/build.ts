import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"

// Installed TSX can resolve a private Solid copy before the host rewrites its
// imports. Compile JSX ahead of time and bind both reactivity and rendering to
// OpenTUI's host-provided runtime modules, never to bundled or installed copies.
const runtimeModules = new Set(["solid-js", "solid-js/store", "@opentui/solid"])
const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  packages: "external",
  external: ["opentui:runtime-module:*"],
  plugins: [createSolidTransformPlugin({
    moduleName: runtimeModuleIdForSpecifier("@opentui/solid"),
    resolvePath: (specifier) => runtimeModules.has(specifier) ? runtimeModuleIdForSpecifier(specifier) : null,
  })],
})
if (!result.success) throw new AggregateError(result.logs, "Could not build the TUI plugin")

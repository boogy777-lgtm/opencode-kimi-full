import type { Plugin as V2TuiPlugin } from "@opencode/plugin/tui"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

// Dual TUI entrypoint. V1.18.x reads `tui`; OpenCode 2 reads `id` + `setup`.
// Each implementation is imported lazily so neither API loads the other's
// runtime dependencies.
export default {
  id: "opencode-kimi-full-usage",
  tui: (async (api, options, meta) => {
    const legacy = await import("./tui-v1.tsx")
    return legacy.default.tui(api, options, meta)
  }) satisfies TuiPlugin,
  async setup(context: V2TuiPlugin.Context): Promise<V2TuiPlugin.Cleanup | void> {
    const v2 = await import("./tui-v2.tsx")
    return v2.setup(context)
  },
} satisfies TuiPluginModule & Pick<V2TuiPlugin.Definition, "id" | "setup">

/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid"
import { createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { KimiRpc } from "./rpc.ts"
import type { UsageRow } from "./usage.ts"

type UsageViewRow = UsageRow & {
  remaining: number
  percent: number
  ratio: number
}

const BAR_WIDTH = 56

function usageViewRow(row: UsageRow): UsageViewRow {
  if (row.limit <= 0) {
    return { ...row, remaining: 0, percent: 0, ratio: 0 }
  }
  const remaining = Math.min(Math.max(row.limit - row.used, 0), row.limit)
  const ratio = remaining / row.limit
  return {
    ...row,
    remaining,
    ratio,
    percent: Math.round(ratio * 100),
  }
}

function usageTone(context: Plugin.Context, row: UsageViewRow) {
  if (row.ratio <= 0.1) return context.theme.text.feedback.error.base
  if (row.ratio <= 0.3) return context.theme.text.feedback.warning.base
  return context.theme.text.action.primary.base
}

function usageBar(row: UsageViewRow) {
  const complete = Math.round(row.ratio * BAR_WIDTH)
  return {
    complete: "█".repeat(complete),
    empty: "░".repeat(BAR_WIDTH - complete),
  }
}

function UsageLoadingRow(props: { context: Plugin.Context; label: string }): JSX.Element {
  return (
    <box gap={0} width="100%">
      <text fg={props.context.theme.text.base}>{props.label}</text>
      <box flexDirection="row" width="100%" overflow="hidden">
        <text fg={props.context.theme.text.muted} wrapMode="none" overflow="hidden">
          {"░".repeat(BAR_WIDTH)}
        </text>
      </box>
      <box flexDirection="row" width="100%">
        <text fg={props.context.theme.text.muted}>loading</text>
      </box>
    </box>
  )
}

function UsageDialog(props: {
  context: Plugin.Context
  rows: () => UsageRow[] | undefined
  loading: () => boolean
}): JSX.Element {
  const theme = props.context.theme
  const rows = () => (props.rows() ?? []).map(usageViewRow)

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <span style={{ fg: theme.text.base, bold: true }}>Kimi Usage</span>
        </text>
        <text fg={theme.text.muted}>esc</text>
      </box>

      {props.loading() ? (
        <box gap={1} paddingBottom={1}>
          <UsageLoadingRow context={props.context} label="Weekly limit" />
          <UsageLoadingRow context={props.context} label="5h limit" />
        </box>
      ) : rows().length === 0 ? (
        <box paddingTop={1} paddingBottom={1}>
          <text fg={theme.text.muted}>No usage data available.</text>
        </box>
      ) : (
        <box gap={1} paddingBottom={1}>
          {rows().map((row) => {
            const tone = usageTone(props.context, row)
            const bar = usageBar(row)
            return (
              <box gap={0} width="100%">
                <text fg={theme.text.base}>{row.label}</text>
                <box flexDirection="row" width="100%" overflow="hidden">
                  <text fg={tone} wrapMode="none" overflow="hidden">
                    {bar.complete}
                  </text>
                  <text fg={theme.text.muted} wrapMode="none" overflow="hidden">
                    {bar.empty}
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between" width="100%">
                  <text fg={theme.text.muted}>{row.resetHint ?? ""}</text>
                  <text fg={tone}>{row.percent}% left</text>
                </box>
              </box>
            )
          })}
        </box>
      )}
    </box>
  )
}

export async function setup(context: Plugin.Context) {
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "kimi.usage",
        title: "Kimi usage",
        description: "Show Kimi Code subscription usage",
        group: "Kimi",
        palette: true,
        slash: { name: "kimi:usage" },
        run: async () => {
          const [rows, setRows] = createSignal<UsageRow[]>()
          const [loading, setLoading] = createSignal(true)

          context.ui.dialog.set({ size: "medium" })
          context.ui.dialog.show(() => (
            <UsageDialog context={context} rows={rows} loading={loading} />
          ))

          try {
            // The TUI client exposes the typed RPC subclient at runtime; the
            // structural type is narrowed here so the plugin does not depend on
            // a second generated client type in the TUI bundle.
            const rpc = context.client as unknown as {
              rpc(definition: typeof KimiRpc): {
                usage(input?: unknown): Promise<{ rows: UsageRow[] }>
              }
            }
            const result = await rpc.rpc(KimiRpc).usage(undefined)
            setRows(result.rows)
          } catch (error) {
            context.ui.dialog.clear()
            context.ui.toast.show({
              title: "Kimi usage",
              message: error instanceof Error ? error.message : "Failed to fetch Kimi usage.",
              variant: "error",
              duration: 6_000,
            })
          } finally {
            setLoading(false)
          }
        },
      },
    ],
  }))
}

export default Plugin.define({
  id: "opencode-kimi-full-usage",
  setup,
})

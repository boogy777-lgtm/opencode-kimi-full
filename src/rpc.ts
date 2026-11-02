import { Rpc } from "@opencode/plugin/rpc"

const usageInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const usageOutput = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          used: { type: "number" },
          limit: { type: "number" },
          resetHint: { type: "string" },
        },
        required: ["label", "used", "limit"],
        additionalProperties: false,
      },
    },
  },
  required: ["rows"],
  additionalProperties: false,
} as const

/**
 * Server -> TUI contract for the `/kimi:usage` dialog. The server part owns
 * the credential and the HTTP call; the TUI only renders the rows.
 */
export const KimiRpc = Rpc.define({
  id: "kimi",
  events: {},
  methods: {
    usage: {
      input: usageInput,
      output: usageOutput,
    },
  },
})

import type { KimiModelInfo } from "./oauth.ts"

export type KimiThinking = { type: "enabled" | "disabled" }

export type KimiBodyFields = {
  prompt_cache_key?: string
  thinking?: KimiThinking
  reasoning_effort?: string
}

// Effort tiers are server-driven: `think_efforts.valid_efforts` in the
// discovery payload is the authoritative capability statement (kimi-cli
// predates this field and clamps max→high for K2.7; models that carry the
// field — e.g. k3, k3-256k — advertise `max` explicitly). When the server
// says nothing, clamp conservatively: an unsupported effort value fails the
// request upstream, so a silent downgrade is the only safe default.
export function clampEffort(
  effort: string,
  info: Pick<KimiModelInfo, "think_efforts"> | undefined,
): string | undefined {
  let result = effort
  if (result === "xhigh") result = "high"
  if (result === "max" && !info?.think_efforts?.valid_efforts?.includes("max")) result = "high"
  // When the server enumerates its tiers they are authoritative: an effort it
  // did not advertise would fail the request upstream, so it is omitted and
  // the server applies its advertised default_effort instead.
  const valid = info?.think_efforts?.valid_efforts
  if (valid?.length && result !== "auto" && result !== "off" && !valid.includes(result)) return undefined
  return result
}

/**
 * Resolves the Kimi-specific request body fields for one request.
 *
 * `effort` is the raw variant/model option (`low`/`high`/`max`/`off`/`auto`),
 * and `thinking` is an explicit user override when the variant carries one.
 * Both V1 (`chat.params`/`chat.headers`) and V2 (`http.request`) call this so
 * the wire contract cannot drift between plugin APIs.
 */
export function resolveKimiFields(input: {
  info: Pick<KimiModelInfo, "supports_reasoning" | "supports_thinking_type" | "think_efforts"> | undefined
  sessionID: string
  effort?: string
  thinking?: KimiThinking
}): KimiBodyFields {
  const fields: KimiBodyFields = { prompt_cache_key: input.sessionID }
  // A model the server marked non-reasoning must not receive thinking or
  // reasoning_effort — upstream rejects them (kimi-cli gates its "thinking"
  // capability on the same supports_reasoning flag). prompt_cache_key stays:
  // it is a cache hint, not a reasoning control.
  if (input.info?.supports_reasoning === false) return fields
  const effort = input.effort ? clampEffort(input.effort, input.info) : undefined

  // supports_thinking_type: "only" — thinking is mandatory for these models
  // (all current Kimi Code models advertise it). Never send "disabled", and
  // never leave thinking implicit: a user who forgets to pick a variant (or
  // picks off/auto) still gets thinking enabled; the server applies its
  // advertised default_effort.
  if (input.info?.supports_thinking_type === "only") {
    fields.thinking = { type: "enabled" }
    if (effort && effort !== "off" && effort !== "auto") fields.reasoning_effort = effort
    return fields
  }

  if (effort === "auto") return fields
  if (effort === "off") {
    fields.thinking = { type: "disabled" }
    return fields
  }
  if (effort) fields.reasoning_effort = effort
  fields.thinking = input.thinking ?? { type: "enabled" }
  return fields
}

export function applyKimiBodyFields(target: Record<string, unknown>, fields: KimiBodyFields) {
  target.prompt_cache_key = fields.prompt_cache_key
  if (fields.reasoning_effort) {
    target.reasoning_effort = fields.reasoning_effort
  } else {
    delete target.reasoning_effort
  }
  delete target.reasoningEffort
  if (fields.thinking) {
    target.thinking = fields.thinking
    return
  }
  delete target.thinking
}

export function hasKimiBodyFields(fields: KimiBodyFields) {
  return Boolean(fields.prompt_cache_key || fields.reasoning_effort || fields.thinking)
}

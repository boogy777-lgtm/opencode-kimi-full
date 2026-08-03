import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { isAuthExpiring, refreshAuthWithLock } from "./auth-refresh.ts"
import { isOAuthAuth, readAuth, type OAuthAuth } from "./auth-store.ts"
import {
  API_BASE_URL,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_OUTPUT_LIMIT,
  FALLBACK_MODEL_IDS,
  FALLBACK_MODELS,
  MAX_REASONING_MODEL_IDS,
  MODEL_ID,
  PROVIDER_ID,
} from "./constants.ts"
import { kimiHeaders } from "./headers.ts"
import { type KimiModelInfo, listModels, pollDeviceToken, startDeviceAuth } from "./oauth.ts"

// IMPORTANT: this module must have exactly ONE export — the default
// PluginModule object. opencode's plugin loader detects the v1 format
// ({ id, server }) via readV1Plugin *before* falling back to
// getLegacyPlugins — which iterates every export and throws "Plugin export
// is not a function" on any non-callable value. The v1 path is more
// reliable on Windows where Bun standalone dynamic imports can produce
// module namespace objects with unexpected non-function metadata.
// Keep constants in constants.ts and import them here.

type ModelDiscovery = {
  models?: KimiModelInfo[]
}

// Per-model metadata extracted from the discovery response for the loader's
// wire model rewriting and the printed config hint.
type SingleModelDiscovery = {
  model_id?: string
  context_length?: number
  model_display?: string
  supports_image_in?: boolean
  supports_video_in?: boolean
}

type ThinkingType = "enabled" | "disabled"

type KimiBodyFields = {
  prompt_cache_key?: string
  thinking?: { type: ThinkingType }
  reasoning_effort?: string
}

type ModelWithDiscoveryMetadata = {
  name?: string
  attachment?: boolean
  limit?: {
    context?: number
  }
  modalities?: {
    input?: string[]
    output?: string[]
  }
  capabilities?: {
    attachment?: boolean
    input?: {
      image?: boolean
    }
  }
}

type KimiHookInput = {
  sessionID: string
  model: {
    providerID: string
    id: string
    options?: Record<string, unknown>
    variants?: Record<string, Record<string, unknown>>
  }
  message: {
    model: {
      variant?: string
    }
  }
}

const INTERNAL_PROMPT_CACHE_KEY_HEADER = "x-opencode-kimi-prompt-cache-key"
const INTERNAL_REASONING_EFFORT_HEADER = "x-opencode-kimi-reasoning-effort"
const INTERNAL_THINKING_TYPE_HEADER = "x-opencode-kimi-thinking-type"
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function asThinking(value: unknown): KimiBodyFields["thinking"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const type = (value as { type?: unknown }).type
  if (type !== "enabled" && type !== "disabled") return
  return { type }
}

function pickEffort(options: Record<string, unknown> | undefined) {
  const effort = options?.reasoning_effort ?? options?.reasoningEffort
  return typeof effort === "string" ? effort : undefined
}

function isKimiModel(modelId: string, known: ReadonlySet<string>): boolean {
  return modelId === MODEL_ID || known.has(modelId)
}

// The known set is the server-discovered list plus the static cold-start
// fallback. Once discovery succeeds in this process its ids are authoritative
// (kimi-cli keeps no static list at all); the fallback only covers the window
// before the first discovery.
function knownModelIds(discovery: ModelDiscovery): ReadonlySet<string> {
  return new Set([...FALLBACK_MODEL_IDS, ...(discovery.models?.map((m) => m.id) ?? [])])
}

function supportsMaxReasoning(modelId: string): boolean {
  return (MAX_REASONING_MODEL_IDS as readonly string[]).includes(modelId)
}

// kimi-cli clamps xhigh to "high" for all current Kimi Code models and also
// clamps max to "high" for K2.7 models. K3 (model id "k3") keeps max as-is
// because Kimi's backend supports it for the flagship model.
function clampEffort(effort: string, modelId: string): string {
  if (effort === "xhigh") return "high"
  if (effort === "max" && !supportsMaxReasoning(modelId)) return "high"
  return effort
}

function resolveKimiBodyFields(input: KimiHookInput, known: ReadonlySet<string>): KimiBodyFields | undefined {
  if (input.model.providerID !== PROVIDER_ID) return
  if (!isKimiModel(input.model.id, known)) return

  const modelOptions = asRecord(input.model.options)
  const variantOptions = input.message.model.variant
    ? asRecord(input.model.variants?.[input.message.model.variant])
    : undefined

  const fields: KimiBodyFields = { prompt_cache_key: input.sessionID }
  const thinking = asThinking(variantOptions?.thinking) ?? asThinking(modelOptions?.thinking)
  const rawEffort = pickEffort(variantOptions) ?? pickEffort(modelOptions)
  const effort = rawEffort ? clampEffort(rawEffort, input.model.id) : undefined

  if (effort === "auto") return fields
  if (effort === "off") {
    fields.thinking = { type: "disabled" }
    return fields
  }
  if (effort) fields.reasoning_effort = effort
  fields.thinking = thinking ?? { type: "enabled" }
  return fields
}

function applyKimiBodyFields(target: Record<string, unknown>, fields: KimiBodyFields) {
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

function consumeInternalKimiBodyFields(headers: Headers): KimiBodyFields {
  const fields: KimiBodyFields = {}
  const promptCacheKey = headers.get(INTERNAL_PROMPT_CACHE_KEY_HEADER)
  if (promptCacheKey) fields.prompt_cache_key = promptCacheKey
  const reasoningEffort = headers.get(INTERNAL_REASONING_EFFORT_HEADER)
  if (reasoningEffort) fields.reasoning_effort = reasoningEffort
  const thinkingType = headers.get(INTERNAL_THINKING_TYPE_HEADER)
  if (thinkingType === "enabled" || thinkingType === "disabled") {
    fields.thinking = { type: thinkingType }
  }
  headers.delete(INTERNAL_PROMPT_CACHE_KEY_HEADER)
  headers.delete(INTERNAL_REASONING_EFFORT_HEADER)
  headers.delete(INTERNAL_THINKING_TYPE_HEADER)
  return fields
}

function hasKimiBodyFields(fields: KimiBodyFields) {
  return Boolean(fields.prompt_cache_key || fields.reasoning_effort || fields.thinking)
}

function withDiscoveredContext<T extends ModelWithDiscoveryMetadata>(model: T, contextLength: number | undefined): T {
  if (!contextLength || contextLength <= 0) return model
  if ((model.limit?.context ?? 0) > 0) return model
  return {
    ...model,
    limit: {
      ...model.limit,
      context: contextLength,
    },
  }
}

function withDiscoveredDisplayName<T extends ModelWithDiscoveryMetadata>(model: T, displayName: string | undefined): T {
  if (!displayName || model.name === displayName) return model
  return {
    ...model,
    name: displayName,
  }
}

function sameStrings(left: string[] | undefined, right: string[] | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function withDiscoveredMediaInput<T extends ModelWithDiscoveryMetadata>(
  model: T,
  supportsImageIn: boolean | undefined,
  supportsVideoIn: boolean | undefined,
): T {
  if (supportsImageIn === undefined && supportsVideoIn === undefined) return model

  let changed = false
  let nextAttachment = model.attachment
  let nextModalities = model.modalities
  let nextCapabilities = model.capabilities

  if (supportsImageIn && model.attachment !== true) {
    nextAttachment = true
    changed = true
  }

  const currentInputModalities = model.modalities?.input
  const currentOutputModalities = model.modalities?.output
  const shouldPatchModalities =
    supportsImageIn || supportsVideoIn ||
    currentInputModalities?.includes("image") === true ||
    currentInputModalities?.includes("video") === true
  if (shouldPatchModalities) {
    const nextInputModalities = uniqueStrings([
      "text",
      ...(currentInputModalities ?? []),
      ...(supportsImageIn ? ["image"] : []),
      ...(supportsVideoIn ? ["video"] : []),
    ])
      .filter((value) => value !== "image" || supportsImageIn)
      .filter((value) => value !== "video" || supportsVideoIn)
    const nextOutputModalities = uniqueStrings(["text", ...(currentOutputModalities ?? [])])
    if (
      !sameStrings(currentInputModalities, nextInputModalities) ||
      !sameStrings(currentOutputModalities, nextOutputModalities)
    ) {
      nextModalities = {
        ...model.modalities,
        input: nextInputModalities,
        output: nextOutputModalities,
      }
      changed = true
    }
  }

  const currentCapabilityImage = model.capabilities?.input?.image
  const currentCapabilityAttachment = model.capabilities?.attachment
  if (currentCapabilityImage !== undefined && currentCapabilityImage !== supportsImageIn) {
    nextCapabilities = {
      ...nextCapabilities,
      input: {
        ...nextCapabilities?.input,
        image: supportsImageIn,
      },
    }
    changed = true
  }
  if (supportsImageIn && currentCapabilityAttachment !== undefined && currentCapabilityAttachment !== true) {
    nextCapabilities = {
      ...nextCapabilities,
      attachment: true,
    }
    changed = true
  }

  if (!changed) return model
  return {
    ...model,
    ...(nextAttachment === undefined ? {} : { attachment: nextAttachment }),
    ...(nextModalities ? { modalities: nextModalities } : {}),
    ...(nextCapabilities ? { capabilities: nextCapabilities } : {}),
  }
}

function prettifyModelId(modelId: string): string {
  return modelId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
}

// Server-reported context length wins; then the fallback table; then the
// K2.7-generation default. Mirrors kimi-cli, which trusts `context_length`
// from `/models` unconditionally.
function contextLengthFor(model: { id: string; context_length?: number }): number {
  if (model.context_length && model.context_length > 0) return model.context_length
  return FALLBACK_MODELS.find((m) => m.id === model.id)?.context_length ?? DEFAULT_CONTEXT_LENGTH
}

function effortVariants(): Record<string, Record<string, unknown>> {
  return {
    off: { reasoning_effort: "off" },
    auto: { reasoning_effort: "auto" },
    low: { reasoning_effort: "low" },
    medium: { reasoning_effort: "medium" },
    high: { reasoning_effort: "high" },
    max: { reasoning_effort: "max" },
  }
}

// Full runtime model entry for a server-discovered model that is missing from
// the user's config. Shape mirrors what opencode core synthesizes for
// dynamically discovered models (see the gitlab `discoverModels` loader in
// research/opencode/packages/opencode/src/provider/provider.ts).
function buildRuntimeModel(discovered: KimiModelInfo): Record<string, unknown> {
  const supportsImageIn = discovered.supports_image_in ?? true
  const supportsVideoIn = discovered.supports_video_in ?? false
  return {
    api: { id: discovered.id, url: API_BASE_URL, npm: "@ai-sdk/openai-compatible" },
    name: discovered.display_name ?? prettifyModelId(discovered.id),
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: contextLengthFor(discovered), output: DEFAULT_OUTPUT_LIMIT },
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: supportsImageIn,
      toolcall: true,
      input: { text: true, audio: false, image: supportsImageIn, video: supportsVideoIn, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: effortVariants(),
  }
}

function applyDiscoveryToModels<T extends Record<string, ModelWithDiscoveryMetadata>>(
  models: T,
  discovery: KimiModelInfo[],
  known: ReadonlySet<string>,
): T {
  let changed = false
  const nextModels = { ...models } as T
  for (const [modelId, model] of Object.entries(models)) {
    if (!isKimiModel(modelId, known)) continue
    const discovered = discovery.find((m) => m.id === modelId)
    if (!discovered) continue
    const next = withDiscoveredMediaInput(
      withDiscoveredContext(withDiscoveredDisplayName(model, discovered.display_name), discovered.context_length),
      discovered.supports_image_in,
      discovered.supports_video_in,
    )
    if (next === model) continue
    ;(nextModels as Record<string, ModelWithDiscoveryMetadata>)[modelId] = next
    changed = true
  }
  // kimi-cli's `_apply_models` materializes every server-returned model; do
  // the same so newly released Kimi Code models appear without a config edit.
  for (const discovered of discovery) {
    if (nextModels[discovered.id]) continue
    ;(nextModels as Record<string, unknown>)[discovered.id] = buildRuntimeModel(discovered)
    changed = true
  }
  return changed ? nextModels : models
}

function buildModelConfig(
  name: string,
  contextLength: number,
  supportsImageIn: boolean,
  supportsVideoIn: boolean,
): Record<string, unknown> {
  const modelConfig: Record<string, unknown> = {
    name,
    reasoning: true,
    limit: { context: contextLength, output: DEFAULT_OUTPUT_LIMIT },
    options: {},
    variants: effortVariants(),
  }
  if (supportsImageIn) {
    // opencode's provider transform gates image parts on model metadata
    // before the request reaches our loader. Mirror Kimi's discovered
    // capability here so pasted images survive into the upstream SDK.
    modelConfig.attachment = true
    const inputModalities = ["text", "image"]
    if (supportsVideoIn) inputModalities.push("video")
    modelConfig.modalities = {
      input: inputModalities,
      output: ["text"],
    }
  }
  return modelConfig
}

function configModelEntry(model: { id: string; display_name?: string; context_length?: number; supports_image_in?: boolean; supports_video_in?: boolean }) {
  // Fall back to image=true because all current Kimi Code models support
  // image input; video only when the server explicitly says so.
  return buildModelConfig(
    model.display_name ?? prettifyModelId(model.id),
    contextLengthFor(model),
    model.supports_image_in ?? true,
    model.supports_video_in ?? false,
  )
}

function buildConfigBlock(models: KimiModelInfo[]) {
  return JSON.stringify(
    {
      provider: {
        [PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Kimi For Coding (OAuth)",
          options: { baseURL: API_BASE_URL },
          models: Object.fromEntries(models.map((model) => [model.id, configModelEntry(model)])),
        },
      },
    },
    null,
    2,
  )
}

type ConfigProviderEntry = {
  npm?: string
  name?: string
  options?: Record<string, unknown>
  models?: Record<string, Record<string, unknown>>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

// User config wins on conflicts; objects merge recursively so a user who
// overrides only `variants.high` keeps the generated `limit`/`modalities`.
function mergeModelConfig(generated: Record<string, unknown>, user: Record<string, unknown>): Record<string, unknown> {
  const out = { ...generated }
  for (const [key, value] of Object.entries(user)) {
    const base = out[key]
    out[key] = isPlainObject(base) && isPlainObject(value) ? mergeModelConfig(base, value) : value
  }
  return out
}

// Inject the provider entry and its model list into opencode's config before
// providers initialize (same mechanism opencode-qwencode-auth uses). Model
// set is server-discovered when possible, the static fallback otherwise.
// kimi-cli's `_apply_models` treats `/models` as the full truth — union
// semantics here gives the same "new models appear at startup" behavior while
// never deleting entries the user wrote themselves.
function upsertProviderConfig(input: { provider?: Record<string, ConfigProviderEntry> }, models: ReadonlyArray<KimiModelInfo>) {
  input.provider ??= {}
  const provider = (input.provider[PROVIDER_ID] ??= {})
  provider.npm ??= "@ai-sdk/openai-compatible"
  provider.name ??= "Kimi For Coding (OAuth)"
  provider.options = { baseURL: API_BASE_URL, ...provider.options }
  provider.models ??= {}
  for (const model of models) {
    const generated = configModelEntry(model)
    const existing = provider.models[model.id]
    provider.models[model.id] = isPlainObject(existing) ? mergeModelConfig(generated, existing) : generated
  }
}

/**
 * Plugin entry point.
 *
 * Responsibilities, in order of execution:
 *   1. `auth`    — register device-flow OAuth login under the
 *                  `kimi-for-coding-oauth` provider id. opencode persists the returned tokens in its
 *                  own auth.json; the plugin also live-reads that file so
 *                  workspace auth snapshots do not strand stale refresh
 *                  tokens.
 *   2. `loader`  — runs every time opencode instantiates the provider. Returns
 *                  a custom `fetch` that (a) refreshes the access token when
 *                  it is about to expire, (b) injects the seven X-Msh-* / UA
 *                  headers on every upstream call (models list, chat, etc.),
 *                  (c) lazily discovers the current wire model id from
 *                  `GET /coding/v1/models`, and (d) retries once with a forced
 *                  refresh on 401.
 *   3. `config`  — startup model sync: fetches `/coding/v1/models` with the
 *                  stored token and injects the provider entry + full model
 *                  list into opencode's config, so newly released Kimi Code
 *                  models appear in the picker without a plugin update or a
 *                  manual config block (mirrors kimi-cli's background
 *                  `refresh_managed_models`).
 *   4. `provider.models` — patches opencode's runtime model metadata
 *                  (`context_length`, `display_name`, media capabilities)
 *                  from the same discovery and materializes discovered models
 *                  missing from the config.
 *   5. `chat.headers` — computes the Kimi-specific request body fields the
 *                  model actually needs (`thinking.type`,
 *                  `reasoning_effort`, `prompt_cache_key`) and passes them to
 *                  `loader.fetch` via private headers.
 *   6. `chat.params` — mirrors the same fields into `output.options` for
 *                  forward-compat if opencode fixes its current
 *                  openai-compatible providerOptions namespace mismatch.
 */
const plugin: Plugin = async ({ client }) => {
  // --- helpers ---------------------------------------------------------------

  let cachedDiscovery: ModelDiscovery = {}
  let refreshPromise: Promise<OAuthAuth> | undefined

  const syncProcessAuthContent = (auth: OAuthAuth) => {
    if (!process.env.OPENCODE_AUTH_CONTENT) return
    try {
      const parsed = JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
      delete parsed[`${PROVIDER_ID}/`]
      parsed[PROVIDER_ID] = auth
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(parsed)
    } catch {}
  }

  const persistAuth = async (auth: OAuthAuth) => {
    await client.auth.set({ path: { id: PROVIDER_ID }, body: auth })
    syncProcessAuthContent(auth)
  }

  const rememberDiscovery = (models: KimiModelInfo[]): ModelDiscovery => {
    if (models.length) cachedDiscovery = { models }
    return cachedDiscovery
  }

  const readLiveAuth = async () => {
    const auth = await readAuth()
    if (auth) syncProcessAuthContent(auth)
    return auth
  }

  const readCurrentAuth = async (readAuth?: () => Promise<unknown>) => {
    const live = await readLiveAuth()
    if (live) return live
    if (!readAuth) return
    const current = await readAuth()
    if (!isOAuthAuth(current)) return
    syncProcessAuthContent(current)
    return current
  }

  const refreshAuth = async (auth: OAuthAuth, force = false) => {
    // opencode can ask both `provider.models` and `loader.fetch` to refresh
    // around the same time, including from separate workspace processes that
    // only inherited a stale `OPENCODE_AUTH_CONTENT` snapshot. Serialize
    // refreshes through a lock and re-read opencode's live auth store before
    // spending the refresh token.
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        return await refreshAuthWithLock(auth, {
          force,
          readLatest: readLiveAuth,
          persist: persistAuth,
        })
      } finally {
        refreshPromise = undefined
      }
    })()
    return refreshPromise
  }

  // --- return hooks ----------------------------------------------------------

  return {
    /**
     * Startup model sync, mirroring kimi-cli's `refresh_managed_models`
     * background task (research/kimi-cli/src/kimi_cli/app.py). Runs before
     * opencode reads `cfg.provider`, so the discovered models land in the
     * provider's model picker without any manual config block. Best-effort:
     * uses the stored token as-is (the loader owns refreshes), and falls back
     * to the static model list when discovery is unavailable. Never throws —
     * a failing network must not break opencode startup.
     */
    config: async (input) => {
      try {
        let models = cachedDiscovery.models
        if (!models?.length) {
          const auth = await readLiveAuth()
          if (auth) {
            try {
              models = rememberDiscovery(await listModels(auth.access)).models
            } catch {
              models = undefined
            }
          }
        }
        upsertProviderConfig(input, models?.length ? models : FALLBACK_MODELS)
      } catch {
        /* startup must never fail because of model sync */
      }
    },
    provider: {
      id: PROVIDER_ID,
      models: async (provider, ctx) => {
        if (!isOAuthAuth(ctx.auth)) return provider.models

        const discover = async (auth: OAuthAuth) => {
          const models = rememberDiscovery(await listModels(auth.access)).models ?? []
          return applyDiscoveryToModels(provider.models, models, knownModelIds(cachedDiscovery))
        }

        const current = (await readCurrentAuth()) ?? ctx.auth
        let auth = current
        try {
          if (isAuthExpiring(auth)) auth = await refreshAuth(auth)
          return await discover(auth)
        } catch (error) {
          if (auth !== current || (error as { status?: number }).status !== 401) return provider.models
        }

        try {
          return await discover(await refreshAuth(current, true))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: PROVIDER_ID,

      /**
       * Called every time opencode creates an `@ai-sdk/openai-compatible`
       * instance for this provider. We inject a `fetch` that owns all auth
       * and header concerns so no other hook has to worry about them.
       *
       * `readAuth` comes from opencode: it returns the currently persisted
       * credentials for this provider id. opencode workspace processes may
       * hydrate that from a stale `OPENCODE_AUTH_CONTENT` snapshot, so the
       * loader prefers the live auth.json entry on disk and only falls back to
       * `readAuth` when the file is absent. Writes still go through
       * `client.auth.set`.
       */
      loader: async (readAuth) => {
        let discovery: ModelDiscovery = cachedDiscovery

        const discoverModelInfo = async (access: string): Promise<ModelDiscovery> => {
          // opencode's SDK auth schema only persists the standard oauth fields
          // (`refresh`/`access`/`expires`) on `client.auth.set`, so discovery
          // cannot live durably in auth.json across refresh writes. Cache it in
          // this loader instance instead, and repopulate lazily on startup.
          discovery = rememberDiscovery(await listModels(access))
          return discovery
        }

        const ensureDiscovered = async (auth: OAuthAuth & Partial<ModelDiscovery> & Partial<SingleModelDiscovery>) => {
          if (!discovery.models?.length) {
            if (auth.models?.length) {
              discovery = { models: auth.models }
            } else if (auth.model_id) {
              // Backward compatibility: in-memory auth snapshots may carry a
              // single discovered model_id from older plugin versions/tests.
              discovery = {
                models: [
                  {
                    id: auth.model_id,
                    display_name: auth.model_display,
                    context_length: auth.context_length,
                    supports_image_in: auth.supports_image_in,
                    supports_video_in: auth.supports_video_in,
                  } as KimiModelInfo,
                ],
              }
            }
            if (discovery.models?.length) cachedDiscovery = discovery
          }
          if (discovery.models?.length) return { ...auth, ...discovery }
          try {
            return { ...auth, ...(await discoverModelInfo(auth.access)) }
          } catch {
            return { ...auth, ...discovery }
          }
        }

        const ensureFresh = async (force = false): Promise<OAuthAuth & ModelDiscovery & Partial<SingleModelDiscovery>> => {
          const current = (await readCurrentAuth(readAuth)) as (OAuthAuth & Partial<ModelDiscovery> & Partial<SingleModelDiscovery>) | undefined
          if (!current || current.type !== "oauth")
            throw new Error(
              "kimi-for-coding-oauth: not logged in — run `opencode auth login kimi-for-coding-oauth`",
            )
          if (!force && !isAuthExpiring(current)) return ensureDiscovered(current)
          const next = await refreshAuth(current, force)
          // kimi-cli re-runs `refresh_managed_models` on every successful
          // refresh — we mirror that so entitlement or display-name changes
          // are picked up without a full re-login. Failures here must not
          // block the refresh: a warm in-memory discovery still works for the
          // common case, and the request-path 401 retry will flush a broken
          // access token.
          try {
            await discoverModelInfo(next.access)
          } catch {
            /* keep previous discovery */
          }
          return { ...next, ...discovery }
        }

        return {
          // We own the Authorization header entirely, but opencode still
          // requires a truthy apiKey to wire things up; use a sentinel.
          apiKey: "kimi-for-coding-oauth",
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const doRequest = async (auth: OAuthAuth & ModelDiscovery) => {
              const headers = new Headers(input instanceof Request ? input.headers : undefined)
              new Headers(init?.headers).forEach((value, key) => {
                headers.set(key, value)
              })
              // opencode currently namespaces providerOptions for
              // @ai-sdk/openai-compatible under the provider id, while the SDK
              // reads them back under the human provider name. Carry Kimi-only
              // body fields through private headers instead so the wire request
              // stays correct regardless of that upstream mismatch.
              const kimiBodyFields = consumeInternalKimiBodyFields(headers)
              // Strip anything the upstream SDK put on. Our values win.
              headers.delete("authorization")
              headers.delete("Authorization")
              for (const [k, v] of Object.entries(kimiHeaders())) headers.set(k, v)
              headers.set("Authorization", `Bearer ${auth.access}`)

              // Rewrite the wire `model` to the server-discovered id when it
              // differs from what opencode sent. opencode bakes the model id
              // into the LanguageModel instance at provider-init time, so
              // `chat.params` cannot change it. We rewrite the JSON body here
              // instead. Mirrors kimi-cli's behavior — it sends the id it got
              // back from `/models`.
              let newInit = init
              const originalBody =
                typeof init?.body === "string"
                  ? init.body
                  : input instanceof Request && init?.body === undefined
                    ? await input
                        .clone()
                        .text()
                        .catch(() => undefined)
                    : undefined
              if (originalBody) {
                try {
                  const parsed = JSON.parse(originalBody)
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    const requestedModelId = typeof parsed.model === "string" ? parsed.model : undefined
                    // Look up the discovered wire id for the requested model.
                    // For the legacy MODEL_ID placeholder, fall back to the
                    // first discovered model to preserve old behavior.
                    const discovered = requestedModelId
                      ? (auth.models?.find((m) => m.id === requestedModelId) ??
                        (requestedModelId === MODEL_ID ? auth.models?.[0] : undefined))
                      : undefined
                    const targetModel = discovered?.id
                    const changedBody =
                      (targetModel && targetModel !== requestedModelId) || hasKimiBodyFields(kimiBodyFields)
                    if (targetModel && targetModel !== requestedModelId) {
                      parsed.model = targetModel
                    }
                    if (hasKimiBodyFields(kimiBodyFields)) {
                      applyKimiBodyFields(parsed as Record<string, unknown>, kimiBodyFields)
                    }
                    if (changedBody) {
                      newInit = { ...init, body: JSON.stringify(parsed) }
                    }
                  }
                } catch {
                  /* non-JSON body, e.g. multipart — leave alone */
                }
              }

              return fetch(input, { ...newInit, headers })
            }

            let auth = await ensureFresh()
            let res = await doRequest(auth)
            if (res.status === 401) {
              // Token might have been invalidated server-side before its
              // nominal expiry. Force a refresh and retry exactly once.
              auth = await ensureFresh(true)
              res = await doRequest(auth)
            }
            return res
          },
        }
      },

      methods: [
        {
          type: "oauth",
          label: "Kimi Code (device flow)",
          authorize: async () => {
            const device = await startDeviceAuth()
            const url = device.verification_uri_complete ?? device.verification_uri
            return {
              url,
              instructions: `Open the URL above and approve code ${device.user_code}. This window will continue automatically.`,
              method: "auto",
              callback: async () => {
                try {
                  const tokens = await pollDeviceToken(device)
                  // Discover the account's real model entitlement right
                  // after approval (mirrors kimi-cli's login flow).
                  // Failures here degrade gracefully — the plugin still
                  // works; users just don't see the config-block hint and
                  // the loader will re-attempt discovery before the first
                  // model-rewrite that needs it.
                  try {
                    const models = rememberDiscovery(await listModels(tokens.access_token)).models ?? []
                    if (models.length) {
                      // Print the discovered model set. opencode shows this
                      // next to the "Authorized" message.
                      const block = buildConfigBlock(models)
                      console.log(
                        `\n✓ Authorized for Kimi For Coding (models: ${models.map((m) => m.id).join(", ")})\n\n` +
                          `The plugin injects these models into your opencode config automatically at startup — no manual provider block needed.\n\n` +
                          `If you prefer pinning the config yourself (~/.config/opencode/opencode.json):\n\n${block}\n`,
                      )
                    }
                  } catch {
                    /* non-fatal */
                  }
                  return {
                    type: "success",
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + tokens.expires_in * 1000,
                  }
                } catch {
                  return { type: "failed" }
                }
              },
            }
          },
        },
      ],
    },

    "chat.headers": async (input, output) => {
      const fields = resolveKimiBodyFields(input as KimiHookInput, knownModelIds(cachedDiscovery))
      if (!fields) return
      if (fields.prompt_cache_key) {
        output.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER] = fields.prompt_cache_key
      }
      if (fields.reasoning_effort) {
        output.headers[INTERNAL_REASONING_EFFORT_HEADER] = fields.reasoning_effort
      }
      if (fields.thinking) {
        output.headers[INTERNAL_THINKING_TYPE_HEADER] = fields.thinking.type
      }
    },

    /**
     * Mirror Kimi-specific body fields into providerOptions when possible.
     *
     * The real load-bearing path is `chat.headers` → `loader.fetch`, because
     * current opencode/openai-compatible builds disagree on the providerOptions
     * namespace. We still normalize `output.options` so the plugin keeps
     * working if upstream aligns those keys later.
     */
    "chat.params": async (input, output) => {
      const fields = resolveKimiBodyFields(input as KimiHookInput, knownModelIds(cachedDiscovery))
      if (!fields) return
      applyKimiBodyFields(output.options, fields)
    },
  }
}

// v1 PluginModule format — bypasses getLegacyPlugins entirely.
// For npm-sourced plugins, id is optional (falls back to package.json name),
// but we set it explicitly for clarity.
export default {
  id: "opencode-kimi-full",
  server: plugin,
} satisfies PluginModule

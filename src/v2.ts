import type { Plugin as V2Plugin } from "@opencode/plugin"
import { Integration, Model, Provider } from "@opencode/plugin"
import {
  API_BASE_URL,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_OUTPUT_LIMIT,
  MODEL_ID,
  PROVIDER_ID,
} from "./constants.ts"
import { readDiscoveryCache, writeDiscoveryCache } from "./discovery-cache.ts"
import { kimiHeaders } from "./headers.ts"
import { applyKimiBodyFields, resolveKimiFields } from "./model-fields.ts"
import { listModels, pollDeviceToken, refreshToken, startDeviceAuth, type KimiModelInfo } from "./oauth.ts"
import { KimiRpc } from "./rpc.ts"
import { fetchUsage, parseUsagePayload } from "./usage.ts"

// OpenCode 2 plugin implementation. The V1 implementation stays in index.ts;
// both entrypoints share the OAuth, discovery, header, and request-field
// modules so the wire contract cannot drift between them.

const PROVIDER_NAME = "Kimi For Coding (OAuth)"
const PROVIDER_PACKAGE = "aisdk:@ai-sdk/openai-compatible"
const METHOD_ID = "oauth"
const MODELS_STORAGE_KEY = "models"

type OAuthCredential = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  methodID?: string
}

type Registration = { dispose(): Promise<void> }

function displayNameKey(model: { id: string; display_name?: string }): string {
  const name = model.display_name?.trim()
  return name || model.id
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase()
}

function keyedModels(models: ReadonlyArray<KimiModelInfo>): Array<{ key: string; model: KimiModelInfo }> {
  const used = new Set<string>()
  return models.map((model) => {
    let key = displayNameKey(model)
    if (used.has(key)) key = model.id
    used.add(key)
    return { key, model }
  })
}

function findDiscovered(
  requested: string | undefined,
  models: ReadonlyArray<KimiModelInfo> | undefined,
): KimiModelInfo | undefined {
  if (!requested || !models?.length) return undefined
  const byId = models.find((model) => model.id === requested)
  if (byId) return byId
  const byKey = models.find((model) => displayNameKey(model) === requested)
  if (byKey) return byKey
  const target = normalizeKey(requested)
  if (!target) return undefined
  return models.find(
    (model) => normalizeKey(model.id) === target || normalizeKey(displayNameKey(model)) === target,
  )
}

function prettifyModelId(modelId: string): string {
  return modelId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
}

function contextLengthFor(model: { id: string; context_length?: number }): number {
  if (model.context_length && model.context_length > 0) return model.context_length
  return DEFAULT_CONTEXT_LENGTH
}

function effortVariants(info: Pick<KimiModelInfo, "think_efforts"> | undefined) {
  const variants: Array<{ id: string; effort: string }> = [
    { id: "off", effort: "off" },
    { id: "auto", effort: "auto" },
  ]
  // The picker's tier ladder is server-driven when the model enumerates its
  // efforts (a static ladder would offer tiers the server rejects — k3, for
  // example, advertises low/high/max and no medium). The static ladder stays
  // only for models that say nothing.
  const tiers = info?.think_efforts?.valid_efforts?.length
    ? info.think_efforts.valid_efforts
    : ["low", "medium", "high", "max"]
  for (const tier of tiers) {
    if (!variants.some((variant) => variant.id === tier)) variants.push({ id: tier, effort: tier })
  }
  return variants
}

function asCatalog(value: unknown): KimiModelInfo[] {
  if (!Array.isArray(value)) return []
  return value.filter((model): model is KimiModelInfo => {
    return Boolean(model) && typeof (model as KimiModelInfo).id === "string"
  })
}

export function buildModel(discovered: KimiModelInfo, key: string): Model.Info {
  const providerID = PROVIDER_ID as Model.Info["providerID"]
  const base = Model.Info.default(providerID, key as Model.Info["id"])
  const supportsImageIn = discovered.supports_image_in ?? true
  const supportsVideoIn = discovered.supports_video_in ?? false
  const supportsReasoning = discovered.supports_reasoning ?? true
  const input = ["text", ...(supportsImageIn ? ["image"] : []), ...(supportsVideoIn ? ["video"] : [])]
  const variants = (supportsReasoning
    ? effortVariants(discovered).map((variant) => ({
        id: Model.VariantID.make(variant.id),
        body: { reasoning_effort: variant.effort },
      }))
    : []) as Model.Info["variants"]

  return {
    ...base,
    modelID: discovered.id as Model.Info["modelID"],
    name: discovered.display_name ?? prettifyModelId(discovered.id),
    capabilities: {
      tools: true,
      input,
      output: ["text"],
      temperature: false,
    },
    limit: {
      context: contextLengthFor(discovered),
      output: DEFAULT_OUTPUT_LIMIT,
    },
    variants,
  }
}

function mergeVariants(generated: Model.Info["variants"], user: Model.Info["variants"] | undefined) {
  if (!user?.length) return generated
  const byID = new Map(user.map((variant) => [variant.id as string, variant]))
  for (const variant of generated) {
    const override = byID.get(variant.id as string)
    byID.set(
      variant.id as string,
      override
        ? {
            ...variant,
            ...override,
            body: { ...variant.body, ...override.body },
            headers: { ...variant.headers, ...override.headers },
            settings: { ...variant.settings, ...override.settings },
          }
        : variant,
    )
  }
  return [...byID.values()]
}

function mergeModel(generated: Model.Info, user: Model.Info): Model.Info {
  return {
    ...generated,
    ...user,
    modelID: generated.modelID,
    capabilities: {
      ...generated.capabilities,
      ...user.capabilities,
      input: [...new Set([...generated.capabilities.input, ...user.capabilities.input])],
      output: [...new Set([...generated.capabilities.output, ...user.capabilities.output])],
    },
    limit: {
      ...generated.limit,
      ...user.limit,
      context: user.limit.context > 0 ? user.limit.context : generated.limit.context,
      output: user.limit.output > 0 ? user.limit.output : generated.limit.output,
    },
    variants: mergeVariants(generated.variants, user.variants),
  }
}

function providerInfo(): Provider.Info {
  return {
    ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
    name: PROVIDER_NAME,
    activation: "enabled",
    package: PROVIDER_PACKAGE,
    integrationID: Integration.ID.make(PROVIDER_ID),
    settings: { baseURL: API_BASE_URL },
  }
}

function warnDiscoveryFailure(error: unknown, warned: { value: boolean }, log: (message: string) => void) {
  if (warned.value) return
  warned.value = true
  const status = (error as { status?: number }).status
  const detail =
    status === 402
      ? "membership check failed — renew or verify your plan at https://kimi.com/coding"
      : status === 401 || status === 403
        ? `authentication failed — run \`opencode auth login ${PROVIDER_ID}\``
        : error instanceof Error
          ? error.message
          : String(error)
  log(
    `[kimi-for-coding-oauth] model sync failed${status ? ` (HTTP ${status})` : ""}: ${detail}. Using the last known model list.`,
  )
}

function variantEffort(variant: string | undefined) {
  if (!variant) return
  return ["off", "auto", "low", "medium", "high", "max", "xhigh"].includes(variant) ? variant : undefined
}

/**
 * OpenCode 2 server entrypoint. Registered from `src/index.ts` through the
 * dual `{ ...Plugin.define(...), server }` export, so V1.18.29+ and V2 can load
 * the same package.
 */
export async function setup(ctx: V2Plugin.Context) {
  const lifetime = new AbortController()
  const registrations: Registration[] = []
  const warned = { value: false }
  let catalog: KimiModelInfo[] = []
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const log = (message: string) => console.warn(message)

  const rememberDiscovery = async (models: KimiModelInfo[]) => {
    catalog = models
    // V2 plugin storage is durable and scoped by plugin id. The file cache is
    // also written so a V1 install pointed at the same checkout keeps a warm
    // fallback after a V1 -> V2 switch.
    await ctx.storage.set(MODELS_STORAGE_KEY, models).catch(() => undefined)
    await writeDiscoveryCache(models).catch(() => undefined)
    if (!disposed) await ctx.provider.reload().catch(() => undefined)
  }

  const activeCredential = async (): Promise<OAuthCredential | undefined> => {
    const connection = await ctx.integration.connection.active(PROVIDER_ID)
    if (!connection) return undefined
    const value = (await ctx.integration.connection.resolve(connection)) as OAuthCredential | undefined
    return value?.type === "oauth" ? value : undefined
  }

  const discover = async (access?: string) => {
    try {
      const credential = access ? { access } : await activeCredential()
      if (!credential?.access) return false
      const models = await listModels(credential.access)
      await rememberDiscovery(models)
      warned.value = false
      return true
    } catch (error) {
      warnDiscoveryFailure(error, warned, log)
      return false
    }
  }

  const scheduleDiscovery = () => {
    if (discoveryTimer) clearTimeout(discoveryTimer)
    discoveryTimer = setTimeout(() => {
      discoveryTimer = undefined
      void discover()
    }, 250)
    discoveryTimer.unref?.()
  }

  // Seed from V2 storage first, then the V1 file cache. A cold start with no
  // successful discovery still gets the last-known-good list instead of an
  // empty picker.
  const stored = asCatalog(await ctx.storage.get(MODELS_STORAGE_KEY).catch(() => undefined))
  catalog = stored.length ? stored : (await readDiscoveryCache().catch(() => undefined)) ?? []

  // Provider source. Adding the provider here also creates the integration
  // reference, so the OAuth method registered below attaches to a known id.
  registrations.push(
    await ctx.provider.transform((editor) => {
      const generated = keyedModels(catalog).map(({ key, model }) => buildModel(model, key))
      const existing = editor.get(PROVIDER_ID)
      if (!existing) {
        editor.add({ info: providerInfo(), models: generated })
        return
      }
      editor.update(PROVIDER_ID, (provider) => {
        if (!provider.name || provider.name === PROVIDER_ID) provider.name = PROVIDER_NAME
        if (!provider.package) provider.package = PROVIDER_PACKAGE
        if (provider.activation === "auto") provider.activation = "enabled"
        provider.integrationID ??= Integration.ID.make(PROVIDER_ID)
        provider.settings = { baseURL: API_BASE_URL, ...provider.settings }
      })
      if (!generated.length) return
      const merged = new Map(existing.models)
      for (const model of generated) {
        const user = merged.get(model.id as string)
        merged.set(model.id as string, user ? mergeModel(model, user) : model)
      }
      // Patch older raw-slug entries so configs written before the WYSIWYG
      // naming change keep receiving context/media metadata.
      for (const [key, model] of merged) {
        const discovered = findDiscovered(key, catalog)
        if (!discovered) continue
        merged.set(key, mergeModel(buildModel(discovered, key), model))
      }
      editor.models.set(
        PROVIDER_ID,
        [...merged.values()],
      )
    }),
  )

  // Credentials. The device-flow method is the only supported login; the
  // refresh callback is invoked by OpenCode and its result is persisted by
  // core, so this plugin never writes the credential store directly.
  registrations.push(
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: Integration.MethodID.make(METHOD_ID),
          type: "oauth",
          label: "Kimi Code (device flow)",
        },
        async authorize() {
          const device = await startDeviceAuth()
          const callback = (async () => {
            const tokens = await pollDeviceToken(device)
            try {
              const models = await listModels(tokens.access_token)
              await rememberDiscovery(models)
              if (models.length) {
                console.log(
                  `\n✓ Authorized for Kimi For Coding (models: ${models.map((model) => model.id).join(", ")})\n` +
                    "The plugin injects these models into OpenCode automatically — no manual provider block needed.\n",
                )
              }
            } catch {
              /* discovery is best-effort; the provider still works */
            }
            return {
              type: "oauth" as const,
              methodID: Integration.MethodID.make(METHOD_ID),
              refresh: tokens.refresh_token,
              access: tokens.access_token,
              expires: Date.now() + tokens.expires_in * 1000,
            }
          })()
          return {
            url: device.verification_uri_complete ?? device.verification_uri,
            instructions: `Open the URL above and approve code ${device.user_code}. This window will continue automatically.`,
            mode: "auto" as const,
            callback,
          }
        },
        async refresh(credential) {
          const tokens = await refreshToken(credential.refresh)
          void discover(tokens.access_token)
          return {
            ...credential,
            refresh: tokens.refresh_token,
            access: tokens.access_token,
            expires: Date.now() + tokens.expires_in * 1000,
          }
        },
        label: () => "Kimi Code",
      })
    }),
  )

  registrations.push(
    await ctx.rpc.register(KimiRpc, {
      usage: async () => {
        const credential = await activeCredential()
        if (!credential) {
          throw new Error(`Kimi is not authenticated. Run \`opencode auth login ${PROVIDER_ID}\` first.`)
        }
        return { rows: parseUsagePayload(await fetchUsage(credential.access)) }
      },
    }),
  )

  // Session request rewriting. `http.request` is the native HTTP boundary, so
  // it sees the final JSON body after variant overlays and lets us set the
  // Kimi fingerprint headers without replacing the provider's SDK.
  registrations.push(
    await ctx.session.hook("http.request", async (event) => {
      if (event.model.providerID !== PROVIDER_ID) return
      const credential = await activeCredential()
      if (!credential) {
        throw new Error(
          `kimi-for-coding-oauth: not logged in — run \`opencode auth login ${PROVIDER_ID}\``,
        )
      }

      const headers = event.request.headers
      headers.delete("authorization")
      for (const [key, value] of Object.entries(kimiHeaders())) headers.set(key, value)
      headers.set("Authorization", `Bearer ${credential.access}`)

      let body: string | undefined
      let changed = false
      try {
        const original = await event.request.clone().text()
        if (original) {
          const parsed = JSON.parse(original) as Record<string, unknown>
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const requested = typeof parsed.model === "string" ? parsed.model : event.model.id
            const info = findDiscovered(requested, catalog) ?? findDiscovered(event.model.id, catalog)
            if (info && typeof parsed.model === "string") {
              parsed.model = info.id
              changed = true
            }
            if (info || event.model.id === MODEL_ID) {
              const rawEffort =
                typeof parsed.reasoning_effort === "string"
                  ? parsed.reasoning_effort
                  : variantEffort(event.model.variant)
              applyKimiBodyFields(
                parsed,
                resolveKimiFields({ info, sessionID: event.sessionID, effort: rawEffort }),
              )
              changed = true
            }
            if (changed) body = JSON.stringify(parsed)
          }
        }
      } catch {
        /* non-JSON body (e.g. multipart) — leave it untouched */
      }

      if (changed) {
        headers.delete("content-length")
        event.request = new Request(event.request, { body, headers })
      }
    }),
  )

  registrations.push(
    await ctx.session.hook(
      "model.request",
      (event) => {
        if (event.model.providerID !== PROVIDER_ID) return
        event.baseURL = API_BASE_URL
      },
      { providerID: PROVIDER_ID },
    ),
  )

  registrations.push(
    await ctx.session.hook("retry", (event) => {
      if (event.model.providerID !== PROVIDER_ID) return
      if (event.error.status === 401 && event.attempt === 1) {
        event.decision = { retry: true, delay: 0 }
      }
    }),
  )

  // Credential changes (login, refresh, account switch) invalidate the
  // account-specific model list.
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
        if (event.type === "credential.updated" || event.type === "integration.updated") {
          scheduleDiscovery()
        }
        if (event.type === "credential.switched" && event.data.integrationID === PROVIDER_ID) {
          scheduleDiscovery()
        }
      }
    } catch (error) {
      if (!lifetime.signal.aborted) {
        log(`[kimi-for-coding-oauth] credential event stream stopped: ${String(error)}`)
      }
    }
  })()

  // Startup model sync mirrors kimi-cli's refresh_managed_models task. The
  // cached list is already registered above; this refreshes it in the
  // background so startup is never blocked by the network.
  void discover()

  return async () => {
    disposed = true
    lifetime.abort()
    if (discoveryTimer) clearTimeout(discoveryTimer)
    await Promise.allSettled(registrations.reverse().map((registration) => registration.dispose()))
  }
}

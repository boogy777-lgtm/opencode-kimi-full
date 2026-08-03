// Values mirror kimi-cli v1.41.0 1:1. When upstream bumps, update here and
// nothing else in the codebase should hard-code these strings.
//
// Source of truth: research/kimi-cli/src/kimi_cli/constant.py,
// research/kimi-cli/src/kimi_cli/auth/oauth.py
//
// NOTE: client_id is a public constant shipped inside the official CLI, not a
// secret.

export const KIMI_CLI_VERSION = "1.41.0"
// Upstream: research/kimi-cli/src/kimi_cli/constant.py get_user_agent() →
// f"KimiCLI/{get_version()}". This must match verbatim — Moonshot's
// `kimi-for-coding` backend 403s on any other UA prefix
// ("access_terminated_error: only available for Coding Agents").
export const USER_AGENT = `KimiCLI/${KIMI_CLI_VERSION}`

export const OAUTH_HOST = "https://auth.kimi.com"
export const OAUTH_DEVICE_AUTH_URL = `${OAUTH_HOST}/api/oauth/device_authorization`
export const OAUTH_TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`
export const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
export const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
export const OAUTH_REFRESH_GRANT = "refresh_token"

export const API_BASE_URL = "https://api.kimi.com/coding/v1"
// Stable opencode-side alias kept for backward compatibility.
export const MODEL_ID = "kimi-for-coding"

// The authoritative model list is the server's `GET /coding/v1/models`
// response, discovered at startup (config hook), at login, and on every token
// refresh — mirroring kimi-cli's `refresh_managed_models`
// (research/kimi-cli/src/kimi_cli/auth/platforms.py), which keeps NO static
// model list at all. The entries below are only the cold-start fallback used
// when discovery has not produced a list yet in this process (offline start,
// not logged in, or the chat hooks firing before the first discovery).
export const FALLBACK_MODEL_IDS = ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"] as const

// Fallback per-model metadata for the same cold-start path. Server-reported
// `display_name` / `context_length` / `supports_*` flags always win over these.
export const FALLBACK_MODELS: ReadonlyArray<{
  id: string
  display_name: string
  context_length: number
  supports_image_in: boolean
  supports_video_in: boolean
}> = [
  { id: "k3", display_name: "Kimi K3", context_length: 1_048_576, supports_image_in: true, supports_video_in: false },
  {
    id: "kimi-for-coding",
    display_name: "Kimi For Coding",
    context_length: 256_000,
    supports_image_in: true,
    supports_video_in: false,
  },
  {
    id: "kimi-for-coding-highspeed",
    display_name: "Kimi For Coding High Speed",
    context_length: 256_000,
    supports_image_in: true,
    supports_video_in: false,
  },
]

// Last-resort context length when neither the server nor the fallback table
// knows the model. Matches the K2.7 generation's window.
export const DEFAULT_CONTEXT_LENGTH = 256_000
export const DEFAULT_OUTPUT_LIMIT = 65_536

// Models that support the `max` reasoning effort tier. This is a server-side
// capability gate, NOT a model list: K2.7 models clamp max/xhigh to `high` to
// match kimi-cli behavior, and models unknown to this list clamp as well
// (safe default — an unsupported effort value fails the request upstream).
export const MAX_REASONING_MODEL_IDS = ["k3"] as const

// Provider id the user must use in their opencode config. Intentionally NOT
// "kimi-for-coding" — models.dev publishes an entry under that id (static
// KIMI_API_KEY flow via a different SDK / auth shape), and sharing the id
// would surface two auth methods under one `opencode auth login` entry and
// silently route users onto the wrong integration path. See AGENTS.md rule 7.
export const PROVIDER_ID = "kimi-for-coding-oauth"

// Refresh a bit before the server-reported expiry so we never race it.
export const REFRESH_SAFETY_WINDOW_MS = 60_000

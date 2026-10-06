import Schema from '@deepseek-ai/schemastery'

import { LANE_IDS, type LaneId } from './types.ts'

/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 *
 * One flat namespace with a per-lane prefix: DSH renders the settings card from
 * this schema, and a flat shape keeps every override a one-liner in the patch
 * file (`clineFreeOnly: false`) without nested-object default ambiguity.
 */

export interface Free2dshConfig {
  /** Provider route registered for the merged catalog (the model picker column). */
  providerId?: string
  /** Lanes to expose. Empty = every lane this plugin ships. */
  lanes?: string[]
  /** Catalog refresh interval in seconds. */
  refreshSeconds?: number
  /** Plugin data dir for catalogs / token sidecars. Empty = ~/.free2dsh. */
  dataDir?: string

  /* --- Cline lane ------------------------------------------------------ */
  /** Cline OpenAI-compatible API base. */
  clineBaseURL?: string
  /** Cline desktop credentials file. Empty = ~/.cline/data/settings/providers.json. */
  clineCredentialsPath?: string
  /** Only expose Cline free models (default true). */
  clineFreeOnly?: boolean
  /** Also expose the Cline Pass bucket (needs a paid subscription). */
  clineIncludePass?: boolean

  /* --- AtomCode lane --------------------------------------------------- */
  /** AtomCode CLI home. Empty = ~/.atomcode (ATOMCODE_HOME overrides). */
  atomcodeHome?: string
  /** Upstream `.../v1` bases, tried round-robin. Empty = config.toml + defaults. */
  atomcodeHosts?: string[]
  /** `X-AtomCode-Ver` value. Empty = the verified default. */
  atomcodeClientVersion?: string
  /** Model id allowlist. Empty = every AtomCode model found. */
  atomcodeModels?: string[]
  /** Allow minting a fresh token when the CLI file token is stale. */
  atomcodeAllowRefresh?: boolean

  /* --- OpenCode Zen lane ----------------------------------------------- */
  /** OpenCode Zen base. */
  opencodeBaseURL?: string
  /** Expose `muse-spark-*` (Responses-API-only; not usable on this wire). */
  opencodeIncludeResponsesOnly?: boolean

  /* --- Watchdogs (all lanes) ------------------------------------------- */
  /** ms to wait for the first stream event. */
  firstEventMs?: number
  /** ms of body silence tolerated mid-stream. */
  bodyIdleMs?: number
}

export const defaults = {
  providerId: 'free2dsh',
  lanes: [] as LaneId[],
  refreshSeconds: 300,
  dataDir: '',
  clineBaseURL: 'https://api.cline.bot/api/v1',
  clineCredentialsPath: '',
  clineFreeOnly: true,
  clineIncludePass: false,
  atomcodeHome: '',
  atomcodeHosts: [] as string[],
  atomcodeClientVersion: '',
  atomcodeModels: [] as string[],
  atomcodeAllowRefresh: true,
  opencodeBaseURL: 'https://opencode.ai/zen',
  opencodeIncludeResponsesOnly: false,
}

export type ResolvedConfig = Required<
  Omit<
    Free2dshConfig,
    'lanes' | 'firstEventMs' | 'bodyIdleMs'
  >
> & {
  /** Enabled lanes in canonical order; already validated against LANE_IDS. */
  lanes: LaneId[]
} & Pick<Free2dshConfig, 'firstEventMs' | 'bodyIdleMs'>

/**
 * Enabled lanes in canonical order. Unknown names are dropped rather than
 * throwing, so a typo costs one lane instead of the whole plugin.
 */
export function resolveLanes(config: Free2dshConfig): LaneId[] {
  const requested = (config.lanes ?? []).map((lane) => String(lane).trim().toLowerCase())
  if (requested.length === 0) return [...LANE_IDS]
  const wanted = new Set(requested)
  return LANE_IDS.filter((lane) => wanted.has(lane))
}

export function resolveConfig(config: Free2dshConfig = {}): ResolvedConfig {
  // A host may hand us keys that are present but undefined (an empty settings
  // form, a serialised patch that omits values). Spreading those would
  // clobber a default with `undefined` and crash on first use, so drop them.
  const provided: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) provided[key] = value
  }
  return {
    ...defaults,
    ...(provided as Free2dshConfig),
    lanes: resolveLanes(provided as Free2dshConfig),
  }
}

/**
 * The plugin's `Config` — the DSH settings contract. Everything here is
 * ordinary composition configuration (set via cordis.patch.yml), so no
 * `.volatile()` node: the settings card stays read-only for these fields.
 */
export const Config = Schema.object({
  providerId: Schema.string().default(defaults.providerId),
  lanes: Schema.array(Schema.string()).default(defaults.lanes),
  refreshSeconds: Schema.number().step(1).min(30).default(defaults.refreshSeconds),
  dataDir: Schema.string().default(defaults.dataDir),
  clineBaseURL: Schema.string().default(defaults.clineBaseURL),
  clineCredentialsPath: Schema.string().default(defaults.clineCredentialsPath),
  clineFreeOnly: Schema.boolean().default(defaults.clineFreeOnly),
  clineIncludePass: Schema.boolean().default(defaults.clineIncludePass),
  atomcodeHome: Schema.string().default(defaults.atomcodeHome),
  atomcodeHosts: Schema.array(Schema.string()).default(defaults.atomcodeHosts),
  atomcodeClientVersion: Schema.string().default(defaults.atomcodeClientVersion),
  atomcodeModels: Schema.array(Schema.string()).default(defaults.atomcodeModels),
  atomcodeAllowRefresh: Schema.boolean().default(defaults.atomcodeAllowRefresh),
  opencodeBaseURL: Schema.string().default(defaults.opencodeBaseURL),
  opencodeIncludeResponsesOnly: Schema.boolean().default(defaults.opencodeIncludeResponsesOnly),
  firstEventMs: Schema.number().step(1).min(1_000).max(600_000),
  bodyIdleMs: Schema.number().step(1).min(1_000).max(600_000),
})

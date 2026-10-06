import { cacheFile, readCache, writeCache } from '../cache.ts'
import type { LaneModel } from '../types.ts'
import { clineRequestHeaders, getValidAccessToken } from './cline-credentials.ts'

/**
 * Free-model catalog for the Cline lane.
 *
 * Cline's "free" is TWO disjoint families:
 *   1. Cline's own promo free fleet, served by
 *      `GET {baseURL}/ai/cline/recommended-models` in the `free` bucket — ids
 *      carry the `cline-free/` routing prefix (plus OpenRouter-style sponsored
 *      ids like `stealth/space-bunny-alpha`). The backend gates those on client
 *      identity headers, not on the token alone. The `clinePass` bucket of the
 *      same endpoint needs a paid subscription (403 ENTITLEMENT_ERROR without
 *      one), so it is opt-in.
 *   2. OpenRouter-routed free models: `/models` rows whose id carries the
 *      `:free` suffix.
 *
 * Fallback chain: live (recommended-models ∪ :free rows, OpenRouter metadata
 * enrichment best-effort) -> 7-day disk cache -> compiled-in static roster.
 */

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

export type CatalogTier = 'live' | 'cache' | 'static' | 'pending'

export interface ClineCatalogSnapshot {
  tier: CatalogTier
  total: number
  freeBucket: number
  clinePass: number
  openrouterFree: number
  lastError: string
}

/**
 * Display-name badge pinned to the Cline free fleet. Some picker surfaces
 * re-sort options alphabetically and ignore adapter order; `!` sorts before
 * every letter under both code-point and locale collation, so the badge pins
 * the fleet to the top in either world. Display-only — the wire id is untouched.
 */
export const FLEET_BADGE = '! '

/** Verified free roster (free bucket ∪ /models `:free`), compiled-in fallback. */
export const STATIC_CLINE_MODELS: LaneModel[] = [
  { id: 'cline-free/deepseek-v4.1-flash', name: FLEET_BADGE + 'Deepseek-v4.1-Flash' },
  { id: 'stealth/space-bunny-alpha', name: FLEET_BADGE + 'Space Bunny Alpha' },
  { id: 'cline-free/mimo-v2.6-flash', name: FLEET_BADGE + 'Mimo V2.6 Flash' },
  { id: 'cline-free/muse-spark-1.3-contributor', name: FLEET_BADGE + 'Muse Spark 1.3 Contributor' },
  { id: 'apodex/apodex-1.1-mini:free' },
  { id: 'inclusionai/ling-3.0-flash-sante:free' },
  { id: 'qwen/qwen3.8-27b:free' },
  { id: 'dots-studio/dots-3-note-preview:free' },
  { id: 'liquid/lfm-2.5-2.6b:free' },
  { id: 'nvidia/nemotron-3.5-lightning:free' },
  { id: 'thinkingmachines/inkling-small:free' },
  { id: 'poolside/laguna-s-2.1:free' },
  { id: 'thinkingmachines/inkling:free' },
  { id: 'poolside/laguna-xs-2.1:free' },
  { id: 'cohere/north-mini-code:free' },
  { id: 'nvidia/nemotron-3.5-content-safety:free' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' },
  { id: 'google/gemma-4-26b-a4b-it:free' },
  { id: 'google/gemma-4-31b-it:free' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free' },
]

export function isFreeModel(id: string): boolean {
  return id.endsWith(':free')
}

/** "cline-pass/glm-5.3" -> "Glm 5.3"; bucket names are often raw ids. */
export function prettifyBucketName(raw: string | undefined, id: string): string {
  if (typeof raw === 'string' && raw.length > 0 && !raw.includes('/') && !/^[a-z0-9.-]+$/.test(raw)) return raw
  const short = (raw ?? id).split('/').at(-1) ?? id
  return short
    .replace(/[:].*$/, '')
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

export function fleetDisplayName(raw: string | undefined, id: string): string {
  return FLEET_BADGE + prettifyBucketName(raw, id)
}

interface BucketRow {
  id?: string
  name?: string
}

export interface ClineCatalogOptions {
  baseURL: string
  credentialsPath: string
  cachePath: string
  freeOnly: boolean
  includeClinePass: boolean
  fetchImpl?: typeof fetch
}

export class ClineCatalog {
  readonly #options: Required<Pick<ClineCatalogOptions, 'baseURL' | 'credentialsPath' | 'cachePath' | 'freeOnly' | 'includeClinePass'>> & {
    fetchImpl: typeof fetch
  }
  #entries = new Map<string, LaneModel>()
  #ordered: string[] = []
  #tier: CatalogTier = 'pending'
  #lastError = ''
  #counts = { freeBucket: 0, clinePass: 0, openrouterFree: 0 }
  #refreshing: Promise<void> | undefined

  constructor(options: ClineCatalogOptions) {
    this.#options = {
      baseURL: options.baseURL.replace(/\/+$/, ''),
      credentialsPath: options.credentialsPath,
      cachePath: options.cachePath,
      freeOnly: options.freeOnly,
      includeClinePass: options.includeClinePass,
      fetchImpl: options.fetchImpl ?? fetch,
    }
  }

  list(): string[] {
    if (this.#entries.size > 0) return [...this.#ordered]
    return STATIC_CLINE_MODELS.map((model) => model.id)
  }

  entry(model: string): LaneModel | undefined {
    return this.#entries.get(model)
  }

  tier(): CatalogTier {
    return this.#tier
  }

  lastError(): string {
    return this.#lastError
  }

  snapshot(): ClineCatalogSnapshot {
    return {
      tier: this.#tier,
      total: this.#entries.size,
      ...this.#counts,
      lastError: this.#lastError,
    }
  }

  /** Tier 2: initial disk-cache read. Never throws. Returns a startup note. */
  async prime(): Promise<string> {
    const cached = await readCache<LaneModel>(this.#options.cachePath)
    if (cached && cached.entries.length > 0) {
      this.#ingest(cached.entries, 'cache')
      return `cache (${cached.entries.length} models)`
    }
    return 'no cache'
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing
    this.#refreshing = this.#refreshOnce().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  async #refreshOnce(): Promise<void> {
    try {
      const [buckets, orFree] = await Promise.all([this.#fetchFreeBuckets(), this.#fetchOpenRouterFree()])
      const entries = new Map<string, LaneModel>()
      for (const entry of buckets.values()) entries.set(entry.id, entry)
      for (const entry of orFree) {
        if (!entries.has(entry.id)) entries.set(entry.id, entry)
      }
      if (entries.size === 0) throw new Error('both free sources came back empty')
      this.#ingest([...entries.values()], 'live')
      await writeCache(this.#options.cachePath, [...entries.values()], { ...this.#counts })
      this.#lastError = ''
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err)
      if (this.#entries.size === 0) this.#ingest(STATIC_CLINE_MODELS, 'static')
    }
  }

  /** Cline's own free fleet (the `free` bucket; `clinePass` is opt-in). */
  async #fetchFreeBuckets(): Promise<Map<string, LaneModel>> {
    const { accessToken, accountId } = await getValidAccessToken({
      baseURL: this.#options.baseURL,
      credentialsPath: this.#options.credentialsPath,
    })
    const url = `${this.#options.baseURL}/ai/cline/recommended-models`
    const response = await this.#options.fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...clineRequestHeaders(accountId),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GET recommended-models -> ${response.status}`)
    const body = (await response.json()) as { free?: BucketRow[]; clinePass?: BucketRow[] }
    const entries = new Map<string, LaneModel>()
    const take = (rows: BucketRow[] | undefined, tag: 'free' | 'clinePass'): number => {
      let n = 0
      for (const row of rows ?? []) {
        if (typeof row?.id !== 'string' || row.id.length === 0) continue
        n += 1
        if (tag === 'clinePass' && !this.#options.includeClinePass) continue
        if (entries.has(row.id)) continue
        entries.set(row.id, { id: row.id, name: fleetDisplayName(row.name, row.id) })
      }
      return n
    }
    this.#counts.freeBucket = take(body.free, 'free')
    this.#counts.clinePass = take(body.clinePass, 'clinePass')
    return entries
  }

  /** OpenRouter-routed free models: `:free` suffix rows of GET /models. */
  async #fetchOpenRouterFree(): Promise<LaneModel[]> {
    const { accessToken, accountId } = await getValidAccessToken({
      baseURL: this.#options.baseURL,
      credentialsPath: this.#options.credentialsPath,
    })
    const url = `${this.#options.baseURL}/models`
    const response = await this.#options.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, ...clineRequestHeaders(accountId) },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GET /models -> ${response.status}`)
    const body = (await response.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> }
    const rows = body.data ?? body.models ?? []
    const ids: string[] = []
    for (const row of rows) {
      if (typeof row?.id !== 'string' || row.id.length === 0) continue
      if (this.#options.freeOnly && !isFreeModel(row.id)) continue
      if (!ids.includes(row.id)) ids.push(row.id)
    }
    this.#counts.openrouterFree = ids.length
    if (ids.length === 0) return []
    const enriched = await this.#enrich(ids).catch(() => undefined)
    return ids.map((id) => ({ ...(enriched?.get(id) ?? { id }) }))
  }

  /**
   * Best-effort OpenRouter metadata: display name, context window, max output,
   * image input. Cline's OpenRouter ids are verbatim OpenRouter ids, so the
   * join is exact; any failure only costs the enrichment.
   */
  async #enrich(ids: string[]): Promise<Map<string, LaneModel>> {
    const wanted = new Set(ids)
    const response = await this.#options.fetchImpl(OPENROUTER_MODELS_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`openrouter metadata -> ${response.status}`)
    const body = (await response.json()) as {
      data?: Array<{
        id?: string
        name?: string
        context_length?: number
        top_provider?: { max_completion_tokens?: number | null }
        architecture?: { input_modalities?: string[] }
      }>
    }
    const map = new Map<string, LaneModel>()
    for (const row of body.data ?? []) {
      if (typeof row?.id !== 'string' || !wanted.has(row.id)) continue
      const entry: LaneModel = { id: row.id }
      if (typeof row.name === 'string' && row.name.length > 0) entry.name = row.name
      if (typeof row.context_length === 'number' && row.context_length > 0) entry.contextWindow = row.context_length
      if (typeof row.top_provider?.max_completion_tokens === 'number' && row.top_provider.max_completion_tokens > 0) {
        entry.maxOutput = row.top_provider.max_completion_tokens
      }
      const inputs = row.architecture?.input_modalities
      if (Array.isArray(inputs) && inputs.length > 0) entry.imageInput = inputs.includes('image')
      map.set(row.id, entry)
    }
    return map
  }

  /** Picker order: Cline's own free fleet first, then by display name. */
  #compare(a: LaneModel, b: LaneModel): number {
    const pinned = (model: LaneModel) => (model.name?.startsWith(FLEET_BADGE) ? 0 : 1)
    const byPinned = pinned(a) - pinned(b)
    if (byPinned !== 0) return byPinned
    const an = (a.name ?? a.id).toLowerCase()
    const bn = (b.name ?? b.id).toLowerCase()
    if (an !== bn) return an < bn ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }

  #ingest(entries: LaneModel[], tier: CatalogTier): void {
    const next = new Map<string, LaneModel>()
    for (const entry of entries) {
      if (typeof entry?.id === 'string' && entry.id.length > 0) next.set(entry.id, entry)
    }
    if (next.size === 0) return
    this.#entries = next
    this.#ordered = [...next.values()].sort((a, b) => this.#compare(a, b)).map((entry) => entry.id)
    this.#tier = tier
  }
}

/** Cache path for the Cline lane under the plugin data dir. */
export function clineCachePath(dataDir: string): string {
  return cacheFile(dataDir, 'cline')
}

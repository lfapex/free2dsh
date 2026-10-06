import { cacheFile, readCache, writeCache } from '../cache.ts'
import { deriveZenIds, type ZenIDs } from '../ids.ts'
import { openAiStream } from '../openai-stream.ts'
import { buildOpenAIPayload, type OpenAIPayload } from '../request.ts'
import { withWatchdogs } from '../watchdog.ts'
import type { HarnessChunk } from '../chunks.ts'
import type { HarnessGenerateOptions, Lane, LaneHealth, LaneModel, PluginLogger } from '../types.ts'

/**
 * The OpenCode Zen lane: the anonymous free lane OpenCode's own CLI uses
 * without an account.
 *
 * No credential to manage — the key is the literal string `public` — but the
 * lane does have to look like the CLI: a matching user agent, Zen's canonical
 * session/project ids derived per conversation, and (since 2026-09-16) a body
 * shape that streams and carries the reserved `bash`/`read` function tools.
 * Those gate tools are injected only when the caller does not already have a
 * tool of the same name, and calls to them flow back to the harness like any
 * real tool call — stripping them again strands a `tool-calls` finish with no
 * tool for the harness to run, which silently ends the turn mid-task (the
 * reference opencode2dsh plugin never filters the response either).
 */

export const OPENCODE_LABEL = 'OpenCode Zen'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 32_000

/**
 * Ids that look free but do NOT work on the anonymous chat-completions lane:
 *  - deepseek-v4-flash-free: HTTP 400 "Model is unavailable" — free only for
 *    authenticated Zen accounts, models.dev still marks it cost 0.
 *  - jev-1.13-free: HTTP 500 — rides the SystemOne endpoint, not chat
 *    completions.
 */
const UNUSABLE_IDS = new Set(['deepseek-v4-flash-free', 'jev-1.13-free'])

/** `muse-spark-*` is Responses-API-only upstream, so it is off this wire. */
export const RESPONSES_ONLY_PREFIX = 'muse-spark-'

/** Verified against the anonymous lane with real chats. */
export const STATIC_OPENCODE_MODELS: LaneModel[] = [
  { id: 'big-pickle', name: 'Big Pickle', reasoning: true },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', reasoning: true },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash Free', contextWindow: 200_000, maxOutput: 32_000, reasoning: true, imageInput: true },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin Free', contextWindow: 262_144, maxOutput: 32_768, reasoning: true },
  { id: 'ling-3.1-flash-free', name: 'Ling 3.1 Flash Free', contextWindow: 262_144, maxOutput: 32_768, reasoning: true },
  { id: 'fledge-alpha-free', name: 'Fledge Alpha Free', contextWindow: 1_000_000, reasoning: true },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', reasoning: true },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', reasoning: true },
]

const STATIC_VERIFIED_IDS = new Set(STATIC_OPENCODE_MODELS.map((model) => model.id))

/** The reserved tools the free lane gates on. Definitions are not inspected. */
const FREE_LANE_GATE_TOOLS = ['bash', 'read'] as const

export function zenUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

export function zenHeaders(ids: ZenIDs, apiKey = 'public'): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'user-agent': zenUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}

function gateTool(name: (typeof FREE_LANE_GATE_TOOLS)[number]): unknown {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

/**
 * Rewrite the chat body so it passes the free-lane gate: force streaming and
 * append the reserved bash/read tools, pinning tool_choice=none when the
 * caller sent no tools of its own. Calls to an injected gate tool flow back to
 * the harness like any tool call — the harness owns what happens with them.
 */
export function applyFreeLaneShape(payload: OpenAIPayload): { payload: OpenAIPayload; injected: boolean } {
  const tools = Array.isArray(payload.tools) ? [...(payload.tools as unknown[])] : []
  const names = new Set(
    tools.map((tool) => {
      if (typeof tool !== 'object' || tool === null) return undefined
      const fn = (tool as { function?: { name?: unknown } }).function
      return typeof fn?.name === 'string' ? fn.name : undefined
    }),
  )
  const missing = FREE_LANE_GATE_TOOLS.filter((name) => !names.has(name))
  const next: OpenAIPayload = { ...payload, stream: true }
  if (missing.length > 0) {
    next.tools = [...tools, ...missing.map(gateTool)]
    if (tools.length === 0 && payload.tool_choice === undefined) next.tool_choice = 'none'
  }
  if (next.stream_options === undefined) next.stream_options = { include_usage: true }
  return { payload: next, injected: missing.length > 0 }
}

export function isResponsesOnly(id: string): boolean {
  return id.startsWith(RESPONSES_ONLY_PREFIX)
}

/** Free verdict for the ANONYMOUS lane. */
export function freeVerdict(id: string, entry: ModelsDevEntry | undefined): boolean {
  if (UNUSABLE_IDS.has(id) || entry?.deprecated) return false
  if (STATIC_VERIFIED_IDS.has(id)) return true
  if (id.toLowerCase().includes('free')) return true
  const cost = entry?.cost
  return cost !== undefined && cost.input === 0 && cost.output === 0
}

export interface ModelsDevEntry {
  name?: string
  tool_call?: boolean
  reasoning?: boolean
  deprecated?: boolean
  cost?: { input?: number; output?: number }
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[] }
}

async function fetchModelsDev(fetchImpl: typeof fetch): Promise<Record<string, ModelsDevEntry>> {
  const res = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`models.dev -> ${res.status}`)
  const api = (await res.json()) as Record<string, { models?: Record<string, ModelsDevEntry> }>
  return api.opencode?.models ?? {}
}

export interface OpenCodeLaneOptions {
  baseURL: string
  dataDir: string
  refreshSeconds: number
  includeResponsesOnly: boolean
  firstEventMs?: number
  bodyIdleMs?: number
  logger: PluginLogger
  fetchImpl?: typeof fetch
}

type Tier = 'live' | 'cache' | 'static'

export class OpenCodeLane implements Lane {
  readonly id = 'opencode' as const
  readonly label = OPENCODE_LABEL

  readonly #options: OpenCodeLaneOptions
  readonly #fetch: typeof fetch
  readonly #cachePath: string
  readonly #logger: PluginLogger
  readonly #projectSeed = 'free2dsh:default-project'
  #entries: LaneModel[] = []
  #tier: Tier = 'static'
  #lastError = ''
  #timer: NodeJS.Timeout | undefined
  #devCache: { at: number; value: Record<string, ModelsDevEntry> } | undefined

  constructor(options: OpenCodeLaneOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? fetch
    this.#cachePath = cacheFile(options.dataDir, 'opencode')
    this.#logger = options.logger
  }

  models(): string[] {
    return this.#entries.map((entry) => entry.id)
  }

  entry(model: string): LaneModel | undefined {
    return this.#entries.find((entry) => entry.id === model)
  }

  health(): LaneHealth {
    return {
      lane: 'opencode',
      status: this.#lastError && this.#entries.length === 0 ? 'degraded' : 'ready',
      models: this.#entries.length,
      detail: this.#lastError,
      catalog: this.#tier,
    }
  }

  /**
   * Seed from the 7-day disk cache, then the hand-verified roster. This lane is
   * the only one whose catalog is not local — Cline primes from disk and
   * AtomCode reads config.toml — so without a primed start it is the one lane
   * that stays invisible until the network answers. Never throws.
   */
  async prime(): Promise<void> {
    if (this.#entries.length > 0) return
    const cached = await readCache<LaneModel>(this.#cachePath)
    if (cached && cached.entries.length > 0) {
      this.#entries = cached.entries
      this.#tier = 'cache'
      return
    }
    this.#entries = [...STATIC_OPENCODE_MODELS]
    this.#tier = 'static'
  }

  async start(): Promise<void> {
    await this.prime()
    this.#logger.info(`free2dsh[opencode]: primed from ${this.#tier} — ${this.#entries.length} model(s)`)
    await this.refresh()
    if (this.#lastError) this.#logger.warn(`free2dsh[opencode]: ${this.#lastError}`)
    else this.#logger.info(`free2dsh[opencode]: catalog ${this.#tier} — ${this.models().join(', ') || '(none)'}`)
    this.#timer = setInterval(() => {
      void this.refresh()
    }, Math.max(30, this.#options.refreshSeconds) * 1000)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
  }

  /**
   * Live `GET /v1/models` ∩ free verdict, models.dev metadata enrichment
   * best-effort; 7-day disk cache next; verified static roster last.
   *
   * The live list is published the moment it arrives, using the verdicts that
   * need no metadata at all (hand-verified ids, and ids whose name says
   * "free"). models.dev is a multi-megabyte download that only *adds* metadata
   * and rescues zero-cost ids whose name does not say free, so gating the
   * catalog on it would leave this lane empty for as long as that download
   * takes — long enough for a host that snapshots the catalog at boot to show
   * the lane (and its route) as empty.
   */
  async refresh(): Promise<void> {
    let published = false
    try {
      const liveList = await this.#fetchLiveList()
      this.#publish(this.#build(liveList, undefined))
      published = this.#tier === 'live'
      const devModels = await this.#loadModelsDev().catch(() => ({}) as Record<string, ModelsDevEntry>)
      const entries = this.#build(liveList, devModels)
      if (entries.length === 0) throw new Error('live list empty after the free filter')
      this.#entries = entries
      this.#tier = 'live'
      this.#lastError = ''
      await writeCache(this.#cachePath, entries)
    } catch (err) {
      this.#lastError = `live catalog unavailable: ${(err as Error).message}`
      // A live list already on screen beats any stale cache: keep it.
      if (published) return
      const cached = await readCache<LaneModel>(this.#cachePath)
      if (cached && cached.entries.length > 0) {
        this.#entries = cached.entries
        this.#tier = 'cache'
        return
      }
      this.#entries = [...STATIC_OPENCODE_MODELS]
      this.#tier = 'static'
    }
  }

  /** Adopt a non-empty live list, leaving a primed catalog in place otherwise. */
  #publish(entries: LaneModel[]): void {
    if (entries.length === 0) return
    this.#entries = entries
    this.#tier = 'live'
    this.#lastError = ''
  }

  /**
   * Free-filter one live list. `dev` may be absent: metadata is optional, and
   * whatever the primed catalog already knew about an id is carried over so
   * publishing early never regresses a display name or a context window.
   */
  #build(liveList: string[], dev: Record<string, ModelsDevEntry> | undefined): LaneModel[] {
    const known = new Map(this.#entries.map((entry) => [entry.id, entry]))
    const entries: LaneModel[] = []
    for (const id of liveList) {
      if (isResponsesOnly(id) && !this.#options.includeResponsesOnly) continue
      const meta = dev?.[id]
      if (!freeVerdict(id, meta)) continue
      entries.push(mergeModel(this.#toModel(id, meta), known.get(id)))
    }
    return entries
  }

  #toModel(id: string, entry: ModelsDevEntry | undefined): LaneModel {
    const model: LaneModel = { id }
    if (entry?.name) model.name = entry.name
    if (entry?.limit?.context) model.contextWindow = entry.limit.context
    if (entry?.limit?.output) model.maxOutput = entry.limit.output
    if (entry?.modalities?.input?.includes('image')) model.imageInput = true
    if (entry?.reasoning) model.reasoning = true
    return model
  }

  /** models.dev metadata with a 7-day memory cache. */
  async #loadModelsDev(): Promise<Record<string, ModelsDevEntry>> {
    if (this.#devCache && Date.now() - this.#devCache.at < 7 * 24 * 60 * 60 * 1000) return this.#devCache.value
    const value = await fetchModelsDev(this.#fetch)
    this.#devCache = { at: Date.now(), value }
    return value
  }

  async #fetchLiveList(): Promise<string[]> {
    const ids = deriveZenIds([{ role: 'user', content: 'catalog' }], this.#projectSeed)
    const res = await this.#fetch(`${this.#options.baseURL.replace(/\/+$/, '')}/v1/models`, {
      headers: { ...zenHeaders(ids) },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`GET /v1/models -> ${res.status}`)
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
    const out: string[] = []
    for (const row of body.data ?? []) {
      if (typeof row.id === 'string' && row.id && !out.includes(row.id)) out.push(row.id)
    }
    if (out.length === 0) throw new Error('GET /v1/models returned an empty list')
    return out
  }

  async *stream(model: string, options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const entry = this.entry(model)
    const shapedHolder = await buildOpenAIPayload(options, entry, (payload) => applyFreeLaneShape(payload).payload)
    const ids = deriveZenIds(shapedHolder.payload.messages, this.#projectSeed)
    // The watchdog owns this request's lifetime: when its window expires it
    // aborts this controller, so the in-flight fetch dies instead of streaming
    // on unseen. Passing the signal in is what makes the abort take effect.
    const abort = new AbortController()
    const chunks = openAiStream({
      url: `${this.#options.baseURL.replace(/\/+$/, '')}/v1/chat/completions`,
      headers: zenHeaders(ids),
      body: shapedHolder.body,
      signal: abort.signal,
      model,
      contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      label: this.id,
    })

    yield* withWatchdogs(chunks, {
      ...(this.#options.firstEventMs !== undefined ? { firstEventMs: this.#options.firstEventMs } : {}),
      ...(this.#options.bodyIdleMs !== undefined ? { bodyIdleMs: this.#options.bodyIdleMs } : {}),
      label: this.id,
      model,
      abort,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  contextWindowFor(model: string): number {
    const declared = this.entry(model)?.contextWindow
    return typeof declared === 'number' && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW
  }

  maxTokensFor(model: string): number {
    const declared = this.entry(model)?.maxOutput
    return typeof declared === 'number' && declared > 0 ? declared : DEFAULT_MAX_TOKENS
  }
}

/**
 * Overlay a freshly built model on the entry we already had for that id, so the
 * fields the live list or models.dev left out keep their primed values.
 */
export function mergeModel(fresh: LaneModel, known: LaneModel | undefined): LaneModel {
  if (!known) return fresh
  const levels = fresh.reasoningLevels ?? known.reasoningLevels
  return {
    id: fresh.id,
    ...(fresh.name ?? known.name) !== undefined ? { name: fresh.name ?? known.name } : {},
    ...(fresh.contextWindow ?? known.contextWindow) !== undefined ? { contextWindow: fresh.contextWindow ?? known.contextWindow } : {},
    ...(fresh.maxOutput ?? known.maxOutput) !== undefined ? { maxOutput: fresh.maxOutput ?? known.maxOutput } : {},
    ...(fresh.imageInput ?? known.imageInput) !== undefined ? { imageInput: fresh.imageInput ?? known.imageInput } : {},
    ...(fresh.reasoning ?? known.reasoning) !== undefined ? { reasoning: fresh.reasoning ?? known.reasoning } : {},
    ...(levels !== undefined ? { reasoningLevels: levels } : {}),
  }
}

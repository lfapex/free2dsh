import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { cacheFile, readCache, writeCache } from '../cache.ts'
import { withWatchdogs } from '../watchdog.ts'
import { buildOpenAIPayload } from '../request.ts'
import { openAiStream } from '../openai-stream.ts'
import type { HarnessChunk } from '../chunks.ts'
import type { HarnessGenerateOptions, Lane, LaneHealth, LaneModel, PluginLogger } from '../types.ts'
import { atomcodeHome, dropLiveToken, getValidAccessToken, readAtomCodeCredentials } from './atomcode-auth.ts'
import { STATIC_ATOMCODE_MODELS, parseAtomGitModels } from './atomcode-models.ts'
import { DEFAULT_CLIENT_VERSION, newNonce, signAtomCodeRequest } from './atomcode-signing.ts'

/**
 * The AtomCode lane: the AtomGit CodingPlan free lane, driven by the local
 * AtomCode CLI login and signed with `atomcode-signing-v1`.
 *
 * This lane owns its wire rather than borrowing pi-ai, because the signature
 * covers the exact request bytes — the payload is built and stringified here,
 * signed, then posted through the shared OpenAI SSE reader. Host round-robin
 * makes repeated attempts fail over instead of hammering one gateway.
 */

export const ATOMCODE_LABEL = 'AtomCode'

/** Verified AtomGit gateways, used when config.toml declares no base_url. */
export const DEFAULT_HOSTS = ['https://llm-api.atomgit.com/v1', 'https://api-ai.gitcode.com/v1']
const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 8_192

export interface AtomCodeLaneOptions {
  home: string
  models: string[]
  hosts: string[]
  clientVersion: string
  allowRefresh: boolean
  refreshSeconds: number
  /** Plugin data dir (~/.free2dsh); holds the catalog cache and token sidecar. */
  dataDir: string
  firstEventMs?: number
  bodyIdleMs?: number
  logger: PluginLogger
}

type Tier = 'live' | 'cache' | 'static'

export class AtomCodeLane implements Lane {
  readonly id = 'atomcode' as const
  readonly label = ATOMCODE_LABEL

  readonly #options: AtomCodeLaneOptions
  readonly #cachePath: string
  readonly #logger: PluginLogger
  #entries: LaneModel[] = []
  #tier: Tier = 'static'
  #lastError = ''
  #timer: NodeJS.Timeout | undefined
  #hostCursor = 0

  constructor(options: AtomCodeLaneOptions) {
    this.#options = options
    this.#cachePath = cacheFile(options.dataDir, 'atomcode')
    this.#logger = options.logger
  }

  models(): string[] {
    return this.#entries.map((entry) => entry.id)
  }

  entry(model: string): LaneModel | undefined {
    return this.#entries.find((entry) => entry.id === model || entry.name === model)
  }

  hosts(): string[] {
    const configured = this.#options.hosts.filter((host) => host.length > 0).map((host) => host.replace(/\/+$/, ''))
    if (configured.length > 0) return configured
    const derived = [...new Set(this.#entries.map((entry) => entry.baseUrl).filter((host): host is string => !!host))]
    return [...new Set([...derived, ...DEFAULT_HOSTS])]
  }

  health(): LaneHealth {
    return {
      lane: 'atomcode',
      status: this.#lastError && this.#entries.length === 0 ? 'degraded' : 'ready',
      models: this.#entries.length,
      detail: this.#lastError,
      catalog: this.#tier,
    }
  }

  /**
   * This lane's catalog is local (config.toml → cache → static), so priming it
   * is just its refresh; the guard keeps a warmed catalog from being re-read.
   */
  async prime(): Promise<void> {
    if (this.#entries.length === 0) await this.refresh()
  }

  async start(): Promise<void> {
    await this.prime()
    this.#report()
    this.#timer = setInterval(() => {
      try {
        this.refresh()
      } catch (err) {
        this.#lastError = (err as Error).message
      }
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
   * Re-read config.toml, fall back to the 7-day disk cache, then the static
   * roster. All local reads, so it is safe to run synchronously at boot and
   * the provider shows up fully populated.
   */
  async refresh(): Promise<void> {
    const configPath = join(atomcodeHome(this.#options.home), 'config.toml')
    let toml = ''
    try {
      toml = await readFile(configPath, 'utf8')
    } catch (err) {
      this.#lastError = `config.toml unreadable at ${configPath}: ${(err as Error).message}`
    }
    if (toml) {
      const entries = this.#filter(parseAtomGitModels(toml))
      if (entries.length > 0) {
        this.#entries = entries
        this.#tier = 'live'
        this.#lastError = ''
        await writeCache(this.#cachePath, entries, { hosts: this.hosts() })
        return
      }
    }
    const cached = await readCache<LaneModel>(this.#cachePath)
    if (cached && cached.entries.length > 0) {
      this.#entries = this.#filter(cached.entries)
      this.#tier = 'cache'
      if (!this.#lastError) this.#lastError = 'config.toml had no free-lane models — serving the cached roster'
      return
    }
    this.#entries = this.#filter(STATIC_ATOMCODE_MODELS)
    this.#tier = 'static'
    if (!this.#lastError) this.#lastError = 'config.toml had no free-lane models — serving the static roster'
  }

  #report(): void {
    if (this.#lastError) {
      this.#logger.warn(`free2dsh[atomcode]: catalog ${this.#tier} — ${this.models().join(', ') || '(none)'}; ${this.#lastError}`)
      return
    }
    this.#logger.info(`free2dsh[atomcode]: catalog ${this.#tier} — ${this.models().join(', ') || '(none)'} via ${this.hosts().join(', ')}`)
  }

  #filter(entries: LaneModel[]): LaneModel[] {
    const allow = this.#options.models.filter((id) => id.length > 0)
    const allowSet = new Set(allow)
    const out: LaneModel[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      if (allow.length > 0 && !allowSet.has(entry.id) && !allowSet.has(entry.name ?? '')) continue
      if (seen.has(entry.id)) continue // dsh-llm rejects duplicate ids
      seen.add(entry.id)
      out.push(entry)
    }
    return out
  }

  /**
   * Round-robin across the host list (entry's own base_url first, then the
   * configured/verified gateways) so a repeated attempt fails over instead of
   * hammering one host. Retry policy itself stays the host's job.
   */
  #pickHost(entry: LaneModel | undefined): string {
    const configured = this.#options.hosts.filter((host) => host.length > 0)
    const base = entry?.baseUrl?.replace(/\/+$/, '')
    const all = this.hosts()
    const hosts = configured.length > 0 ? configured : base ? [base, ...all.filter((host) => host !== base)] : all
    const list = hosts.length > 0 ? hosts : [DEFAULT_HOSTS[0]]
    const chosen = list[this.#hostCursor % list.length]
    this.#hostCursor = (this.#hostCursor + 1) % list.length
    return chosen.replace(/\/+$/, '')
  }

  async *stream(model: string, options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const entry = this.entry(model)
    const { body } = await buildOpenAIPayload(options, entry)
    const { accessToken, userId } = await getValidAccessToken({
      home: this.#options.home,
      allowRefresh: this.#options.allowRefresh,
      cacheDir: join(this.#options.dataDir, 'cache'),
    })

    const host = this.#pickHost(entry)
    const url = `${host}/chat/completions`
    const parsed = new URL(url)
    const clientVersion = this.#options.clientVersion.trim() || DEFAULT_CLIENT_VERSION
    const signed = signAtomCodeRequest({
      method: 'POST',
      path: parsed.pathname + parsed.search,
      body,
      accessToken,
      userId,
      clientVersion,
      timestampSeconds: Math.floor(Date.now() / 1000),
      nonce: newNonce(),
    })

    const chunks = openAiStream({
      url,
      headers: { authorization: `Bearer ${accessToken}`, ...signed },
      body,
      signal: options.signal,
      model,
      contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      label: this.id,
      onAuthFailure: () => {
        this.#logger.warn('free2dsh[atomcode]: upstream 401/403 — dropping the minted token for the next call')
        dropLiveToken(this.#options.home)
      },
    })

    yield* withWatchdogs(chunks, {
      ...(this.#options.firstEventMs !== undefined ? { firstEventMs: this.#options.firstEventMs } : {}),
      ...(this.#options.bodyIdleMs !== undefined ? { bodyIdleMs: this.#options.bodyIdleMs } : {}),
      label: this.id,
      model,
    })
  }

  /** Startup probe so a missing CLI login surfaces as a warning, not a failure. */
  async probeCredentials(): Promise<void> {
    const auth = await readAtomCodeCredentials(this.#options.home)
    const until = auth.expiresAt ? new Date(auth.expiresAt).toISOString() : 'unknown expiry'
    this.#logger.info(`free2dsh[atomcode]: AtomCode login found (user ${auth.userId.slice(0, 12)}…), token valid until ${until}`)
  }

  maxTokensFor(model: string): number {
    const declared = this.entry(model)?.maxOutput
    return typeof declared === 'number' && declared > 0 ? Math.min(declared, DEFAULT_MAX_TOKENS) : DEFAULT_MAX_TOKENS
  }

  contextWindowFor(model: string): number {
    const declared = this.entry(model)?.contextWindow
    return typeof declared === 'number' && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW
  }
}

import { toStreamChunks, type PiEvent } from '../events.ts'
import { firstUserText, deriveRequestIDs } from '../ids.ts'
import { toPiContext } from '../messages.ts'
import { withWatchdogs } from '../watchdog.ts'
import type { HarnessChunk } from '../chunks.ts'
import type { HarnessGenerateOptions, Lane, LaneHealth, LaneModel, PluginLogger } from '../types.ts'
import { ClineCatalog, clineCachePath, type ClineCatalogOptions } from './cline-catalog.ts'
import { clineRequestHeaders, defaultCredentialsPath, getValidAccessToken } from './cline-credentials.ts'

/**
 * The Cline lane: streams from Cline's OpenAI-compatible backend
 * (api.cline.bot/api/v1) with the locally logged-in Cline desktop account's
 * OAuth token, free models only.
 *
 * Unlike the AtomCode and OpenCode lanes, this one borrows its wire from
 * pi-ai's openai-completions — the same implementation DSH uses for every
 * OpenAI-compatible provider — and only adds credential injection, Cline's
 * attribution/identity headers and the free-model catalog. pi-ai is loaded
 * lazily so a broken or missing optional dependency degrades this one lane
 * instead of taking the whole plugin down.
 */

export const CLINE_LABEL = 'Cline'

const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 32_768

interface PiProvider {
  streamSimple(model: unknown, context: unknown, options: unknown): unknown
}

interface PiModules {
  createProvider: (spec: Record<string, unknown>) => PiProvider
  api: unknown
}

let piPromise: Promise<PiModules | undefined> | undefined

/** Load pi-ai once; undefined when it cannot be resolved. */
async function loadPi(): Promise<PiModules | undefined> {
  if (!piPromise) {
    piPromise = (async () => {
      try {
        const pi = (await import('@earendil-works/pi-ai')) as unknown as {
          createProvider: (spec: Record<string, unknown>) => PiProvider
        }
        const openai = (await import('@earendil-works/pi-ai/api/openai-completions')) as unknown
        return { createProvider: pi.createProvider, api: openai }
      } catch {
        return undefined
      }
    })()
  }
  return piPromise
}

function contextWindowFor(model: LaneModel | undefined): number {
  const declared = model?.contextWindow
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW
}

function maxTokensFor(model: LaneModel | undefined): number {
  const declared = model?.maxOutput
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_MAX_TOKENS
}

export interface ClineLaneOptions
  extends Pick<ClineCatalogOptions, 'baseURL' | 'credentialsPath' | 'cachePath' | 'freeOnly' | 'includeClinePass'> {
  refreshSeconds: number
  firstEventMs?: number
  bodyIdleMs?: number
  logger: PluginLogger
}

export class ClineLane implements Lane {
  readonly id = 'cline' as const
  readonly label = CLINE_LABEL

  readonly #catalog: ClineCatalog
  readonly #baseURL: string
  readonly #credentialsPath: string
  readonly #firstEventMs?: number
  readonly #bodyIdleMs?: number
  readonly #logger: PluginLogger
  readonly #refreshSeconds: number
  #timer: NodeJS.Timeout | undefined
  #provider: Promise<PiProvider | undefined> | undefined

  constructor(options: ClineLaneOptions) {
    this.#baseURL = options.baseURL.replace(/\/+$/, '')
    this.#credentialsPath = options.credentialsPath
    this.#firstEventMs = options.firstEventMs
    this.#bodyIdleMs = options.bodyIdleMs
    this.#logger = options.logger
    this.#refreshSeconds = options.refreshSeconds
    this.#catalog = new ClineCatalog(options)
  }

  models(): string[] {
    return this.#catalog.list()
  }

  entry(model: string): LaneModel | undefined {
    return this.#catalog.entry(model)
  }

  health(): LaneHealth {
    const snapshot = this.#catalog.snapshot()
    return {
      lane: 'cline',
      status: snapshot.lastError && snapshot.total === 0 ? 'degraded' : snapshot.tier === 'pending' ? 'warming' : 'ready',
      models: snapshot.total > 0 ? snapshot.total : this.#catalog.list().length,
      detail: snapshot.lastError,
      catalog: snapshot.tier,
    }
  }

  /** Tier 2: seed from the disk cache so the lane is populated before the network. */
  async prime(): Promise<void> {
    await this.#catalog.prime()
  }

  async start(): Promise<void> {
    const note = await this.#catalog.prime()
    this.#logger.info(`free2dsh[cline]: catalog ${this.#catalog.tier()} (${note})`)
    await this.#catalog.refresh()
    this.#report()
    this.#timer = setInterval(() => {
      void this.#catalog.refresh().then(() => this.#report())
    }, this.#refreshSeconds * 1000)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
  }

  #report(): void {
    const snapshot = this.#catalog.snapshot()
    if (snapshot.lastError) {
      this.#logger.warn(`free2dsh[cline]: catalog issue (${snapshot.tier}): ${snapshot.lastError}`)
      return
    }
    this.#logger.info(
      `free2dsh[cline]: catalog ${snapshot.tier} — ${snapshot.total} free models (free-bucket ${snapshot.freeBucket}, cline-pass ${snapshot.clinePass}, :free ${snapshot.openrouterFree})`,
    )
  }

  /** Build (once) the pi-ai provider bound to this lane's base + credentials. */
  #piProvider(): Promise<PiProvider | undefined> {
    if (!this.#provider) {
      this.#provider = (async () => {
        const pi = await loadPi()
        if (!pi) return undefined
        const credentialsPath = this.#credentialsPath
        return pi.createProvider({
          id: 'free2dsh-cline',
          name: CLINE_LABEL,
          baseUrl: this.#baseURL,
          auth: {
            apiKey: {
              name: 'Cline account token',
              resolve: async () => {
                const creds = await getValidAccessToken({ baseURL: this.#baseURL, credentialsPath })
                return { auth: { apiKey: creds.accessToken } }
              },
            },
          },
          models: [],
          api: pi.api,
        })
      })()
    }
    return this.#provider
  }

  async *stream(model: string, options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const provider = await this.#piProvider()
    if (!provider) {
      // The watchdog turns this into a terminal usage+finish pair.
      throw new Error('pi-ai is unavailable — install @earendil-works/pi-ai or disable the cline lane')
    }
    const entry = this.entry(model)
    const context = await toPiContext(options)
    const ids = deriveRequestIDs({
      model,
      system: typeof options.system === 'string' ? options.system : undefined,
      firstMessageText: firstUserText(options.messages),
    })
    const piModel = {
      id: model,
      name: entry?.name ?? model,
      api: 'openai-completions',
      provider: 'free2dsh-cline',
      baseUrl: this.#baseURL,
      reasoning: entry?.reasoning === true,
      input: entry?.imageInput ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: contextWindowFor(entry),
      maxTokens: maxTokensFor(entry),
    }
    const { accessToken, accountId } = await getValidAccessToken({ baseURL: this.#baseURL, credentialsPath: this.#credentialsPath })

    // The watchdog owns this request's lifetime: when its window expires it
    // aborts this controller, so pi-ai's in-flight request dies instead of
    // streaming on unseen.
    const abort = new AbortController()
    const events = provider.streamSimple(piModel, context, {
      apiKey: accessToken,
      sessionId: ids.session,
      headers: clineRequestHeaders(accountId),
      signal: abort.signal,
      maxRetries: 0,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    }) as AsyncIterable<PiEvent>

    yield* withWatchdogs(toStreamChunks(events, piModel.contextWindow), {
      ...(this.#firstEventMs !== undefined ? { firstEventMs: this.#firstEventMs } : {}),
      ...(this.#bodyIdleMs !== undefined ? { bodyIdleMs: this.#bodyIdleMs } : {}),
      label: this.id,
      model,
      abort,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }
}

export { defaultCredentialsPath }

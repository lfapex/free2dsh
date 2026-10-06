import { errorFinish, terminalChunks, type HarnessChunk } from './chunks.ts'
import type { UnifiedCatalog, UnifiedModel } from './catalog.ts'
import type { HarnessGenerateOptions, Lane } from './types.ts'
import { withWatchdogs } from './watchdog.ts'

/**
 * The dsh-llm adapter for every free lane.
 *
 * Contract (structural, no host import): providerInfo / providerRetryPolicy /
 * imageRequestPricing / listModels / resolveModel / prepareCall / stream. The
 * adapter owns no credentials and no wire format — it resolves a picker id to
 * its lane, then hands the call over. Retry policy stays the host's job.
 *
 * A lane's own stream already runs under the shared watchdog; this outer pass
 * is the backstop for a lane that throws before returning its generator, so
 * dsh-llm always sees a terminal `usage` + `finish` pair.
 */

export interface AdapterOptions {
  catalog: UnifiedCatalog
  firstEventMs?: number
  bodyIdleMs?: number
}

export class Free2dshAdapter {
  readonly #catalog: UnifiedCatalog
  readonly #firstEventMs?: number
  readonly #bodyIdleMs?: number

  constructor(options: AdapterOptions) {
    this.#catalog = options.catalog
    this.#firstEventMs = options.firstEventMs
    this.#bodyIdleMs = options.bodyIdleMs
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  /** undefined = the host default retry policy. */
  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /** Advisory catalog for the DSH model picker (deduped; dsh-llm rejects duplicates). */
  listModels(provider: string): Array<{ provider: string; id: string; name: string; inputModalities: string[] }> {
    return this.#catalog.list(provider).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
    }))
  }

  resolveModel(provider: string, model: string): {
    provider: string
    id: string
    name: string
    inputModalities: string[]
    context: { contextWindow: number }
    defaultMaxTokens: number
  } {
    const entry = this.#catalog.resolve(provider, model)
    if (!entry) {
      // Unknown id: answer with conservative limits rather than throwing, so a
      // stale picker entry degrades to one failed turn instead of a broken
      // provider.
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: 200_000 },
        defaultMaxTokens: 8_192,
      }
    }
    return this.#toResolved(provider, this.#describe(provider, model, entry.lane, entry.model))
  }

  async prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<{
    model: ReturnType<Free2dshAdapter['resolveModel']>
    stream: (options: HarnessGenerateOptions) => AsyncGenerator<HarnessChunk>
  }> {
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.stream(provider, model, options),
    }
  }

  /** Route one completion to the lane that owns `model`. */
  async *stream(provider: string, model: string, options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const resolved = this.#catalog.resolve(provider, model)
    if (!resolved) {
      yield* terminalChunks(
        errorFinish(
          `free2dsh: unknown model "${model}" on provider "${provider}" — the catalog may be warming up, or the id belongs to another lane`,
          'UNKNOWN_MODEL',
        ),
      )
      return
    }

    let inner: AsyncIterable<HarnessChunk>
    try {
      inner = resolved.lane.stream(resolved.bare, { ...options, provider, model: resolved.bare })
    } catch (err) {
      yield* terminalChunks(errorFinish(`free2dsh[${resolved.lane.id}]: ${(err as Error).message}`))
      return
    }

    // The lane wraps itself in the same watchdog; this pass only catches a
    // throw that escapes lane.stream() before its generator body ran.
    const source: AsyncIterable<HarnessChunk> = {
      [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
    }
    yield* withWatchdogs(source, {
      ...(this.#firstEventMs !== undefined ? { firstEventMs: this.#firstEventMs } : {}),
      ...(this.#bodyIdleMs !== undefined ? { bodyIdleMs: this.#bodyIdleMs } : {}),
      label: resolved.lane.id,
      model: resolved.bare,
    })
  }

  #describe(provider: string, model: string, lane: Lane, entry: { id: string; name?: string; contextWindow?: number; maxOutput?: number; imageInput?: boolean }): UnifiedModel {
    const all = this.#catalog.list(provider)
    const found = all.find((candidate) => candidate.id === model || candidate.bare === entry.id)
    if (found) return found
    const bare = this.#catalog.isLaneRoute(provider)
    return {
      id: bare ? model : `${lane.id}/${entry.id}`,
      bare: entry.id,
      lane: lane.id,
      label: lane.label,
      name: bare ? (entry.name ?? entry.id) : `${entry.name ?? entry.id} · ${lane.label}`,
      contextWindow: typeof entry.contextWindow === 'number' && entry.contextWindow > 0 ? entry.contextWindow : 200_000,
      maxTokens: typeof entry.maxOutput === 'number' && entry.maxOutput > 0 ? entry.maxOutput : 8_192,
      inputModalities: entry.imageInput ? ['text', 'image'] : ['text'],
    }
  }

  #toResolved(
    provider: string,
    model: UnifiedModel,
  ): {
    provider: string
    id: string
    name: string
    inputModalities: string[]
    context: { contextWindow: number }
    defaultMaxTokens: number
  } {
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
    }
  }
}

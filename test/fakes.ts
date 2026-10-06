import type { HarnessChunk } from '../src/chunks.ts'
import type { HarnessGenerateOptions, Lane, LaneHealth, LaneId, LaneModel } from '../src/types.ts'

/** In-memory lane used by the catalog / adapter / watchdog tests. */
export class FakeLane implements Lane {
  readonly id: LaneId
  readonly label: string
  readonly models_: LaneModel[]
  #started = 0
  #stopped = 0
  /** Overrides the default echo stream. */
  respond?: (model: string, options: HarnessGenerateOptions) => AsyncIterable<HarnessChunk>
  /** Makes stream() throw synchronously (before returning a generator). */
  throwOnStream?: Error

  constructor(id: LaneId, label: string, models: LaneModel[]) {
    this.id = id
    this.label = label
    this.models_ = models
  }

  models(): string[] {
    return this.models_.map((model) => model.id)
  }

  entry(model: string): LaneModel | undefined {
    return this.models_.find((candidate) => candidate.id === model)
  }

  health(): LaneHealth {
    return { lane: this.id, status: 'ready', models: this.models_.length, detail: '', catalog: 'live' }
  }

  async start(): Promise<void> {
    this.#started += 1
  }

  stop(): void {
    this.#stopped += 1
  }

  get startCount(): number {
    return this.#started
  }

  get stopCount(): number {
    return this.#stopped
  }

  stream(model: string, options: HarnessGenerateOptions): AsyncIterable<HarnessChunk> {
    if (this.throwOnStream) throw this.throwOnStream
    if (this.respond) return this.respond(model, options)
    return echoStream(model, options)
  }
}

export async function* echoStream(model: string, options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
  const question = options.messages
    .flatMap((message) => message.content)
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: `${model}: ${question}` }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: `${model}: ${question}` } }
  yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

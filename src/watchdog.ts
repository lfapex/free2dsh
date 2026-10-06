import { terminalChunks, errorFinish, type HarnessChunk } from './chunks.ts'

/**
 * Stream-liveness watchdog, shared by every lane.
 *
 * Neither fetch nor pi-ai owns a body-silence timeout, so a tunnel that
 * connects but never streams would hang the turn forever. Two windows apply:
 * FIRST-EVENT until the first chunk lands (connect stage answers in seconds)
 * and BODY-IDLE once chunks flow (minutes of mid-stream silence is a dead
 * tunnel, not pacing). Timeout-promise racing is the only mechanism that
 * actually interrupts a hung next().
 *
 * The wrapper also guarantees the contract every lane owes dsh-llm: the stream
 * ends with `usage` then `finish`, on every path including a timeout, an early
 * upstream close, and a lane that threw before emitting anything.
 */

export const DEFAULT_FIRST_EVENT_MS = 30_000
export const DEFAULT_BODY_IDLE_MS = 120_000

/** Thrown by the deadline promise; caught by the wrapper, never escapes. */
export class WatchdogTimeout extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'WatchdogTimeout'
    this.code = code
  }
}

export interface WatchdogOptions {
  /** ms to wait for the first chunk. */
  firstEventMs?: number
  /** ms of body silence tolerated once chunks flow. */
  bodyIdleMs?: number
  /** Lane id, for the failure message. */
  label: string
  /** Model id, for the failure message. */
  model: string
}

const CLOSE_GRACE_MS = 100

/** Close an async iterator, giving up after a short grace period. */
async function closeIterator(iterator: AsyncIterator<HarnessChunk>): Promise<void> {
  let closing: Promise<IteratorResult<HarnessChunk> | void> | undefined
  try {
    closing = iterator.return?.(undefined)
  } catch {
    return
  }
  if (!closing) return
  let grace: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.resolve(closing).catch(() => {}),
    new Promise<void>((resolve) => {
      grace = setTimeout(resolve, CLOSE_GRACE_MS)
      grace.unref?.()
    }),
  ])
  clearTimeout(grace)
}

export async function* withWatchdogs(
  source: AsyncIterable<HarnessChunk>,
  options: WatchdogOptions,
): AsyncGenerator<HarnessChunk> {
  const firstEventMs = options.firstEventMs ?? DEFAULT_FIRST_EVENT_MS
  const bodyIdleMs = options.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS
  const label = options.label
  const firstMessage = `free2dsh[${label}]: timed out after ${firstEventMs}ms waiting for the first stream event (${options.model})`
  const idleMessage = `free2dsh[${label}]: stream went silent for ${bodyIdleMs}ms mid-response (${options.model})`

  const iterator = source[Symbol.asyncIterator]()
  const buffered: HarnessChunk[] = []
  let sawAny = false
  let finished = false
  let lastChunkAt = Date.now()
  let timer: NodeJS.Timeout | undefined

  const deadline = (): Promise<never> => {
    clearTimeout(timer)
    const window = sawAny ? bodyIdleMs : firstEventMs
    const message = sawAny ? idleMessage : firstMessage
    const ms = Math.max(0, window - (Date.now() - lastChunkAt))
    return new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WatchdogTimeout(message, sawAny ? 'TIMEOUT_IDLE' : 'TIMEOUT_FIRST_EVENT')), ms)
      timer.unref?.()
    })
  }

  const pull = async (): Promise<IteratorResult<HarnessChunk>> => {
    try {
      return await Promise.race([iterator.next(), deadline()])
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    // Peek phase: hold the terminal pair back until the stream proves itself,
    // so a fast upstream close never swallows a real answer.
    for (;;) {
      const next = await pull()
      if (next.done) break
      lastChunkAt = Date.now()
      sawAny = true
      buffered.push(next.value)
      if (next.value.type === 'finish' || next.value.type !== 'usage') break
    }
    for (const chunk of buffered) {
      if (chunk.type === 'finish') finished = true
      yield chunk
    }
    buffered.length = 0

    // Live pump: the first real chunk already flushed, so stream on.
    for (;;) {
      const next = await pull()
      if (next.done) break
      lastChunkAt = Date.now()
      yield next.value
      if (next.value.type === 'finish') {
        finished = true
        return
      }
    }
  } catch (err) {
    clearTimeout(timer)
    const message = err instanceof Error ? err.message : String(err)
    if (!finished) yield* terminalChunks(errorFinish(`free2dsh[${label}]: ${message}`, err instanceof WatchdogTimeout ? err.code : undefined))
    finished = true
    return
  } finally {
    clearTimeout(timer)
    // Closing a generator that is parked mid-`await` never settles: the return
    // completion queues behind the pending next(). Bound the wait so a dead
    // upstream costs a fixed grace period, not a hung turn.
    await closeIterator(iterator)
  }

  // Ran dry without a finish chunk: the lane's own terminator never arrived.
  if (!finished) {
    yield* terminalChunks(errorFinish(`free2dsh[${label}]: stream ended without a finish event (${options.model})`, 'UPSTREAM'))
  }
}

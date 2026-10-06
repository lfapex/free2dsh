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
 * A timeout must also STOP the work, not just stop reporting it. Racing the
 * deadline abandons a pending next() that is still parked on the socket, so
 * every lane receives an AbortController and the watchdog aborts on the way
 * out. Without it a timed-out turn leaves its HTTP request streaming: the
 * socket, the upstream generation and the credentials are all still pinned
 * until the response finishes on its own.
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
  /**
   * The controller for the upstream request. The watchdog aborts it when a
   * window expires or the turn ends, so a timed-out turn releases its socket
   * instead of streaming on unseen. Lanes own it because they — not the
   * watchdog — build the request that needs the signal.
   */
  abort?: AbortController
  /** The caller's own cancel signal, folded into the watchdog's deadline. */
  signal?: AbortSignal
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

  // The lane's controller owns the upstream's lifetime: a timeout aborts it,
  // and the caller's own signal is folded in so an external cancel aborts too.
  const controller = options.abort
  let detachCaller = (): void => {}
  if (controller && options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason)
    else {
      const forward = () => controller.abort(options.signal?.reason)
      options.signal.addEventListener('abort', forward, { once: true })
      detachCaller = () => options.signal?.removeEventListener('abort', forward)
    }
  }

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
      timer = setTimeout(() => {
        // Stop the upstream request as we stop waiting on it: an abandoned
        // next() is still parked on the socket, so without this the turn keeps
        // burning a connection (and the model's tokens) after we gave up.
        const timeout = new WatchdogTimeout(message, sawAny ? 'TIMEOUT_IDLE' : 'TIMEOUT_FIRST_EVENT')
        if (controller && !controller.signal.aborted) controller.abort(timeout)
        reject(timeout)
      }, ms)
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
    if (!finished) yield* terminalChunks(errorFinish(`${message}`, err instanceof WatchdogTimeout ? err.code : undefined))
    finished = true
    return
  } finally {
    clearTimeout(timer)
    detachCaller()
    // The turn is over either way, so release the upstream connection even on
    // the success path — a consumer that breaks early must not leave the lane
    // mid-stream.
    if (controller && !controller.signal.aborted) controller.abort()
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

/**
 * Harness StreamChunk vocabulary plus the terminal helpers every lane shares.
 *
 * The chunk stream must end with `usage` then `finish`; lanes that build their
 * own wire (AtomCode, OpenCode Zen) emit chunks directly, lanes that borrow a
 * library stream (Cline via pi-ai) map its events onto the same vocabulary.
 * Derived from cline2dsh/events.ts and atomcode2dsh/chunks.ts, which are both
 * clean-room ports of dsh-llm-pi-ai's toStreamChunks.
 */

export type HarnessChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | {
      type: 'block-end'
      index: number
      block: { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'tool-call'; id: string; name: string; arguments: string }
    }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'max-tokens' }
  | { kind: 'tool-calls' }
  | { kind: 'aborted'; failure: { message: string; code: string } }
  | { kind: 'error'; failure: { message: string; code: string } }

export const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED = 'QUOTA_EXCEEDED'

/** Upstream error text -> harness failure code. */
export function classifyError(text: string): string {
  if (/\bRegionError\b|not available in your country/i.test(text)) return 'REGION_BLOCKED'
  if (/\b(?:401|403)\b|unauthor|forbidden|invalid.?token/i.test(text)) return 'AUTH'
  if (/insufficient|quota|billing|credit/i.test(text)) return QUOTA_EXCEEDED
  if (/\b429\b|rate.?limit/i.test(text)) return 'RATE_LIMIT'
  if (/\b413\b|payload too large|request body too large/i.test(text)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(text)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(text)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return 'TIMEOUT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|terminated|premature close/i.test(text)) return 'NETWORK'
  return 'UPSTREAM'
}

export function errorFinish(message: string, code?: string): FinishReason {
  return { kind: 'error', failure: { message, code: code ?? classifyError(message) } }
}

export function abortedFinish(message = 'free2dsh: stream aborted'): FinishReason {
  return { kind: 'aborted', failure: { message, code: 'ABORTED' } }
}

/** Terminal usage + finish pair for a stream that failed before/while streaming. */
export function* terminalChunks(reason: FinishReason): Generator<HarnessChunk> {
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason }
}

/** Detect a context-overflow failure reported upstream. */
export function contextOverflowFinish(message: string): FinishReason {
  if (/context/i.test(message) && /exceed|window|length|token/i.test(message)) {
    return { kind: 'error', failure: { message, code: CONTEXT_WINDOW_EXCEEDED } }
  }
  return errorFinish(message)
}

export function emptyResponseFinish(model: string): FinishReason {
  return {
    kind: 'error',
    failure: { message: `model "${model}" returned a completed response with no content`, code: EMPTY_RESPONSE },
  }
}

/** Normalise a chunk stream into text/reasoning/tool text for diagnostics. */
export function textOf(chunks: Iterable<HarnessChunk>): string {
  let out = ''
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') out += chunk.text
  }
  return out
}

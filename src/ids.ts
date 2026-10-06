import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { HarnessMessage } from './types.ts'

/**
 * Stable per-conversation identifiers for upstream correlation headers.
 *
 * Both the Cline and the OpenCode Zen backends are keyed on a session id so
 * upstream prompt caching can hit across the growing history of a
 * conversation. We derive it the way the real clients do: a SHA-256 over the
 * conversation's first user turn (stable across retries of the same turn,
 * different across turns), plus a fresh id per request.
 */

/** First user turn keeps a conversation stable across its growing history. */
export function conversationSeed(messages: Array<{ role?: unknown; content?: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return randomBytes(16).toString('hex')
}

export function firstUserText(messages: HarnessMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('')
    if (text.length > 0) return text
  }
  return ''
}

function hashParts(...parts: Array<string | undefined>): string {
  const h = createHash('sha256')
  for (const part of parts) {
    h.update(part ?? '\u0000')
    h.update('\u0001')
  }
  return h.digest('hex')
}

export interface RequestIDs {
  /** Conversation-stable id. */
  session: string
  /** Fresh per request. */
  request: string
}

/**
 * Cline's header set: a 32-hex session id plus a UUID request id.
 * Derived from (model, system prompt, first user message) so a retry of the
 * same turn reuses the session while the next turn rolls a new one.
 */
export function deriveRequestIDs(options: {
  model: string
  system?: string | undefined
  firstMessageText?: string | undefined
}): RequestIDs {
  const session = hashParts(options.model, options.system, options.firstMessageText).slice(0, 32)
  return { session, request: randomUUID() }
}

/* ------------------------------------------------------------------ */
/* OpenCode Zen's canonical id shapes                                    */
/* ------------------------------------------------------------------ */

const ZEN_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * "ses_" + 12 hex + 14 base62 — the only session shape Zen's anonymous lane
 * accepts. Anything else is reshaped deterministically from the seed, so the
 * same conversation always lands on the same session id.
 */
export function canonicalSessionId(seed: string): string {
  if (ZEN_SESSION_PATTERN.test(seed)) return seed
  const sum = createHash('sha256').update(`ses\u0000${seed}`).digest()
  const timePart = sum.subarray(0, 6).toString('hex')
  let n = BigInt(`0x${sum.subarray(6, 16).toString('hex')}`)
  const randomPart: string[] = []
  for (let i = 0; i < 14; i += 1) {
    randomPart.unshift(BASE62[Number(n % 62n)])
    n /= 62n
  }
  return `ses_${timePart}${randomPart.join('')}`
}

export interface ZenIDs {
  session: string
  request: string
  project: string
}

export function deriveZenIds(messages: Array<{ role?: unknown; content?: unknown }>, projectSeed: string): ZenIDs {
  return {
    session: canonicalSessionId(conversationSeed(messages)),
    request: `req_${randomBytes(16).toString('hex')}`,
    project: `prj_${createHash('sha256').update(`prj\u0000${projectSeed}`).digest().subarray(0, 12).toString('hex')}`,
  }
}

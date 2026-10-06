import { emptyResponseFinish, errorFinish, terminalChunks, type FinishReason, type HarnessChunk } from './chunks.ts'
import { SseParser } from './sse.ts'

/**
 * OpenAI-compatible streaming wire -> harness chunks.
 *
 * POST {base}/chat/completions with `stream: true` + `stream_options
 * .include_usage`, parse the SSE body and emit harness chunks (block-start /
 * deltas / block-end, then `usage` + `finish`). Shared by every lane that owns
 * its wire: AtomCode signs the body bytes it hands to `openAiStream`, OpenCode
 * Zen needs no signing but the same event grammar.
 */

export interface OpenAiStreamRequest {
  url: string
  /** Full header set (auth + lane identity/signature). */
  headers: Record<string, string>
  /** Exact body bytes to post — must be the bytes that were signed. */
  body: Buffer
  signal?: AbortSignal
  /** DSH-facing model id, for error messages. */
  model: string
  contextWindow: number
  /** Lane id prefix for messages, e.g. "atomcode". */
  label: string
  /** 401/403 hook: drop a minted token so the next call re-reads auth.toml. */
  onAuthFailure?: () => void
}

interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string | null
        type?: string | null
        function?: { name?: string | null; arguments?: string | null }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: OpenAIUsage
  error?: { message?: string; code?: string | number } | string
}

function usageChunk(usage: OpenAIUsage | undefined, fallback: boolean): Extract<HarnessChunk, { type: 'usage' }>['usage'] {
  const input = usage?.prompt_tokens ?? 0
  const output = usage?.completion_tokens ?? 0
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0
  if (!usage && fallback) return { inputTokens: 0, outputTokens: 0 }
  return {
    inputTokens: input,
    // Reasoning tokens are billed as output on the free lanes; keep the
    // accounting honest rather than dropping them.
    outputTokens: output + (reasoning > 0 && output === 0 ? reasoning : 0),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}

function finishFromReason(finishReason: string | null | undefined, sawContent: boolean, model: string): FinishReason {
  switch (finishReason) {
    case 'length':
      return { kind: 'max-tokens' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'content_filter':
      return errorFinish(`model "${model}" hit the upstream content filter`, 'CONTENT_FILTER')
    default:
      return sawContent ? { kind: 'stop' } : emptyResponseFinish(model)
  }
}

export async function* openAiStream(request: OpenAiStreamRequest): AsyncGenerator<HarnessChunk> {
  const label = request.label
  let res: Response
  try {
    res = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...request.headers },
      body: request.body,
      signal: request.signal,
    })
  } catch (err) {
    const message = (err as Error).message ?? String(err)
    const aborted = (err as Error).name === 'AbortError' || request.signal?.aborted === true
    yield* terminalChunks(
      aborted ? { kind: 'aborted', failure: { message: `free2dsh[${label}]: aborted`, code: 'ABORTED' } } : errorFinish(`free2dsh[${label}]: request failed: ${message}`),
    )
    return
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) request.onAuthFailure?.()
    let text = ''
    try {
      text = (await res.text()).slice(0, 1200)
    } catch {
      /* body may be empty */
    }
    const detail = text.length > 0 ? `: ${text}` : ''
    yield* terminalChunks(
      res.status === 401 || res.status === 403
        ? errorFinish(`free2dsh[${label}]: upstream rejected the session (HTTP ${res.status})${detail}`, 'AUTH')
        : errorFinish(`free2dsh[${label}]: upstream HTTP ${res.status}${detail}`),
    )
    return
  }

  if (!res.body) {
    yield* terminalChunks(errorFinish(`free2dsh[${label}]: upstream returned no response body`))
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const parser = new SseParser()

  let usage: OpenAIUsage | undefined
  let finishReason: string | null | undefined
  let sawContent = false
  let sawAnything = false
  let done = false

  // Open block bookkeeping. Indexes are ours (appended block positions), not
  // the upstream tool_call indexes.
  let nextIndex = 0
  let reasoning: { index: number; text: string } | undefined
  let text: { index: number; text: string } | undefined
  const tools = new Map<number, { index: number; id: string; name: string; args: string }>()
  let failure: FinishReason | undefined

  try {
    for (;;) {
      const { done: streamDone, value } = await reader.read()
      if (streamDone) break
      const decoded = decoder.decode(value, { stream: true })
      for (const event of parser.push(decoded)) {
        const data = event.data.trim()
        if (data === '[DONE]') {
          done = true
          break
        }
        let chunk: OpenAIChunk
        try {
          chunk = JSON.parse(data) as OpenAIChunk
        } catch {
          continue // keep-alive garbage rather than killing the turn
        }
        sawAnything = true
        if (chunk.usage) usage = chunk.usage
        const errorField = chunk.error
        if (errorField && !chunk.choices) {
          const message = typeof errorField === 'string' ? errorField : (errorField.message ?? JSON.stringify(errorField))
          failure = errorFinish(`free2dsh[${label}]: ${message}`)
          break
        }
        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason
        const delta = choice.delta
        if (!delta) continue

        const reasoningDelta = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          sawContent = true
          if (!reasoning) {
            reasoning = { index: nextIndex++, text: '' }
            yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' }
          }
          reasoning.text += reasoningDelta
          yield { type: 'reasoning-delta', index: reasoning.index, text: reasoningDelta }
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          sawContent = true
          if (!text) {
            text = { index: nextIndex++, text: '' }
            yield { type: 'block-start', index: text.index, blockType: 'text' }
          }
          text.text += delta.content
          yield { type: 'text-delta', index: text.index, text: delta.content }
        }

        for (const part of delta.tool_calls ?? []) {
          sawContent = true
          const slot = part.index ?? 0
          let state = tools.get(slot)
          if (!state) {
            state = { index: nextIndex++, id: part.id ?? '', name: part.function?.name ?? '', args: '' }
            tools.set(slot, state)
            yield { type: 'block-start', index: state.index, blockType: 'tool-call' }
          }
          if (typeof part.id === 'string' && part.id.length > 0 && state.id.length === 0) state.id = part.id
          if (typeof part.function?.name === 'string' && part.function.name.length > 0 && state.name.length === 0) {
            state.name = part.function.name
          }
          const args = part.function?.arguments ?? ''
          if (args.length > 0) {
            state.args += args
            yield {
              type: 'tool-call-delta',
              index: state.index,
              id: state.id,
              ...(state.name ? { name: state.name } : {}),
              argumentsDelta: args,
            }
          }
        }
      }
      if (done || failure) break
    }
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError' || request.signal?.aborted === true
    failure = aborted
      ? { kind: 'aborted', failure: { message: `free2dsh[${label}]: aborted`, code: 'ABORTED' } }
      : errorFinish(`free2dsh[${label}]: stream failed: ${(err as Error).message ?? String(err)}`)
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }

  // Close open blocks before the terminal pair.
  if (failure && !sawAnything) {
    yield* terminalChunks(failure)
    return
  }
  if (reasoning) yield { type: 'block-end', index: reasoning.index, block: { type: 'reasoning', text: reasoning.text } }
  if (text) yield { type: 'block-end', index: text.index, block: { type: 'text', text: text.text } }
  for (const state of tools.values()) {
    yield { type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args } }
  }

  yield { type: 'usage', usage: usageChunk(usage, true) }

  if (failure) {
    yield { type: 'finish', reason: failure }
    return
  }
  if (request.signal?.aborted === true) {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: `free2dsh[${label}]: aborted`, code: 'ABORTED' } } }
    return
  }
  let reason = finishFromReason(finishReason, sawContent, request.model)
  // Upstreams that end without a finish_reason but with tool calls still
  // mean "the model wants to call tools".
  if (reason.kind === 'stop' && finishReason == null && tools.size > 0) reason = { kind: 'tool-calls' }
  // A `tool-calls` finish with no tool call on the wire is a dead end: the
  // harness would be told to run tools that do not exist and the turn ends
  // without any output. Downgrade to a plain stop so whatever content did
  // arrive (reasoning/text) still stands as the turn's answer.
  if (reason.kind === 'tool-calls' && tools.size === 0) {
    reason = sawContent ? { kind: 'stop' } : emptyResponseFinish(request.model)
  }
  yield { type: 'finish', reason }
}

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SseParser } from '../src/sse.ts'
import { buildOpenAIPayload, reasoningEffortFor, systemText } from '../src/request.ts'
import { applyFreeLaneShape, freeVerdict, OpenCodeLane } from '../src/lanes/opencode.ts'
import { openAiStream } from '../src/openai-stream.ts'
import type { HarnessGenerateOptions, PluginLogger } from '../src/types.ts'

const silent: PluginLogger = { info() {}, warn() {}, error() {}, debug() {} }

test('SseParser: joins multi-line data and drops comments', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push(': keep-alive\n'), [])
  const events = parser.push('data: {"a":1}\n\ndata: {"b":\ndata: 2}\n\n')
  assert.deepEqual(events.map((event) => event.data), ['{"a":1}', '{"b":\n2}'])
})

test('SseParser: carries a partial event across chunk boundaries', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('data: {"id":'), [])
  assert.deepEqual(parser.push('"x"}\n\n').map((event) => event.data), ['{"id":"x"}'])
})

test('SseParser: flush emits a trailing event with no blank line', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('data: tail'), [])
  assert.deepEqual(parser.flush().map((event) => event.data), ['tail'])
  assert.deepEqual(parser.flush(), [], 'flushing twice is safe')
})

const ask = (overrides: Partial<HarnessGenerateOptions> = {}): HarnessGenerateOptions => ({
  provider: 'free2dsh',
  model: 'free2dsh/m',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  ...overrides,
})

test('buildOpenAIPayload: system prompt first, then the conversation', async () => {
  const { payload } = await buildOpenAIPayload(ask({ system: 'be brief' }), { id: 'm' })
  assert.equal(payload.model, 'm', 'the wire model id is the bare upstream id')
  assert.equal(payload.stream, true)
  assert.deepEqual(payload.stream_options, { include_usage: true })
  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ])
})

test('buildOpenAIPayload: assistant tool calls become tool_calls, tool results become tool messages', async () => {
  const { payload } = await buildOpenAIPayload(
    ask({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'on it' },
            { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file body' }] },
          ],
        },
      ],
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    }),
    undefined,
  )
  assert.deepEqual(payload.messages, [
    { role: 'user', content: 'read a.txt' },
    {
      role: 'assistant',
      content: 'on it',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'file body' },
  ])
  assert.deepEqual(payload.tools, [
    { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } },
  ])
  assert.equal(payload.tool_choice, 'auto')
})

test('buildOpenAIPayload: the body bytes are the exact stringified payload', async () => {
  const { payload, body } = await buildOpenAIPayload(ask(), { id: 'm' })
  assert.equal(body.toString('utf8'), JSON.stringify(payload), 'AtomCode signs these bytes')
})

test('buildOpenAIPayload: transform gets the last word on the body', async () => {
  const { payload } = await buildOpenAIPayload(ask(), { id: 'm' }, (body) => ({ ...body, temperature: 0 }))
  assert.equal(payload.temperature, 0)
})

test('systemText: string, block array, and everything else', () => {
  assert.equal(systemText('plain'), 'plain')
  assert.equal(systemText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(systemText(42), '')
})

test('reasoningEffortFor: off means no field, the declared ladder wins', () => {
  assert.equal(reasoningEffortFor(ask({ reasoning: 'off' })), undefined)
  assert.equal(reasoningEffortFor(ask({ reasoning: 'xhigh' }), ['low', 'medium', 'xhigh']), 'xhigh')
  assert.equal(reasoningEffortFor(ask({ reasoning: 'high' })), 'high')
  assert.equal(reasoningEffortFor(ask({ reasoning: 'minimal' })), 'low')
  assert.equal(reasoningEffortFor(ask({ reasoning: 'high' }), ['low']), undefined, 'not offered by this model')
})

test('applyFreeLaneShape: injects the reserved gate tools and forces streaming', () => {
  const { payload, injected } = applyFreeLaneShape({ model: 'm', messages: [], stream: true })
  assert.equal(injected, true)
  assert.equal(payload.stream, true)
  assert.equal(payload.tool_choice, 'none')
  const names = (payload.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
  assert.deepEqual(names, ['bash', 'read'])
})

test('applyFreeLaneShape: leaves the caller tools alone and still adds the gate', () => {
  const { payload, injected } = applyFreeLaneShape({
    model: 'm',
    messages: [],
    stream: true,
    tools: [{ type: 'function', function: { name: 'bash' } }],
    tool_choice: 'auto',
  })
  assert.equal(injected, true)
  const names = (payload.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
  assert.deepEqual(names, ['bash', 'read'])
  assert.equal(payload.tool_choice, 'auto')
})

test('applyFreeLaneShape: nothing to inject when the caller already sent both', () => {
  const { injected } = applyFreeLaneShape({
    model: 'm',
    messages: [],
    stream: true,
    tools: [
      { type: 'function', function: { name: 'bash' } },
      { type: 'function', function: { name: 'read' } },
    ],
  })
  assert.equal(injected, false)
})

test('freeVerdict: id, metadata cost, and the known-unusable ids', () => {
  assert.equal(freeVerdict('mimo-v2.6-flash-free', undefined), true)
  assert.equal(freeVerdict('zero-cost-model', { cost: { input: 0, output: 0 } }), true)
  assert.equal(freeVerdict('paid-model', { cost: { input: 3, output: 15 } }), false)
  assert.equal(freeVerdict('deepseek-v4-flash-free', { cost: { input: 0, output: 0 } }), false, 'auth-only in practice')
  assert.equal(freeVerdict('jev-1.13-free', undefined), false)
  assert.equal(freeVerdict('anything', { deprecated: true }), false)
})

/** One SSE body from scripted `data:` payload lines. */
function sseResponse(payloads: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      for (const payload of payloads) controller.enqueue(enc.encode(`data: ${payload}\n\n`))
      controller.enqueue(enc.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('openAiStream: a tool-calls finish with no tool call downgrades to stop, not a dangling finish', async () => {
  const stub = async () =>
    sseResponse([
      '{"choices":[{"delta":{"reasoning_content":"Let me read it."}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '{"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    ])
  const original = globalThis.fetch
  globalThis.fetch = stub as typeof fetch
  try {
    const out = []
    for await (const chunk of openAiStream({
      url: 'https://zen.invalid/v1/chat/completions',
      headers: {},
      body: Buffer.from('{}'),
      model: 'm',
      contextWindow: 200_000,
      label: 'opencode',
    })) {
      out.push(chunk)
    }
    const finish = out.find((chunk) => chunk.type === 'finish') as { reason: { kind: string } }
    assert.equal(finish.reason.kind, 'stop', 'a dangling tool-calls finish would strand the harness mid-task')
    assert.ok(out.some((chunk) => chunk.type === 'block-end' && (chunk.block as { type: string }).type === 'reasoning'))
  } finally {
    globalThis.fetch = original
  }
})

test('openAiStream: real tool calls still finish as tool-calls', async () => {
  const stub = async () =>
    sseResponse([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{\\"pa"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\"}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '{"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    ])
  const original = globalThis.fetch
  globalThis.fetch = stub as typeof fetch
  try {
    const out = []
    for await (const chunk of openAiStream({
      url: 'https://zen.invalid/v1/chat/completions',
      headers: {},
      body: Buffer.from('{}'),
      model: 'm',
      contextWindow: 200_000,
      label: 'opencode',
    })) {
      out.push(chunk)
    }
    const finish = out.find((chunk) => chunk.type === 'finish') as { reason: { kind: string } }
    assert.equal(finish.reason.kind, 'tool-calls')
    const block = out.find((chunk) => chunk.type === 'block-end') as { block: { type: string; name: string; arguments: string } }
    assert.equal(block.block.name, 'read')
    assert.equal(block.block.arguments, '{"path"}')
  } finally {
    globalThis.fetch = original
  }
})

test('opencode lane: a `read` tool call from a caller that owns the name reaches the harness', async () => {
  // Regression: the lane used to filter every tool call named bash/read —
  // including the harness's own real tools — which turned each one into a
  // reasoning-only dead step (finish tool-calls, zero tool blocks, turn
  // "completes" mid-task with no feedback).
  const stub = async (input: unknown) => {
    if (String(input).includes('/v1/chat/completions')) {
      return sseResponse([
        '{"choices":[{"delta":{"reasoning_content":"Let me read it."}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '{"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      ])
    }
    return new Response(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const original = globalThis.fetch
  globalThis.fetch = stub as typeof fetch
  try {
    const lane = new OpenCodeLane({
      baseURL: 'https://zen.invalid/zen',
      dataDir: mkdtempSync(join(tmpdir(), 'free2dsh-wire-')),
      refreshSeconds: 300,
      includeResponsesOnly: false,
      logger: silent,
    })
    await lane.prime()
    const out = []
    for await (const chunk of lane.stream('mimo-v2.6-flash-free', {
      provider: 'free2dsh',
      model: 'mimo-v2.6-flash-free',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }] }],
      tools: [
        { name: 'read', description: 'read a file', parameters: { type: 'object' } },
        { name: 'pwsh', description: 'run a shell command', parameters: { type: 'object' } },
      ],
    })) {
      out.push(chunk)
    }
    const toolBlocks = out.filter(
      (chunk): chunk is Extract<import('../src/chunks.ts').HarnessChunk, { type: 'block-end' }> & {
        block: Extract<import('../src/types.ts').HarnessBlock, { type: 'tool-call' }>
      } =>
        chunk.type === 'block-end' &&
        chunk.block.type === 'tool-call',
    )
    assert.equal(toolBlocks.length, 1, 'the harness must receive the read call')
    assert.equal(toolBlocks[0].block.name, 'read')
    const finish = out.find((chunk) => chunk.type === 'finish') as { reason: { kind: string } }
    assert.equal(finish.reason.kind, 'tool-calls')
  } finally {
    globalThis.fetch = original
  }
})

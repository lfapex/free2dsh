import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SseParser } from '../src/sse.ts'
import { buildOpenAIPayload, reasoningEffortFor, systemText } from '../src/request.ts'
import { applyFreeLaneShape, freeVerdict, stripGateTools } from '../src/lanes/opencode.ts'
import type { HarnessGenerateOptions } from '../src/types.ts'

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

async function* toolStream(): AsyncGenerator<import('../src/chunks.ts').HarnessChunk> {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: 'a', name: 'read', argumentsDelta: '{"pa' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'a', name: 'read', arguments: '{"pa' } }
  yield { type: 'text-delta', index: 1, text: 'ok' }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

test('stripGateTools: a gate tool never reaches the harness, a real one still streams', async () => {
  async function* mixed(): AsyncGenerator<import('../src/chunks.ts').HarnessChunk> {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: 'a', name: 'read', argumentsDelta: '{"path":"a"}' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'a', name: 'read', arguments: '{"path":"a"}' } }
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id: 'b', name: 'bash', argumentsDelta: '{"cmd":"ls"}' }
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'b', name: 'bash', arguments: '{"cmd":"ls"}' } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  const out = []
  for await (const chunk of stripGateTools(mixed(), ['bash'])) out.push(chunk)
  assert.deepEqual(
    out.filter((chunk) => chunk.type === 'block-end').map((chunk) => (chunk.block as { name: string }).name),
    ['read'],
    'only the gate tool is filtered; a real tool call still streams through',
  )
  assert.equal(out.filter((chunk) => chunk.type === 'block-start').length, 1, 'the suppressed block-start is held back too')
})

test('stripGateTools: when the caller owns the gate names they are still filtered by name', async () => {
  const out = []
  for await (const chunk of stripGateTools(toolStream(), ['bash', 'read'])) out.push(chunk)
  assert.ok(!out.some((chunk) => chunk.type === 'block-end'), 'nothing was emitted for a gate tool')
  assert.deepEqual(out.map((chunk) => chunk.type), ['text-delta', 'finish'])
})

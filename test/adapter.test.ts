import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Free2dshAdapter } from '../src/adapter.ts'
import { UnifiedCatalog } from '../src/catalog.ts'
import { FakeLane } from './fakes.ts'

function setup() {
  const cline = new FakeLane('cline', 'Cline', [{ id: 'cline-free/deepseek-v4.1-flash', name: '! Deepseek', contextWindow: 200_000 }])
  const opencode = new FakeLane('opencode', 'OpenCode Zen', [{ id: 'big-pickle', name: 'Big Pickle', maxOutput: 64_000 }])
  const catalog = new UnifiedCatalog([cline, opencode], 'free2dsh')
  return { adapter: new Free2dshAdapter({ catalog }), cline, opencode }
}

const ask = (model: string) => ({
  provider: 'free2dsh',
  model,
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
})

async function drain(source: AsyncIterable<import('../src/chunks.ts').HarnessChunk>) {
  const chunks = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

test('listModels returns the merged, namespaced catalog', () => {
  const { adapter } = setup()
  assert.deepEqual(
    adapter.listModels('free2dsh').map((model) => model.id),
    ['cline/cline-free/deepseek-v4.1-flash', 'opencode/big-pickle'],
  )
  assert.deepEqual(adapter.listModels('free2dsh-cline').map((model) => model.id), ['cline-free/deepseek-v4.1-flash'])
})

test('resolveModel carries the lane entry limits', () => {
  const { adapter } = setup()
  const cline = adapter.resolveModel('free2dsh', 'cline/cline-free/deepseek-v4.1-flash')
  assert.equal(cline.id, 'cline/cline-free/deepseek-v4.1-flash')
  assert.equal(cline.name, '! Deepseek · Cline')
  assert.equal(cline.context.contextWindow, 200_000)
  const zen = adapter.resolveModel('free2dsh', 'opencode/big-pickle')
  assert.equal(zen.defaultMaxTokens, 64_000)
})

test('resolveModel on an unknown id degrades instead of throwing', () => {
  const { adapter } = setup()
  const model = adapter.resolveModel('free2dsh', 'gone-9000')
  assert.equal(model.id, 'gone-9000')
  assert.equal(model.context.contextWindow, 200_000)
})

test('stream routes to the owning lane and strips the lane prefix', async () => {
  const seen: Array<{ lane: string; model: string }> = []
  const cline = new FakeLane('cline', 'Cline', [{ id: 'cline-free/m1' }])
  const wrapped = new Proxy(cline, {
    get(target, prop, receiver) {
      if (prop === 'stream') {
        return (model: string, options: import('../src/types.ts').HarnessGenerateOptions) => {
          seen.push({ lane: 'cline', model })
          return target.stream(model, options)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  const adapter = new Free2dshAdapter({ catalog: new UnifiedCatalog([wrapped], 'free2dsh') })
  const chunks = await drain(adapter.stream('free2dsh', 'cline/cline-free/m1', ask('cline/cline-free/m1')))
  assert.deepEqual(seen, [{ lane: 'cline', model: 'cline-free/m1' }], 'the wire id is the bare upstream id')
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => (chunk as { text: string }).text).join('')
  assert.equal(text, 'cline-free/m1: hi')
  assert.equal(chunks[chunks.length - 1]?.type, 'finish')
})

test('stream on an unknown model fails with a classified error, not a crash', async () => {
  const { adapter } = setup()
  const chunks = await drain(adapter.stream('free2dsh', 'ghost/model', ask('ghost/model')))
  const last = chunks[chunks.length - 1]!
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind === 'error' ? last.reason.failure.code : '', 'UNKNOWN_MODEL')
})

test('a lane that throws before returning its stream still yields a terminator', async () => {
  const cline = new FakeLane('cline', 'Cline', [{ id: 'm' }])
  cline.throwOnStream = new Error('credentials missing')
  const adapter = new Free2dshAdapter({ catalog: new UnifiedCatalog([cline], 'free2dsh') })
  const chunks = await drain(adapter.stream('free2dsh', 'cline/m', ask('cline/m')))
  const last = chunks[chunks.length - 1]!
  assert.equal(last.type, 'finish')
  assert.match(last.reason.kind === 'error' ? last.reason.failure.message : '', /credentials missing/)
})

test('prepareCall resolves the model and returns a usable stream', async () => {
  const { adapter } = setup()
  const call = await adapter.prepareCall('free2dsh', 'opencode/big-pickle')
  assert.equal(call.model.id, 'opencode/big-pickle')
  const chunks = await drain(call.stream(ask('opencode/big-pickle')))
  assert.equal(chunks[chunks.length - 1]?.type, 'finish')
})

test('adapter housekeeping matches the dsh-llm contract', () => {
  const { adapter } = setup()
  assert.deepEqual(adapter.providerInfo('free2dsh'), { id: 'free2dsh', name: 'free2dsh' })
  assert.equal(adapter.providerRetryPolicy('free2dsh'), undefined, 'undefined means: host default policy')
  assert.equal(adapter.imageRequestPricing('free2dsh', 'x'), undefined)
})

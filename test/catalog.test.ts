import assert from 'node:assert/strict'
import { test } from 'node:test'

import { UnifiedCatalog } from '../src/catalog.ts'
import { FakeLane } from './fakes.ts'

function catalog(): { unified: UnifiedCatalog; cline: FakeLane; atomcode: FakeLane; opencode: FakeLane } {
  const cline = new FakeLane('cline', 'Cline', [
    { id: 'cline-free/deepseek-v4.1-flash', name: '! Deepseek', contextWindow: 200_000, maxOutput: 32_000 },
    { id: 'qwen/qwen3.8-27b:free', name: 'Qwen', imageInput: true },
  ])
  const atomcode = new FakeLane('atomcode', 'AtomCode', [{ id: 'qwen3.8-27b', name: 'qwen3.8-27b' }])
  const opencode = new FakeLane('opencode', 'OpenCode Zen', [{ id: 'big-pickle', name: 'Big Pickle', contextWindow: 1_000_000 }])
  return { unified: new UnifiedCatalog([cline, atomcode, opencode], 'free2dsh'), cline, atomcode, opencode }
}

test('merged route namespaces ids so lanes cannot collide', () => {
  const { unified } = catalog()
  const ids = unified.list('free2dsh').map((model) => model.id)
  assert.deepEqual(ids, [
    'cline/cline-free/deepseek-v4.1-flash',
    'cline/qwen/qwen3.8-27b:free',
    'atomcode/qwen3.8-27b',
    'opencode/big-pickle',
  ])
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids — dsh-llm rejects those')
})

test('merged route labels each model with its lane', () => {
  const { unified } = catalog()
  const models = unified.list('free2dsh')
  assert.equal(models[0]?.name, '! Deepseek · Cline')
  assert.equal(models[3]?.name, 'Big Pickle · OpenCode Zen')
})

test('lane routes show bare ids and only that lane', () => {
  const { unified } = catalog()
  assert.deepEqual(
    unified.list('free2dsh-atomcode').map((model) => model.id),
    ['qwen3.8-27b'],
  )
  assert.equal(unified.list('free2dsh-atomcode')[0]?.name, 'qwen3.8-27b', 'no lane badge on a lane route')
  assert.equal(unified.list('free2dsh-opencode').length, 1)
})

test('limits and modalities come from the lane entry', () => {
  const { unified } = catalog()
  const models = unified.list('free2dsh')
  assert.equal(models[0]?.contextWindow, 200_000)
  assert.equal(models[0]?.maxTokens, 32_000)
  assert.deepEqual(models[1]?.inputModalities, ['text', 'image'])
  assert.deepEqual(models[2]?.inputModalities, ['text'], 'unknown modalities stay text-only')
})

test('missing limits fall back to conservative defaults', () => {
  const lane = new FakeLane('atomcode', 'AtomCode', [{ id: 'm' }])
  const model = new UnifiedCatalog([lane], 'free2dsh').list('free2dsh')[0]!
  assert.equal(model.contextWindow, 200_000)
  assert.equal(model.maxTokens, 8_192)
})

test('resolve: namespaced ids split on the FIRST separator', () => {
  const { unified } = catalog()
  const resolved = unified.resolve('free2dsh', 'cline/cline-free/deepseek-v4.1-flash')
  assert.equal(resolved?.lane.id, 'cline')
  assert.equal(resolved?.bare, 'cline-free/deepseek-v4.1-flash', 'the upstream id keeps its own slash')
})

test('resolve: bare ids work on the merged route when exactly one lane knows them', () => {
  const { unified } = catalog()
  assert.equal(unified.resolve('free2dsh', 'big-pickle')?.lane.id, 'opencode')
  assert.equal(unified.resolve('free2dsh', 'qwen3.8-27b')?.lane.id, 'atomcode')
  assert.equal(unified.resolve('free2dsh', 'cline-free/deepseek-v4.1-flash')?.lane.id, 'cline')
})

test('resolve: a lane route pins the lane, so a prefixed id still resolves', () => {
  const { unified } = catalog()
  const resolved = unified.resolve('free2dsh-atomcode', 'atomcode/qwen3.8-27b')
  assert.equal(resolved?.lane.id, 'atomcode')
  assert.equal(resolved?.bare, 'qwen3.8-27b')
  assert.equal(unified.resolve('free2dsh-atomcode', 'big-pickle'), undefined, 'not visible on another lane route')
})

test('resolve: unknown ids and unknown lanes return undefined', () => {
  const { unified } = catalog()
  assert.equal(unified.resolve('free2dsh', 'nope-9000'), undefined)
  assert.equal(unified.resolve('free2dsh', 'ghost/whatever'), undefined)
})

test('lane id shadowing: first lane in order wins on the merged route', () => {
  const first = new FakeLane('cline', 'Cline', [{ id: 'shared-id' }])
  const second = new FakeLane('opencode', 'OpenCode Zen', [{ id: 'shared-id' }])
  const unified = new UnifiedCatalog([first, second], 'free2dsh')
  assert.equal(unified.resolve('free2dsh', 'shared-id')?.lane.id, 'cline')
  // The namespaced form is always unambiguous.
  assert.equal(unified.resolve('free2dsh', 'opencode/shared-id')?.lane.id, 'opencode')
})

test('health and summary cover every enabled lane', () => {
  const { unified } = catalog()
  assert.deepEqual(
    unified.health().map((health) => health.lane),
    ['cline', 'atomcode', 'opencode'],
  )
  assert.match(unified.summary(), /Cline 2 · AtomCode 1 · OpenCode Zen 1/)
})

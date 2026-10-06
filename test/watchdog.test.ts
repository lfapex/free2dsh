import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { HarnessChunk } from '../src/chunks.ts'
import { withWatchdogs } from '../src/watchdog.ts'

const FAST = { firstEventMs: 60, bodyIdleMs: 60, label: 'test', model: 'm' }

async function collect(source: AsyncIterable<HarnessChunk>, options = FAST): Promise<HarnessChunk[]> {
  const out: HarnessChunk[] = []
  for await (const chunk of withWatchdogs(source, options)) out.push(chunk)
  return out
}

test('a healthy stream passes through untouched', async () => {
  async function* source(): AsyncGenerator<HarnessChunk> {
    yield { type: 'text-delta', index: 0, text: 'hi' }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const chunks = await collect(source())
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['text-delta', 'usage', 'finish'],
  )
})

test('a source that hangs before its first chunk is cut off with a terminator', async () => {
  async function* source(): AsyncGenerator<HarnessChunk> {
    // Never yields: simulates a tunnel that connects but never streams.
    await new Promise(() => {})
  }
  const chunks = await collect(source())
  const last = chunks[chunks.length - 1]!
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'error')
  assert.equal(last.reason.kind === 'error' ? last.reason.failure.code : '', 'TIMEOUT_FIRST_EVENT')
  assert.equal(chunks[chunks.length - 2]?.type, 'usage', 'usage always precedes finish')
})

test('a source that goes silent mid-response is cut off with a terminator', async () => {
  async function* source(): AsyncGenerator<HarnessChunk> {
    yield { type: 'text-delta', index: 0, text: 'partial' }
    await new Promise(() => {})
  }
  const chunks = await collect(source())
  const last = chunks[chunks.length - 1]!
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind === 'error' ? last.reason.failure.code : '', 'TIMEOUT_IDLE')
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'partial'), 'content already emitted survives')
})

test('a source that throws mid-stream still terminates honestly', async () => {
  async function* source(): AsyncGenerator<HarnessChunk> {
    yield { type: 'text-delta', index: 0, text: 'partial' }
    throw new Error('upstream exploded')
  }
  const chunks = await collect(source())
  const last = chunks[chunks.length - 1]!
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind === 'error' ? last.reason.failure.code : '', 'UPSTREAM')
})

test('a source that dies without a finish chunk gets one invented', async () => {
  async function* source(): AsyncGenerator<HarnessChunk> {
    yield { type: 'text-delta', index: 0, text: 'partial' }
  }
  const chunks = await collect(source())
  const last = chunks[chunks.length - 1]!
  assert.equal(last.type, 'finish')
  assert.match(last.reason.kind === 'error' ? last.reason.failure.message : '', /ended without a finish event/)
})

test('an empty source yields just the terminal pair', async () => {
  async function* source(): AsyncGenerator<HarnessChunk> {}
  const chunks = await collect(source())
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['usage', 'finish'],
  )
})

test('a terminal pair produced immediately is passed through, not duplicated', async () => {
  async function* source(): AsyncGenerator<HarnessChunk> {
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  const chunks = await collect(source())
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['usage', 'finish'],
  )
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
})

test('an early consumer break does not hang the producer', async () => {
  let returned = false
  async function* source(): AsyncGenerator<HarnessChunk> {
    try {
      yield { type: 'text-delta', index: 0, text: 'one' }
      yield { type: 'text-delta', index: 0, text: 'two' }
    } finally {
      returned = true
    }
  }
  for await (const chunk of withWatchdogs(source(), FAST)) {
    assert.equal(chunk.type, 'text-delta')
    break
  }
  assert.equal(returned, true, 'upstream generator was closed')
})

test('the idle window is only applied after the first chunk', async () => {
  const started = Date.now()
  async function* source(): AsyncGenerator<HarnessChunk> {
    yield { type: 'text-delta', index: 0, text: 'x' }
    await new Promise(() => {})
  }
  await collect(source(), { firstEventMs: 10_000, bodyIdleMs: 50, label: 'test', model: 'm' })
  assert.ok(Date.now() - started < 5_000, 'used bodyIdleMs, not firstEventMs')
})

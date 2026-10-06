import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canonicalSessionId, deriveRequestIDs, deriveZenIds, firstUserText } from '../src/ids.ts'
import { zenHeaders, zenUserAgent } from '../src/lanes/opencode.ts'

test('deriveRequestIDs: same turn yields the same session, different turns do not', () => {
  const a = deriveRequestIDs({ model: 'm1', system: 'sys', firstMessageText: 'hello' })
  const b = deriveRequestIDs({ model: 'm1', system: 'sys', firstMessageText: 'hello' })
  assert.equal(a.session, b.session)
  assert.notEqual(a.request, b.request, 'each request gets a fresh id')
  const c = deriveRequestIDs({ model: 'm1', system: 'sys', firstMessageText: 'goodbye' })
  assert.notEqual(a.session, c.session)
  assert.match(a.session, /^[0-9a-f]{32}$/)
})

test('firstUserText: first user turn wins, tool noise does not', () => {
  const text = firstUserText([
    { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
    { role: 'user', content: [{ type: 'text', text: 'the question' }] },
    { role: 'user', content: [{ type: 'text', text: 'later' }] },
  ])
  assert.equal(text, 'the question')
  assert.equal(firstUserText([]), '')
})

test('canonicalSessionId: always produces the shape Zen accepts', () => {
  const id = canonicalSessionId('any seed at all')
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(id, canonicalSessionId('any seed at all'), 'deterministic per seed')
  assert.notEqual(id, canonicalSessionId('another seed'))
})

test('canonicalSessionId: an already-canonical id passes through untouched', () => {
  const canonical = canonicalSessionId('seed')
  assert.equal(canonicalSessionId(canonical), canonical)
})

test('deriveZenIds: session is stable per conversation, request id is not', () => {
  const history = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
  ]
  const a = deriveZenIds(history, 'project')
  const b = deriveZenIds(history, 'project')
  assert.equal(a.session, b.session)
  assert.notEqual(a.request, b.request)
  assert.match(a.request, /^req_[0-9a-f]{32}$/)
  assert.match(a.project, /^prj_[0-9a-f]{24}$/)
  assert.equal(a.project, b.project, 'project id is stable')
})

test('zenHeaders: carries the CLI identity set on the anonymous lane', () => {
  const ids = deriveZenIds([{ role: 'user', content: 'hi' }], 'project')
  const headers = zenHeaders(ids)
  assert.equal(headers.authorization, 'Bearer public')
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-session'], ids.session)
  assert.equal(headers['x-session-affinity'], ids.session)
  assert.equal(headers['X-Session-Id'], ids.session)
  assert.equal(headers['x-opencode-request'], ids.request)
  assert.equal(headers['x-opencode-project'], ids.project)
  assert.equal(headers['user-agent'], zenUserAgent())
  assert.match(headers['user-agent'], /^opencode\//)
})

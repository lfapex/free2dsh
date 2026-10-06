import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, defaults, resolveConfig, resolveLanes } from '../src/config.ts'
import { LANE_IDS } from '../src/types.ts'

test('defaults ship every lane on, so one install is enough', () => {
  const resolved = resolveConfig()
  assert.deepEqual(resolved.lanes, ['cline', 'atomcode', 'opencode'])
  assert.equal(resolved.providerId, 'free2dsh')
  assert.equal(resolved.clineFreeOnly, true)
  assert.equal(resolved.atomcodeAllowRefresh, true)
})

test('resolveLanes filters unknown names and preserves canonical order', () => {
  assert.deepEqual(resolveLanes({ lanes: ['opencode', 'cline'] }), ['cline', 'opencode'])
  assert.deepEqual(resolveLanes({ lanes: [' CLINE ', 'nope'] }), ['cline'])
  assert.deepEqual(resolveLanes({ lanes: ['ghost'] }), [], 'a typo disables lanes instead of throwing')
  assert.deepEqual(resolveLanes({ lanes: [] }), [...LANE_IDS])
})

test('resolveConfig keeps caller overrides and fills the rest', () => {
  const resolved = resolveConfig({ lanes: ['atomcode'], refreshSeconds: 60, atomcodeModels: ['qwen3.8-27b'] })
  assert.deepEqual(resolved.lanes, ['atomcode'])
  assert.equal(resolved.refreshSeconds, 60)
  assert.deepEqual(resolved.atomcodeModels, ['qwen3.8-27b'])
  assert.equal(resolved.clineBaseURL, defaults.clineBaseURL)
})

test('resolveConfig never lets a caller smuggle an unvalidated lane id through', () => {
  const resolved = resolveConfig({ lanes: ['cline', 'evil'] as unknown as string[] })
  assert.deepEqual(resolved.lanes, ['cline'])
})

test('the settings schema accepts a bare config and fills every default', () => {
  const parsed = Config({})
  assert.equal(parsed.providerId, 'free2dsh')
  assert.equal(parsed.refreshSeconds, 300)
  assert.equal(parsed.clineFreeOnly, true)
  assert.equal(parsed.opencodeBaseURL, 'https://opencode.ai/zen')
  assert.deepEqual(parsed.lanes, [])
  assert.equal(parsed.firstEventMs, undefined, 'unset watchdog stays unset so the lane default wins')
})

test('the settings schema passes caller overrides through', () => {
  const parsed = Config({ lanes: ['opencode'], refreshSeconds: 120, bodyIdleMs: 300_000 })
  assert.deepEqual(parsed.lanes, ['opencode'])
  assert.equal(parsed.refreshSeconds, 120)
  assert.equal(parsed.bodyIdleMs, 300_000)
})

test('the settings schema rejects out-of-range values instead of booting broken', () => {
  assert.throws(() => Config({ refreshSeconds: 1 }))
  assert.throws(() => Config({ firstEventMs: 10 }))
  assert.throws(() => Config({ bodyIdleMs: 10_000_000 }))
  assert.doesNotThrow(() => Config({ bodyIdleMs: 600_000 }))
})

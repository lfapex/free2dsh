import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { writeCache } from '../src/cache.ts'
import { mergeModel, OpenCodeLane, STATIC_OPENCODE_MODELS } from '../src/lanes/opencode.ts'
import type { LaneModel, PluginLogger } from '../src/types.ts'

/**
 * The OpenCode lane is the one lane whose catalog is not local: Cline primes
 * from disk and AtomCode reads config.toml, so this lane has to publish
 * something before the network answers or a host that reads the catalog at
 * boot shows the lane (and its route) as empty. These tests pin that contract
 * offline, with the network injected.
 */

const silent: PluginLogger = { info() {}, warn() {}, error() {}, debug() {} }

function lane(fetchImpl: typeof fetch, dataDir: string): OpenCodeLane {
  return new OpenCodeLane({
    baseURL: 'https://zen.invalid/zen',
    dataDir,
    refreshSeconds: 300,
    includeResponsesOnly: false,
    logger: silent,
    fetchImpl,
  })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** Poll until `predicate` holds, so the tests do not depend on scheduling luck. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const dirs = () => mkdtempSync(join(tmpdir(), 'free2dsh-opencode-'))

test('opencode prime(): seeds from the disk cache without touching the network', async () => {
  const dataDir = dirs()
  const cached: LaneModel[] = [{ id: 'big-pickle', name: 'Big Pickle' }, { id: 'space-bunny-free', name: 'Space Bunny Free' }]
  await writeCache(join(dataDir, 'cache', 'opencode.json'), cached)

  let calls = 0
  const subject = lane(async () => {
    calls += 1
    return json({ data: [] })
  }, dataDir)

  await subject.prime()

  assert.deepEqual(subject.models(), ['big-pickle', 'space-bunny-free'])
  assert.equal(subject.health().catalog, 'cache')
  assert.equal(calls, 0)
})

test('opencode prime(): falls back to the verified roster, and never regresses a live catalog', async () => {
  const dataDir = dirs()
  const subject = lane(async () => json({ data: [{ id: 'big-pickle' }] }), dataDir)

  await subject.prime()
  const primed = subject.models()
  assert.deepEqual(primed, STATIC_OPENCODE_MODELS.map((model) => model.id))
  assert.equal(subject.health().catalog, 'static')

  await subject.start()
  assert.equal(subject.health().catalog, 'live')
  subject.stop()

  // A second prime (host may prime, refresh and prime again in one boot) must
  // leave the live catalog alone.
  await subject.prime()
  assert.deepEqual(subject.models(), ['big-pickle'])
  assert.equal(subject.health().catalog, 'live')
})

test('opencode refresh(): publishes the live list before models.dev answers', async () => {
  const dataDir = dirs()
  const dev = deferred<Response>()
  const subject = lane(async (input) => {
    const href = String(input)
    if (href.includes('models.dev')) return dev.promise
    return json({ data: [{ id: 'big-pickle' }, { id: 'brand-new-free' }, { id: 'muse-spark-x' }] })
  }, dataDir)

  await subject.prime()
  const refresh = subject.refresh()

  // The live list lands while the (multi-megabyte) metadata fetch is still open.
  await until(() => subject.models().includes('brand-new-free'))
  assert.deepEqual(subject.models(), ['big-pickle', 'brand-new-free'])
  assert.equal(subject.health().catalog, 'live')
  // ...and the display name the primed roster already knew is carried over.
  assert.equal(subject.entry('big-pickle')?.name, 'Big Pickle')

  // models.dev then only *adds*: an id with no "free" in its name that the
  // metadata marks as zero-cost becomes usable, and its limits come along.
  dev.resolve(
    json({
      opencode: {
        models: {
          'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0 }, limit: { context: 1_000_000, output: 32_000 } },
          'brand-new-free': { name: 'Brand New Free' },
          'zero-cost': { name: 'Zero Cost', cost: { input: 0, output: 0 }, limit: { context: 128_000, output: 8_192 } },
        },
      },
    }),
  )
  // `zero-cost` is not in the live list above, so it must NOT appear; the
  // enrichment may only annotate ids the upstream advertises.
  await refresh
  assert.deepEqual(subject.models(), ['big-pickle', 'brand-new-free'])
  assert.equal(subject.entry('big-pickle')?.contextWindow, 1_000_000)
})

test('mergeModel: primed metadata survives a metadata-less live entry', () => {
  const known: LaneModel = { id: 'big-pickle', name: 'Big Pickle', contextWindow: 1_000_000, maxOutput: 32_000, reasoning: true }
  const merged = mergeModel({ id: 'big-pickle' }, known)
  assert.deepEqual(merged, known)
  // A freshly learnt field wins; the primed one only fills the gaps.
  assert.deepEqual(mergeModel({ id: 'big-pickle', name: 'Renamed' }, known), { ...known, name: 'Renamed' })
  assert.deepEqual(mergeModel({ id: 'new-one' }, undefined), { id: 'new-one' })
})

test('opencode refresh(): keeps a primed catalog when the live list is unreachable', async () => {
  const dataDir = dirs()
  await writeCache<LaneModel>(join(dataDir, 'cache', 'opencode.json'), [{ id: 'cached-one', name: 'Cached One' }])

  const subject = lane(async () => {
    throw new Error('ENOTFOUND')
  }, dataDir)

  await subject.prime()
  assert.deepEqual(subject.models(), ['cached-one'])

  await subject.refresh()
  assert.deepEqual(subject.models(), ['cached-one'])
  assert.equal(subject.health().catalog, 'cache')
  assert.match(subject.health().detail, /live catalog unavailable/)
})

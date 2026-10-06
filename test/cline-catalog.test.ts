import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { writeCache } from '../src/cache.ts'
import { ClineCatalog, STATIC_CLINE_MODELS } from '../src/lanes/cline-catalog.ts'
import type { LaneModel } from '../src/types.ts'

/**
 * `prime()` is the local seed the boot path reads a catalog from. It must leave
 * `entry()` populated — a roster that only exists in `list()` is invisible to
 * the catalog, which resolves every model through `entry()`.
 */

function catalog(cachePath: string): ClineCatalog {
  return new ClineCatalog({
    baseURL: 'https://cline.invalid/api/v1',
    credentialsPath: join(cachePath, '..', 'providers.json'),
    cachePath,
    freeOnly: true,
    includeClinePass: false,
  })
}

test('cline prime(): a disk cache seeds entry() and reports the cache tier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'free2dsh-cline-'))
  const cachePath = join(dir, 'cline.json')
  const cached: LaneModel[] = [{ id: 'cline-free/from-cache', name: 'From Cache' }]
  await writeCache(cachePath, cached)

  const subject = catalog(cachePath)
  const note = await subject.prime()

  assert.match(note, /cache \(1 models\)/)
  assert.deepEqual(subject.list(), ['cline-free/from-cache'])
  assert.equal(subject.entry('cline-free/from-cache')?.name, 'From Cache')
  assert.equal(subject.tier(), 'cache')
})

test('cline prime(): with no cache the verified roster is ingested, not just listed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'free2dsh-cline-'))
  const subject = catalog(join(dir, 'cline.json'))

  const note = await subject.prime()

  assert.match(note, /static roster/)
  assert.equal(subject.tier(), 'static')
  const first = STATIC_CLINE_MODELS[0]!
  // The regression this pins: before prime(), list() worked but entry() did
  // not, so the catalog dropped every model the roster offered.
  assert.equal(subject.entry(first.id)?.id, first.id)
  assert.deepEqual(subject.list().slice().sort(), STATIC_CLINE_MODELS.map((model) => model.id).sort())
})

test('cline prime(): a second prime never regresses a live catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'free2dsh-cline-'))
  const cachePath = join(dir, 'cline.json')
  await writeCache<LaneModel>(cachePath, [{ id: 'cline-free/stale', name: 'Stale' }])

  const subject = catalog(cachePath)
  await subject.prime()
  assert.equal(subject.tier(), 'cache')

  const again = await subject.prime()
  assert.match(again, /already cache/)
  assert.deepEqual(subject.list(), ['cline-free/stale'])
})

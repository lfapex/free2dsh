import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, type PluginContext } from '../src/index.ts'
import type { PluginLogger } from '../src/types.ts'

/**
 * The host contract this pins: dsh-llm publishes `llm/adapters-updated` when a
 * route set is committed, and only then — the model picker re-reads its
 * catalogue on that event. Registration happens before any lane has a model, so
 * the plugin has to re-announce as the catalogs warm, or models that arrive
 * after activation stay invisible.
 */

interface Announcement {
  routes: string[]
  /** Models the host would see on each route at this instant. */
  counts: number[]
}

interface FakeAdapter {
  listModels(provider: string): Array<{ id: string }>
}

const silent: PluginLogger = { info() {}, warn() {}, error() {}, debug() {} }

function fakeHost(handle = true): { ctx: PluginContext; announcements: Announcement[]; routes: string[]; adapter: FakeAdapter; dispose?: () => void } {
  const state = {
    announcements: [] as Announcement[],
    routes: [] as string[],
    adapter: {} as FakeAdapter,
    dispose: undefined as (() => void) | undefined,
  }
  const countFor = (routes: string[]): number[] => routes.map((route) => state.adapter.listModels(route).length)
  const ctx: PluginContext = {
    logger: silent,
    llm: {
      registerAdapter: (providers, adapter) => {
        state.routes = [...providers]
        state.adapter = adapter as FakeAdapter
        if (!handle) return undefined
        return {
          replace: (next: string[]) => {
            state.announcements.push({ routes: [...next], counts: countFor(next) })
          },
        }
      },
    },
    effect: (fn) => {
      state.dispose = fn()
    },
  }
  return Object.assign(state, { ctx })
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** No lane may reach the network in this test; every fetch fails immediately. */
function offline(): () => void {
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('', { status: 503 })
  return () => {
    globalThis.fetch = real
  }
}

const dirs = () => mkdtempSync(join(tmpdir(), 'free2dsh-apply-'))

test('apply(): re-announces the routes once a lane has models', async () => {
  const restore = offline()
  try {
    const host = fakeHost()
    apply(host.ctx, { lanes: ['opencode'], dataDir: dirs() })
    host.dispose?.()

    assert.deepEqual(host.routes, ['free2dsh', 'free2dsh-opencode'])

    await until(() => host.announcements.length >= 2)
    // The very first re-announce — the one that follows the local prime — must
    // already carry models, or the picker would keep an empty snapshot.
    const first = host.announcements[0]!
    const opencode = first.routes.indexOf('free2dsh-opencode')
    assert.ok(first.counts[opencode]! > 0, `first announcement was empty: ${JSON.stringify(first.counts)}`)
    for (const announcement of host.announcements) {
      assert.deepEqual(announcement.routes, ['free2dsh', 'free2dsh-opencode'])
    }
  } finally {
    restore()
  }
})

test('apply(): a host that returns no registration handle still gets served models', async () => {
  const restore = offline()
  try {
    const host = fakeHost(false)
    apply(host.ctx, { lanes: ['opencode'], dataDir: dirs() })
    await until(() => host.adapter.listModels('free2dsh-opencode').length > 0)
    assert.equal(host.announcements.length, 0)
    host.dispose?.()
  } finally {
    restore()
  }
})

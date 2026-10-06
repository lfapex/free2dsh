import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { getValidAccessToken, readClineCredentials, refreshClineToken, resetClineCaches } from '../src/lanes/cline-credentials.ts'

/**
 * The Cline lane renews its own access token, so this test exists to keep the
 * docs honest: the lane's own README/comments once claimed it "never refreshes
 * the token itself" and drifted away from the implementation. These assertions
 * pin the actual contract.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  resetClineCaches()
})

function providersFile(overrides: Record<string, unknown> = {}): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'free2dsh-creds-'))
  const path = join(dir, 'providers.json')
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        cline: {
          settings: {
            auth: {
              accessToken: 'old-token',
              refreshToken: 'refresh-me',
              accountId: 'usr-1',
              expiresAt: Date.now() - 60_000, // already stale
              ...overrides,
            },
          },
        },
      },
    }),
  )
  return { path, dir }
}

test('a stale file token is renewed against the refresh endpoint', async () => {
  const { path } = providersFile()
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ data: { accessToken: 'fresh-token', expiresAt: Date.now() + 3_600_000 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const token = await getValidAccessToken({ baseURL: 'https://api.cline.bot/api/v1', credentialsPath: path })
  assert.equal(token.accessToken, 'fresh-token')
  assert.equal(token.refreshed, true, 'the lane reports that it minted this token')
  assert.equal(token.accountId, 'usr-1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0], 'https://api.cline.bot/api/v1/auth/refresh')
})

test('renewal never rewrites providers.json — the desktop app keeps that file', async () => {
  const { path } = providersFile()
  const before = readFileSync(path, 'utf8')
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accessToken: 'fresh-token' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

  await getValidAccessToken({ baseURL: 'https://api.cline.bot/api/v1', credentialsPath: path })
  assert.equal(readFileSync(path, 'utf8'), before, 'the minted token stays in memory only')
})

test('a still-valid token is used as-is, with no refresh call', async () => {
  const { path } = providersFile({ expiresAt: Date.now() + 3_600_000, accessToken: 'good-token' })
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  const token = await getValidAccessToken({ baseURL: 'https://api.cline.bot/api/v1', credentialsPath: path })
  assert.equal(token.accessToken, 'good-token')
  assert.equal(token.refreshed, false)
  assert.equal(called, false, 'no network call for a fresh token')
})

test('a file with no expiry declared is trusted as-is', async () => {
  const { path } = providersFile({ expiresAt: undefined })
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  const token = await getValidAccessToken({ baseURL: 'https://api.cline.bot/api/v1', credentialsPath: path })
  assert.equal(token.accessToken, 'old-token')
  assert.equal(called, false)
})

test('a revoked session falls back to the stale token instead of hard-failing', async () => {
  const { path } = providersFile()
  globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch

  const token = await getValidAccessToken({ baseURL: 'https://api.cline.bot/api/v1', credentialsPath: path })
  assert.equal(token.accessToken, 'old-token', 'upstream gets to answer 401 with a precise message')
  assert.equal(token.refreshed, false)
})

test('concurrent calls share one refresh', async () => {
  const { path } = providersFile()
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return new Response(JSON.stringify({ accessToken: 'fresh-token' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const results = await Promise.all(
    Array.from({ length: 5 }, () => getValidAccessToken({ baseURL: 'https://api.cline.bot/api/v1', credentialsPath: path })),
  )
  assert.equal(calls, 1, 'the rotating refresh token is only spent once')
  for (const result of results) assert.equal(result.accessToken, 'fresh-token')
})

test('a session without a refresh token falls back to the stale token, no network call', async () => {
  const { path } = providersFile({ refreshToken: undefined })
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  const token = await getValidAccessToken({ baseURL: 'https://api.cline.bot/api/v1', credentialsPath: path })
  assert.equal(token.accessToken, 'old-token', 'upstream gets to answer 401 with a precise message')
  assert.equal(token.refreshed, false)
  assert.equal(called, false, 'nothing to refresh with, so nothing is called')
})

test('a direct renewal without a refresh token reports the actionable error', async () => {
  const creds = await readClineCredentials(providersFile({ refreshToken: undefined }).path)
  await assert.rejects(
    () => refreshClineToken('https://api.cline.bot/api/v1', creds),
    /no refreshToken/,
  )
})

test('a missing credentials file names the fix', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'free2dsh-none-')), 'providers.json')
  await assert.rejects(() => readClineCredentials(missing), /Open the Cline desktop app and log in once/)
})

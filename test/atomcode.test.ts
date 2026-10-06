import assert from 'node:assert/strict'
import { test } from 'node:test'

import { signAtomCodeRequest } from '../src/lanes/atomcode-signing.ts'
import { parseAuthToml } from '../src/lanes/atomcode-auth.ts'
import { parseAtomGitModels, parseProviderAccounts } from '../src/lanes/atomcode-models.ts'

test('atomcode-signing-v1: golden vector (live-verified scheme, pinned)', () => {
  const headers = signAtomCodeRequest({
    method: 'POST',
    path: '/v1/chat/completions',
    body: Buffer.from('{}'),
    accessToken: 'test-token',
    userId: 'usr123',
    clientVersion: '5.2.1',
    timestampSeconds: 1_791_164_000,
    nonce: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  })
  assert.equal(headers['X-AtomCode-Sig'], 'v1:baac21297c10a255211405457bd6c5a7046061f2335526f6175536376254c043')
  assert.equal(headers['X-AtomCode-Ts'], '1791164000')
  assert.equal(headers['X-AtomCode-Nonce'], '0123456789abcdef0123456789abcdef')
  assert.equal(headers['X-AtomCode-Alg'], '1')
  assert.equal(headers['X-AtomCode-Ver'], '5.2.1')
})

test('atomcode-signing-v1: signature varies with body, nonce, path and hour bucket', () => {
  const base = {
    method: 'POST',
    path: '/v1/chat/completions',
    body: Buffer.from('{"model":"qwen3.8-27b"}'),
    accessToken: 'test-token',
    userId: 'usr123',
    clientVersion: '5.2.1',
  }
  const sig = (h: Record<string, string>) => h['X-AtomCode-Sig']
  const a = signAtomCodeRequest({ ...base, timestampSeconds: 1_791_164_000, nonce: Buffer.alloc(16, 1) })
  const b = signAtomCodeRequest({ ...base, timestampSeconds: 1_791_164_000, nonce: Buffer.alloc(16, 2) })
  const c = signAtomCodeRequest({ ...base, body: Buffer.from('{"model":"glm5.3-flash"}'), timestampSeconds: 1_791_164_000, nonce: Buffer.alloc(16, 1) })
  const d = signAtomCodeRequest({ ...base, timestampSeconds: 1_791_164_000 + 3600, nonce: Buffer.alloc(16, 1) })
  const e = signAtomCodeRequest({ ...base, path: '/chat/completions', timestampSeconds: 1_791_164_000, nonce: Buffer.alloc(16, 1) })
  assert.notEqual(sig(a), sig(b))
  assert.notEqual(sig(a), sig(c))
  assert.notEqual(sig(a), sig(d))
  assert.notEqual(sig(a), sig(e))
  assert.equal(signAtomCodeRequest({ ...base, timestampSeconds: 1_791_164_000, nonce: Buffer.alloc(16, 1) })['X-AtomCode-Sig'], sig(a))
})

test('auth.toml parsing: tokens, user id and expiry', () => {
  const auth = parseAuthToml(`
access_token = "tok-abc"
refresh_token = "ref-xyz"
token_type = "Bearer"
expires_in = 604800
created_at = 1791162795

[user]
id = "uid-42"
`)
  assert.ok(auth)
  assert.equal(auth?.accessToken, 'tok-abc')
  assert.equal(auth?.refreshToken, 'ref-xyz')
  assert.equal(auth?.userId, 'uid-42')
  assert.equal(auth?.expiresAt, (1791162795 + 604800) * 1000)
})

test('auth.toml parsing: rejects a file without a session', () => {
  assert.equal(parseAuthToml('[user]\nid = "uid-42"\n'), undefined)
  assert.equal(parseAuthToml(''), undefined)
})

test('config.toml: provider accounts map to base urls', () => {
  const accounts = parseProviderAccounts(`
[provider_accounts.AtomGit]
provider = "openai"
base_url = "https://llm-api.atomgit.com/v1/"

[provider_accounts.Other]
base_url = "https://example.invalid/v1"
`)
  assert.equal(accounts.get('AtomGit'), 'https://llm-api.atomgit.com/v1')
  assert.equal(accounts.get('Other'), 'https://example.invalid/v1')
})

test('config.toml: only free-lane models are exposed, with their limits', () => {
  const models = parseAtomGitModels(`
[provider_accounts.AtomGit]
provider = "openai"
base_url = "https://llm-api.atomgit.com/v1"

[provider_accounts.Paid]
base_url = "https://paid.example/v1"

[models."AtomGit-qwen3.8-27b"]
account = "AtomGit"
model = "qwen3.8-27b"
supports_vision = true
context_window = 262144
reasoning_effort_levels = ["low", "medium", "xhigh"]

[models."Paid-secret"]
account = "Paid"
model = "secret-1"
`)
  assert.equal(models.length, 1)
  const entry = models[0]!
  assert.equal(entry.id, 'qwen3.8-27b')
  assert.equal(entry.baseUrl, 'https://llm-api.atomgit.com/v1')
  assert.equal(entry.contextWindow, 262144)
  assert.equal(entry.imageInput, true)
  assert.deepEqual(entry.reasoningLevels, ['low', 'medium', 'xhigh'])
})

test('config.toml: a model section without a model field is skipped', () => {
  assert.deepEqual(parseAtomGitModels('[models."broken"]\naccount = "AtomGit"\n'), [])
})

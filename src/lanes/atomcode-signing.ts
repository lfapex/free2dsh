import { createHash, createHmac, randomBytes } from 'node:crypto'

/**
 * `atomcode-signing-v1` request signing.
 *
 * Ported verbatim from atomcode2dsh (live-verified against llm-api.atomgit.com
 * and api-ai.gitcode.com): HKDF-SHA256 over a salt bound to the user id, the
 * hour bucket and the token/version hashes, then HMAC over the canonical
 * request string. The primitive stays pure so tests can pin golden vectors.
 *
 * The signature covers the exact request bytes (method, path, timestamp, nonce,
 * SHA-256 of the body), which is why the AtomCode lane builds and signs its own
 * payload instead of delegating the wire to pi-ai.
 */

export const DEFAULT_MASTER_KEY_HEX = 'e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123'

/**
 * Client version sent as `X-AtomCode-Ver` (and hashed into the signature salt).
 * Bump it when AtomCode updates and the gateway starts rejecting `1`
 * signatures; `atomcodeClientVersion` in the plugin config overrides it.
 */
export const DEFAULT_CLIENT_VERSION = '5.2.1'

export interface SignRequestOptions {
  method: string
  /** URL pathname + search exactly as it appears on the wire. */
  path: string
  body: Buffer
  accessToken: string
  userId: string
  clientVersion: string
  timestampSeconds: number
  nonce: Buffer
  masterKeyHex?: string
}

export function signAtomCodeRequest(options: SignRequestOptions): Record<string, string> {
  const masterKey = Buffer.from(options.masterKeyHex ?? DEFAULT_MASTER_KEY_HEX, 'hex')
  const tokenHash = createHash('sha256').update(options.accessToken, 'utf8').digest()
  const versionHash = createHash('sha256').update(options.clientVersion, 'utf8').digest()
  const hourBucket = Buffer.alloc(8)
  hourBucket.writeBigUInt64LE(BigInt(Math.floor(options.timestampSeconds / 3600)))
  const salt = Buffer.concat([Buffer.from(options.userId, 'utf8'), Buffer.from([1]), hourBucket, tokenHash, versionHash])
  const prk = createHmac('sha256', salt).update(masterKey).digest()
  const signingKey = createHmac('sha256', prk).update('atomcode-signing-v1').update(Buffer.from([1])).digest()
  const bodyHash = createHash('sha256').update(options.body).digest('hex')
  const canonical = ['v1', options.method.toUpperCase(), options.path, String(options.timestampSeconds), options.nonce.toString('hex'), bodyHash].join('\n')
  const signature = createHmac('sha256', signingKey).update(canonical, 'utf8').digest('hex')
  return {
    'X-AtomCode-Sig': `v1:${signature}`,
    'X-AtomCode-Ts': String(options.timestampSeconds),
    'X-AtomCode-Nonce': options.nonce.toString('hex'),
    'X-AtomCode-Alg': '1',
    'X-AtomCode-Ver': options.clientVersion,
  }
}

/** Fresh 16-byte nonce for one request. */
export function newNonce(): Buffer {
  return randomBytes(16)
}

/**
 * Cline desktop credentials reader.
 *
 * The Cline desktop app persists its WorkOS OAuth session at
 * `~/.cline/data/settings/providers.json`. The plugin reads that file on every
 * call (mtime-cached) and, when the access token reaches its expiry, renews it
 * in-process via `POST /api/v1/auth/refresh`. Cline's backend does NOT rotate
 * the refresh token — the response echoes back the same one the desktop app
 * keeps reusing — so renewing here never kicks the desktop app out and you do
 * not need the app running.
 *
 * The renewed token lives only in memory: `providers.json` is never rewritten,
 * so it stays the desktop app's property. A manual sign-in is only needed when
 * the refresh token itself is missing or revoked.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ClineCredentials {
  /** Verbatim persisted access token (`workos:...` JWT); sent as Bearer. */
  accessToken: string
  /** Reusable refresh token; the backend does NOT rotate it (verified). */
  refreshToken?: string
  /** Cline account id (`usr-...`); sent as the `clineUserId` header. */
  accountId: string
  /** Epoch ms the access token expires at, when the file declares one. */
  expiresAt?: number
}

export class CredentialsError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'CredentialsError'
    this.code = code
  }
}

/** Env override for the Cline home, mirroring the desktop app's layout. */
export function defaultCredentialsPath(): string {
  const clineHome = process.env.CLINE_HOME?.trim()
  const base = clineHome && clineHome.length > 0 ? clineHome : join(homedir(), '.cline')
  return join(base, 'data', 'settings', 'providers.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read and validate the Cline provider credentials with actionable errors. */
export async function readClineCredentials(path: string = defaultCredentialsPath()): Promise<ClineCredentials> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'CLINE_NOT_INSTALLED' : 'CLINE_UNREADABLE'
    throw new CredentialsError(
      `free2dsh[cline]: cannot read Cline credentials at ${path} (${(err as Error).message}). ` +
        'Open the Cline desktop app and log in once, then retry.',
      code,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CredentialsError(`free2dsh[cline]: ${path} is not valid JSON (Cline may be mid-write); retry shortly.`, 'CLINE_MALFORMED')
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new CredentialsError(`free2dsh[cline]: unexpected providers.json shape at ${path}.`, 'CLINE_MALFORMED')
  }
  const cline = (parsed.providers as Record<string, unknown>).cline
  const settings = isRecord(cline) ? (cline as { settings?: unknown }).settings : undefined
  const authBlock = isRecord(settings) ? (settings as { auth?: unknown }).auth : undefined
  if (!isRecord(cline) || !isRecord(authBlock)) {
    throw new CredentialsError(
      'free2dsh[cline]: no Cline account session found in providers.json. ' +
        'Open the Cline desktop app, sign in (Cline provider), then retry.',
      'CLINE_NOT_LOGGED_IN',
    )
  }
  const accessToken = (authBlock as { accessToken?: unknown }).accessToken
  const refreshToken = (authBlock as { refreshToken?: unknown }).refreshToken
  const accountId =
    (authBlock as { accountId?: unknown }).accountId ??
    (isRecord((authBlock as { metadata?: unknown }).metadata)
      ? ((authBlock as { metadata?: { userInfo?: { clineUserId?: unknown } } }).metadata?.userInfo?.clineUserId as unknown)
      : undefined)
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new CredentialsError('free2dsh[cline]: providers.json has no accessToken; log in from the Cline desktop app.', 'CLINE_NOT_LOGGED_IN')
  }
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new CredentialsError('free2dsh[cline]: providers.json has no accountId/clineUserId; log in from the Cline desktop app.', 'CLINE_NOT_LOGGED_IN')
  }
  const expiresAtRaw = (authBlock as { expiresAt?: unknown }).expiresAt
  const expiresAt = typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw) ? expiresAtRaw : undefined
  return {
    accessToken,
    accountId,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refreshToken } : {}),
  }
}

/**
 * Headers the Cline desktop client itself sends. Two layers matter:
 *  - attribution (HTTP-Referer / X-Title) and the account binding
 *    (clineUserId), matching the desktop client;
 *  - client identity (X-CLIENT-TYPE / X-CLIENT-VERSION / X-PLATFORM) — the
 *    `cline-free/*` routing prefix is gated on these ("only available via
 *    Cline product surfaces", live-verified: a plain Bearer alone gets 403).
 */
const CLINE_CLIENT_TYPE = process.env.CLINE_CLIENT_TYPE?.trim() || 'cline-sdk'
const CLINE_CLIENT_VERSION = process.env.CLINE_CLIENT_VERSION?.trim() || '4.1.22'

export function clineRequestHeaders(accountId: string): Record<string, string> {
  return {
    clineUserId: accountId,
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
    'X-IS-MULTIROOT': 'false',
    'X-CLIENT-TYPE': CLINE_CLIENT_TYPE,
    'X-CLIENT-VERSION': CLINE_CLIENT_VERSION,
    'X-PLATFORM': CLINE_CLIENT_TYPE,
    'X-PLATFORM-VERSION': CLINE_CLIENT_VERSION,
    'User-Agent': `Cline/${CLINE_CLIENT_VERSION}`,
  }
}

interface CacheEntry {
  mtimeMs: number
  creds: ClineCredentials
}
let cache: CacheEntry | undefined
let cachePath = ''

/** mtime cache: avoid re-parsing the file on every request when unchanged. */
export async function readClineCredentialsCached(path: string = defaultCredentialsPath()): Promise<ClineCredentials> {
  if (cache && cachePath === path) {
    try {
      const { mtimeMs } = await stat(path)
      if (mtimeMs === cache.mtimeMs) return cache.creds
    } catch {
      // fall through to a full read, which raises the precise error
    }
  }
  const creds = await readClineCredentials(path)
  try {
    const { mtimeMs } = await stat(path)
    cache = { mtimeMs, creds }
    cachePath = path
  } catch {
    cache = undefined
  }
  return creds
}

/**
 * Token refresh against the Cline backend (`POST /api/v1/auth/refresh`).
 * The backend does NOT rotate the refresh token (the response echoes the same
 * one the desktop app keeps reusing), so refreshing here never kicks the
 * desktop app out. The minted token lives only in memory — providers.json
 * stays the desktop app's property.
 */
export async function refreshClineToken(baseURL: string, creds: ClineCredentials): Promise<ClineCredentials> {
  if (!creds.refreshToken) {
    throw new CredentialsError(
      'free2dsh[cline]: no refreshToken in providers.json; open the Cline desktop app and log in again.',
      'CLINE_NO_REFRESH_TOKEN',
    )
  }
  const url = `${baseURL.replace(/\/+$/, '')}/auth/refresh`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...clineRequestHeaders(creds.accountId),
      },
      body: JSON.stringify({ refreshToken: creds.refreshToken, grantType: 'refresh_token' }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new CredentialsError(`free2dsh[cline]: token refresh request failed: ${(err as Error).message}`, 'CLINE_REFRESH_TRANSPORT')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    if (response.status === 401 || response.status === 403) {
      throw new CredentialsError(
        'free2dsh[cline]: token refresh rejected (401/403) — the Cline session was revoked. Open the Cline desktop app and log in again.',
        'CLINE_REFRESH_REJECTED',
      )
    }
    throw new CredentialsError(`free2dsh[cline]: token refresh -> ${response.status} ${text.slice(0, 160)}`, 'CLINE_REFRESH_FAILED')
  }
  const body = (await response.json()) as Record<string, unknown>
  const inner = (isRecord(body.data) ? body.data : body) as { accessToken?: unknown; expiresAt?: unknown; refreshToken?: unknown }
  const accessToken = typeof inner.accessToken === 'string' ? inner.accessToken : undefined
  if (!accessToken) {
    throw new CredentialsError('free2dsh[cline]: token refresh response had no accessToken.', 'CLINE_REFRESH_FAILED')
  }
  const rawExpiry = inner.expiresAt
  let expiresAt: number | undefined
  if (typeof rawExpiry === 'number' && Number.isFinite(rawExpiry)) {
    // epoch seconds vs ms: the backend answers in ISO or ms; a seconds-scale
    // number (< 10^12) is converted so both spellings work.
    expiresAt = rawExpiry < 1e12 ? rawExpiry * 1000 : rawExpiry
  } else if (typeof rawExpiry === 'string' && rawExpiry.length > 0) {
    const parsed = Date.parse(rawExpiry)
    if (Number.isFinite(parsed)) expiresAt = parsed
  }
  return { ...creds, accessToken, ...(expiresAt !== undefined ? { expiresAt } : {}) }
}

export interface ValidToken {
  accessToken: string
  accountId: string
  /** True when this call minted a fresh token via the refresh endpoint. */
  refreshed: boolean
}

const EXPIRY_MARGIN_MS = 60_000
/** In-memory refreshed tokens, keyed by resolved credentials path. */
const liveTokens = new Map<string, ClineCredentials>()
/** Single-flight refresh per path; concurrent callers share one request. */
const pendingRefreshes = new Map<string, Promise<ClineCredentials>>()

/**
 * Access token for one API call, refreshing proactively when the current token
 * is at (or past) its expiry. When refresh fails but a token exists, the stale
 * token is returned — the API call it arms may still succeed (clock skew) or
 * surface a precise 401 upstream.
 */
export async function getValidAccessToken(options: { baseURL: string; credentialsPath: string }): Promise<ValidToken> {
  const key = options.credentialsPath || defaultCredentialsPath()
  const creds = await readClineCredentialsCached(key)
  const live = liveTokens.get(key)
  const token = live?.accessToken ?? creds.accessToken
  const expiresAt = live?.expiresAt ?? creds.expiresAt

  if (token && (expiresAt === undefined || Date.now() < expiresAt - EXPIRY_MARGIN_MS)) {
    return { accessToken: token, accountId: creds.accountId, refreshed: false }
  }

  let refreshedCreds: ClineCredentials | undefined
  if (creds.refreshToken) {
    let pending = pendingRefreshes.get(key)
    if (!pending) {
      pending = refreshClineToken(options.baseURL, creds).finally(() => {
        pendingRefreshes.delete(key)
      })
      pendingRefreshes.set(key, pending)
    }
    try {
      refreshedCreds = await pending
      liveTokens.set(key, refreshedCreds)
    } catch {
      // fall through to the stale token, if any
    }
  }

  if (refreshedCreds) {
    return { accessToken: refreshedCreds.accessToken, accountId: refreshedCreds.accountId, refreshed: true }
  }
  if (token) {
    return { accessToken: token, accountId: creds.accountId, refreshed: false }
  }
  throw new CredentialsError('free2dsh[cline]: no usable Cline token; open the Cline desktop app and log in.', 'CLINE_NOT_LOGGED_IN')
}

/** Test hook: forget the mtime cache and any minted tokens. */
export function resetClineCaches(): void {
  cache = undefined
  cachePath = ''
  liveTokens.clear()
  pendingRefreshes.clear()
}

import { readFileSync as readFileSyncNode, statSync as statSyncNode } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * AtomCode CLI credentials.
 *
 * `atomcode login` persists an OAuth session at `~/.atomcode/auth.toml`
 * (access + refresh token, 7-day access validity, user id). The CLI keeps
 * refreshing the file while it runs. This lane re-reads it per call
 * (mtime-cached) and, when the file token is stale and refresh is allowed,
 * mints a fresh access token via the platform endpoint — the minted token lives
 * in memory/sidecar only, `auth.toml` stays the CLI's property. Refresh is
 * single-flight so concurrent turns cannot burn the rotating refresh token.
 */

export const PLATFORM_BASE = 'https://acs.atomgit.com'

/** Resolve the AtomCode home the same way the CLI does. */
export function atomcodeHome(override?: string): string {
  const explicit = override?.trim()
  if (explicit && explicit.length > 0) return explicit
  const env = process.env.ATOMCODE_HOME?.trim()
  if (env && env.length > 0) return env
  return join(homedir(), '.atomcode')
}

export function authPath(home?: string): string {
  return join(atomcodeHome(home), 'auth.toml')
}

export interface AtomAuth {
  accessToken: string
  refreshToken?: string
  userId: string
  /** Epoch ms when the file's access token goes stale (best effort). */
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

function readTomlString(toml: string, key: string): string | undefined {
  const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))
  if (m?.[1] !== undefined) return m[1]
  // Unquoted TOML integers (expires_in / created_at).
  const n = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm'))
  return n?.[1]
}

export function parseAuthToml(toml: string): AtomAuth | undefined {
  const accessToken = readTomlString(toml, 'access_token')
  const userId = readTomlString(toml, 'id')
  if (!accessToken || !userId) return undefined
  const refreshToken = readTomlString(toml, 'refresh_token')
  const expiresIn = Number(readTomlString(toml, 'expires_in'))
  const createdAt = Number(readTomlString(toml, 'created_at'))
  const expiresAt = Number.isFinite(expiresIn) && Number.isFinite(createdAt) && expiresIn > 0 && createdAt > 0 ? (createdAt + expiresIn) * 1000 : undefined
  return {
    accessToken,
    userId,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  }
}

interface AuthCacheEntry {
  mtimeMs: number
  auth: AtomAuth | undefined
  error?: string
}
const authCache = new Map<string, AuthCacheEntry>()

/**
 * mtime-cached read; the CLI rewrites the file, so caching by mtime is exact.
 * Throws CredentialsError when the file is missing or carries no session.
 */
export function readAuthCached(path: string): AtomAuth {
  const cached = authCache.get(path)
  let mtimeMs = 0
  try {
    mtimeMs = statSyncNode(path).mtimeMs
  } catch {
    authCache.delete(path)
    throw new CredentialsError(`free2dsh[atomcode]: cannot read ${path}. Run \`atomcode login\` once, then retry.`, 'ATOMCODE_NOT_INSTALLED')
  }
  if (cached && cached.mtimeMs === mtimeMs) {
    if (cached.auth === undefined) {
      throw new CredentialsError(cached.error ?? `free2dsh[atomcode]: ${path} has no session`, 'ATOMCODE_NOT_LOGGED_IN')
    }
    return cached.auth
  }
  let auth: AtomAuth | undefined
  let error: string | undefined
  try {
    auth = parseAuthToml(readFileSyncNode(path, 'utf8'))
    if (!auth) error = `free2dsh[atomcode]: ${path} has no access_token/user id — run \`atomcode login\` again`
  } catch (err) {
    error = `free2dsh[atomcode]: ${path} unreadable: ${(err as Error).message}`
  }
  authCache.set(path, { mtimeMs, auth, error })
  if (!auth) throw new CredentialsError(error ?? `free2dsh[atomcode]: ${path} has no session`, 'ATOMCODE_NOT_LOGGED_IN')
  return auth
}

/** Test hook: drop the mtime cache (tests rewrite auth.toml in place). */
export function clearAuthCache(): void {
  authCache.clear()
}

/** In-memory minted tokens, keyed by the auth file path. */
const liveTokens = new Map<string, { accessToken: string; expiresAt?: number }>()
/** Single-flight refreshes, keyed by the auth file path. */
const pendingRefreshes = new Map<string, Promise<{ accessToken: string; expiresAt?: number } | undefined>>()

export interface ValidToken {
  accessToken: string
  userId: string
  /** True when the token was minted by this plugin (not read from the file). */
  minted: boolean
}

export interface TokenOptions {
  /** AtomCode home override; empty/undefined = ATOMCODE_HOME / ~/.atomcode. */
  home?: string
  /** Allow the oauth refresh call when the file token is stale. */
  allowRefresh?: boolean
  /** Directory for the sidecar mirror of a minted token. */
  cacheDir?: string
}

interface Sidecar {
  accessToken: string
  expiresAt?: number
  fetchedAt: string
}

function sidecarPath(cacheDir: string): string {
  return join(cacheDir, 'token.json')
}

async function readSidecar(cacheDir: string): Promise<Sidecar | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sidecarPath(cacheDir), 'utf8')) as Partial<Sidecar>
    if (typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0) {
      return {
        accessToken: parsed.accessToken,
        ...(typeof parsed.expiresAt === 'number' ? { expiresAt: parsed.expiresAt } : {}),
        fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '',
      }
    }
  } catch {
    /* no sidecar yet */
  }
  return undefined
}

async function writeSidecar(cacheDir: string, token: { accessToken: string; expiresAt?: number }): Promise<void> {
  try {
    const path = sidecarPath(cacheDir)
    const file: Sidecar = {
      accessToken: token.accessToken,
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      fetchedAt: new Date().toISOString(),
    }
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(file), 'utf8')
    await rename(tmp, path)
  } catch {
    /* sidecar is best-effort */
  }
}

export async function refreshAccessToken(auth: AtomAuth): Promise<{ accessToken: string; expiresAt?: number } | undefined> {
  if (!auth.refreshToken) return undefined
  try {
    const res = await fetch(`${PLATFORM_BASE}/oauth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: auth.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as Record<string, unknown>
    const inner = (typeof body.data === 'object' && body.data !== null ? body.data : body) as Record<string, unknown>
    const accessToken =
      typeof inner.access_token === 'string' ? inner.access_token : typeof inner.accessToken === 'string' ? inner.accessToken : undefined
    if (!accessToken) return undefined
    const expiresIn = typeof inner.expires_in === 'number' ? inner.expires_in : undefined
    return { accessToken, ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}) }
  } catch {
    return undefined
  }
}

/**
 * The token to sign the next request with. Order: fresh minted token ->
 * fresh file token -> sidecar (CLI not running) -> refresh (when allowed) ->
 * the file token as-is.
 */
export async function getValidAccessToken(options: TokenOptions = {}): Promise<ValidToken> {
  const path = authPath(options.home)
  const auth = readAuthCached(path)
  const now = Date.now()
  const cacheDir = options.cacheDir ?? join(homedir(), '.free2dsh', 'cache', 'atomcode')
  const fileFresh = auth.expiresAt === undefined || now < auth.expiresAt - 120_000
  const live = liveTokens.get(path)

  if (live && live.expiresAt !== undefined && now < live.expiresAt - 120_000) {
    return { accessToken: live.accessToken, userId: auth.userId, minted: true }
  }
  if (fileFresh) {
    // The CLI renewed the file after we minted ours: prefer the file token.
    if (live) liveTokens.delete(path)
    return { accessToken: auth.accessToken, userId: auth.userId, minted: false }
  }

  // Stale file token: sidecar first (the CLI is not running), then refresh.
  const sidecar = await readSidecar(cacheDir)
  if (sidecar && (sidecar.expiresAt === undefined || now < sidecar.expiresAt - 120_000)) {
    liveTokens.set(path, { accessToken: sidecar.accessToken, ...(sidecar.expiresAt ? { expiresAt: sidecar.expiresAt } : {}) })
    return { accessToken: sidecar.accessToken, userId: auth.userId, minted: true }
  }
  if (options.allowRefresh === false) {
    return { accessToken: auth.accessToken, userId: auth.userId, minted: false }
  }

  let pending = pendingRefreshes.get(path)
  if (!pending) {
    pending = refreshAccessToken(auth).finally(() => pendingRefreshes.delete(path))
    pendingRefreshes.set(path, pending)
  }
  const refreshed = await pending
  if (refreshed) {
    liveTokens.set(path, refreshed)
    await writeSidecar(cacheDir, refreshed)
    return { accessToken: refreshed.accessToken, userId: auth.userId, minted: true }
  }
  // Refresh failed: use the file token as-is and let upstream answer 401.
  return { accessToken: auth.accessToken, userId: auth.userId, minted: false }
}

/** 401/403 from upstream: drop the minted token so the next call re-reads. */
export function dropLiveToken(home?: string): void {
  liveTokens.delete(authPath(home))
}

/** Exposed for the startup probe: read without minting. */
export async function readAtomCodeCredentials(home?: string): Promise<AtomAuth> {
  const path = authPath(home)
  try {
    await stat(path)
  } catch {
    throw new CredentialsError(`free2dsh[atomcode]: no AtomCode login at ${path}. Run \`atomcode login\` once, then retry.`, 'ATOMCODE_NOT_INSTALLED')
  }
  return readAuthCached(path)
}

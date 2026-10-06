import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 7-day TTL disk cache shared by the lane catalogs.
 *
 * Every lane has the same fallback shape — live source -> disk cache ->
 * compiled-in static roster — and the cache only ever costs freshness, never
 * correctness. A corrupt or truncated file is therefore treated as a miss
 * rather than an error, and writes go through a temp file so a crash mid-write
 * can never leave a half-parsed catalog behind.
 */

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface CacheEnvelope<T> {
  fetchedAt: string
  entries: T[]
  /** Free-form per-lane extras (hosts, counts, …). */
  meta?: Record<string, unknown>
}

/** Plugin data dir. `FREE2DSH_HOME` overrides the home part. */
export function defaultDataDir(): string {
  const configured = process.env.FREE2DSH_HOME?.trim()
  return configured && configured.length > 0 ? configured : join(homedir(), '.free2dsh')
}

export function cacheFile(dataDir: string, lane: string): string {
  return join(dataDir, 'cache', `${lane}.json`)
}

/** Read a fresh cache envelope, or undefined on miss/expiry/corruption. */
export async function readCache<T>(path: string): Promise<CacheEnvelope<T> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CacheEnvelope<T>
    const age = Date.now() - new Date(parsed.fetchedAt).getTime()
    if (!Number.isFinite(age) || age < 0 || age >= CACHE_TTL_MS) return undefined
    if (!Array.isArray(parsed.entries)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Write the envelope atomically. Never throws — a failed cache is a miss later. */
export async function writeCache<T>(path: string, entries: T[], meta?: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const body: CacheEnvelope<T> = { fetchedAt: new Date().toISOString(), entries, ...(meta ? { meta } : {}) }
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(body), 'utf8')
    await rename(tmp, path)
  } catch {
    /* cache is best-effort */
  }
}

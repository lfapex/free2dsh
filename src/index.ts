import { Free2dshAdapter } from './adapter.ts'
import { defaultDataDir } from './cache.ts'
import { UnifiedCatalog } from './catalog.ts'
import { Config, resolveConfig, type Free2dshConfig, type ResolvedConfig } from './config.ts'
import { AtomCodeLane } from './lanes/atomcode.ts'
import { ClineLane } from './lanes/cline.ts'
import { clineCachePath } from './lanes/cline-catalog.ts'
import { defaultCredentialsPath } from './lanes/cline-credentials.ts'
import { OpenCodeLane } from './lanes/opencode.ts'
import type { Lane, LaneId, PluginLogger } from './types.ts'

/**
 * free2dsh DSH cordis plugin entry.
 *
 * One install, one provider: the Cline free fleet, the AtomCode (AtomGit
 * CodingPlan) lane and the OpenCode Zen anonymous lane are registered as
 * separate lanes behind a single `free2dsh` provider whose catalog is their
 * union. Per-lane filter routes (`free2dsh-cline`, …) are registered too, so a
 * picker can be narrowed to one platform without uninstalling anything.
 *
 * The adapter registers FIRST and every lane warms its catalog in the
 * background, so the provider is usable the moment the plugin loads even when
 * one upstream is down or you are not logged in to that platform yet.
 *
 * dispose(): stop the lane timers. The cordis fiber disposal guarantees this
 * runs on plugin reload/unload and on DSH shutdown.
 */

// Minimal structural typing against the host ctx; keeps the plugin
// independent of the exact @deepseek-ai/cordis version DSH ships.
export interface PluginContext {
  logger: PluginLogger
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  effect?(fn: () => () => void): unknown
}

export const name = 'free2dsh'

/** Bumped per release; logged at registration so the live code is identifiable. */
export const PLUGIN_VERSION = '0.1.0'

/**
 * The plugin's settings schema. DSH reads this export to decide which fields
 * are editable under this entry's Loader id, so it must be named `Config`.
 */
export { Config }

/** Only `llm` gates this fiber: the adapter needs nothing else. */
export const inject = ['llm'] as const

export type { Free2dshConfig, ResolvedConfig }

/** Build the enabled lanes, in picker order, from resolved config. */
export function buildLanes(config: ResolvedConfig, logger: PluginLogger, dataDir: string): Lane[] {
  const lanes: Lane[] = []
  const wanted = new Set<LaneId>(config.lanes)

  if (wanted.has('cline')) {
    lanes.push(
      new ClineLane({
        baseURL: config.clineBaseURL,
        credentialsPath: config.clineCredentialsPath || defaultCredentialsPath(),
        cachePath: clineCachePath(dataDir),
        freeOnly: config.clineFreeOnly,
        includeClinePass: config.clineIncludePass,
        refreshSeconds: config.refreshSeconds,
        ...(config.firstEventMs !== undefined ? { firstEventMs: config.firstEventMs } : {}),
        ...(config.bodyIdleMs !== undefined ? { bodyIdleMs: config.bodyIdleMs } : {}),
        logger,
      }),
    )
  }

  if (wanted.has('atomcode')) {
    lanes.push(
      new AtomCodeLane({
        home: config.atomcodeHome,
        models: config.atomcodeModels,
        hosts: config.atomcodeHosts,
        clientVersion: config.atomcodeClientVersion,
        allowRefresh: config.atomcodeAllowRefresh,
        refreshSeconds: config.refreshSeconds,
        dataDir,
        ...(config.firstEventMs !== undefined ? { firstEventMs: config.firstEventMs } : {}),
        ...(config.bodyIdleMs !== undefined ? { bodyIdleMs: config.bodyIdleMs } : {}),
        logger,
      }),
    )
  }

  if (wanted.has('opencode')) {
    lanes.push(
      new OpenCodeLane({
        baseURL: config.opencodeBaseURL,
        includeResponsesOnly: config.opencodeIncludeResponsesOnly,
        refreshSeconds: config.refreshSeconds,
        dataDir,
        ...(config.firstEventMs !== undefined ? { firstEventMs: config.firstEventMs } : {}),
        ...(config.bodyIdleMs !== undefined ? { bodyIdleMs: config.bodyIdleMs } : {}),
        logger,
      }),
    )
  }

  return lanes
}

export function apply(ctx: PluginContext, config: Free2dshConfig = {}): void {
  const logger = ctx.logger
  const resolved = resolveConfig(config)

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('free2dsh: llm service unavailable; adapter cannot register')
    return
  }
  if (resolved.lanes.length === 0) {
    logger.error('free2dsh: no enabled lanes (check the `lanes` config); nothing to register')
    return
  }

  const dataDir = resolved.dataDir.trim().length > 0 ? resolved.dataDir : defaultDataDir()
  const lanes = buildLanes(resolved, logger, dataDir)
  const catalog = new UnifiedCatalog(lanes, resolved.providerId)
  const adapter = new Free2dshAdapter({
    catalog,
    ...(resolved.firstEventMs !== undefined ? { firstEventMs: resolved.firstEventMs } : {}),
    ...(resolved.bodyIdleMs !== undefined ? { bodyIdleMs: resolved.bodyIdleMs } : {}),
  })

  // Register FIRST: the provider must appear in the selector right away, even
  // while the catalogs are still warming. A throw anywhere below must never
  // cost the deployment its provider.
  const routes = [resolved.providerId, ...lanes.map((lane) => `${resolved.providerId}-${lane.id}`)]
  ctx.llm.registerAdapter(routes, adapter)
  logger.info(`free2dsh v${PLUGIN_VERSION}: adapter registered for ${routes.map((route) => `"${route}"`).join(', ')} — ${catalog.summary()}`)

  // Warm every lane in the background. One lane failing (no login, network
  // down, upstream 5xx) must not delay or break the others.
  for (const lane of lanes) {
    void lane
      .start()
      .then(() => {
        logger.info(`free2dsh: ${lane.label} ready — ${lane.health().models} model(s), catalog ${lane.health().catalog}`)
      })
      .catch((err: Error) => {
        logger.warn(`free2dsh: ${lane.label} warm-up failed: ${err.message} (other lanes unaffected)`)
      })
  }

  const maybeEffect = ctx.effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      for (const lane of lanes) lane.stop()
    })
  }
}

export { Free2dshAdapter } from './adapter.ts'
export { UnifiedCatalog, type UnifiedModel } from './catalog.ts'
export { defaultDataDir } from './cache.ts'
export { resolveConfig, type Free2dshConfig as Free2dshPluginConfig } from './config.ts'
export { ClineLane } from './lanes/cline.ts'
export { AtomCodeLane } from './lanes/atomcode.ts'
export { OpenCodeLane } from './lanes/opencode.ts'
export { LANE_IDS, type Lane, type LaneId, type LaneModel, type PluginLogger } from './types.ts'
export type { HarnessChunk, FinishReason } from './chunks.ts'

/**
 * Shared vocabulary for every free lane.
 *
 * A "lane" is one upstream free-model source with its own auth, wire format
 * and catalog. Each lane publishes bare upstream model ids; the unified
 * catalog namespaces them as `<lane>/<bare>` so Cline's `cline-free/…` ids and
 * AtomCode's `qwen3.8-27b` can coexist in one provider column without
 * colliding.
 */

import type { HarnessChunk } from './chunks.ts'

/** The free lanes this plugin speaks for. Order is the picker order. */
export const LANE_IDS = ['cline', 'atomcode', 'opencode'] as const
export type LaneId = (typeof LANE_IDS)[number]

export function isLaneId(value: unknown): value is LaneId {
  return typeof value === 'string' && (LANE_IDS as readonly string[]).includes(value)
}

/** One model as its lane knows it: bare upstream id + whatever limits it has. */
export interface LaneModel {
  /** Bare upstream model id — exactly what goes on the wire. */
  id: string
  /** Human display name; falls back to the id. */
  name?: string
  contextWindow?: number
  maxOutput?: number
  imageInput?: boolean
  reasoning?: boolean
  /** Effort ladder the upstream advertises, when it declares one. */
  reasoningLevels?: string[]
  /** Lane-specific upstream base override (AtomCode round-robins hosts). */
  baseUrl?: string
}

export type LaneStatus = 'warming' | 'ready' | 'degraded' | 'disabled'

export interface LaneHealth {
  lane: LaneId
  status: LaneStatus
  /** Models the lane currently exposes. */
  models: number
  /** Last error, or '' when the lane is clean. */
  detail: string
  /** Catalog tier: live / cache / static / none. */
  catalog: string
}

export interface PluginLogger {
  debug?(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * One upstream source of free models.
 *
 * Lanes own their credentials, their catalog refresh and their wire format;
 * the unified adapter only routes a resolved (lane, model) pair here.
 */
export interface Lane {
  readonly id: LaneId
  /** Badge appended to the picker display name, e.g. "Cline". */
  readonly label: string
  /** Bare upstream model ids, in picker order. */
  models(): string[]
  entry(model: string): LaneModel | undefined
  health(): LaneHealth
  /**
   * Local-only warm start: seed the catalog from this lane's disk cache and,
   * failing that, from its compiled-in roster. Must never touch the network and
   * must never throw, so the host can call it and read the catalog in the same
   * breath. Optional only for test doubles; every shipped lane implements it.
   */
  prime?(): Promise<void>
  /** Warm the catalog and arm the refresh timer. Never throws. */
  start(): Promise<void>
  stop(): void
  /**
   * Stream one completion for `model` (bare id). Must always terminate with a
   * `usage` chunk followed by a `finish` chunk, including on failure.
   */
  stream(model: string, options: HarnessGenerateOptions): AsyncIterable<HarnessChunk>
}

/* ------------------------------------------------------------------ */
/* Harness vocabulary (dsh-llm GenerateOptions / StreamChunk)         */
/* ------------------------------------------------------------------ */

export interface HarnessTool {
  name: string
  description: string
  parameters: unknown
}

export type HarnessBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'image'; [key: string]: unknown }
  | { type: 'tool-result'; toolCallId: string; content: HarnessBlock[]; isError?: boolean; [key: string]: unknown }

export interface HarnessMessage {
  role: 'system' | 'user' | 'assistant'
  content: HarnessBlock[]
  source?: { kind: string; provider?: string; model?: string; callId?: string; [key: string]: unknown }
}

export interface HarnessGenerateOptions {
  provider: string
  model: string
  messages: HarnessMessage[]
  system?: unknown
  tools?: HarnessTool[]
  maxTokens?: number
  temperature?: number
  reasoning?: string
  reasoningEffort?: string
  signal?: AbortSignal
  [key: string]: unknown
}

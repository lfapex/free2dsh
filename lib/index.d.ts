import Schema from "@deepseek-ai/schemastery";

//#region src/chunks.d.ts

/**
 * Harness StreamChunk vocabulary plus the terminal helpers every lane shares.
 *
 * The chunk stream must end with `usage` then `finish`; lanes that build their
 * own wire (AtomCode, OpenCode Zen) emit chunks directly, lanes that borrow a
 * library stream (Cline via pi-ai) map its events onto the same vocabulary.
 * Derived from cline2dsh/events.ts and atomcode2dsh/chunks.ts, which are both
 * clean-room ports of dsh-llm-pi-ai's toStreamChunks.
 */
type HarnessChunk = {
  type: 'block-start';
  index: number;
  blockType: 'text' | 'reasoning' | 'tool-call';
} | {
  type: 'text-delta';
  index: number;
  text: string;
} | {
  type: 'block-end';
  index: number;
  block: {
    type: 'text';
    text: string;
  } | {
    type: 'reasoning';
    text: string;
  } | {
    type: 'tool-call';
    id: string;
    name: string;
    arguments: string;
  };
} | {
  type: 'reasoning-delta';
  index: number;
  text: string;
} | {
  type: 'tool-call-delta';
  index: number;
  id: string;
  name?: string;
  argumentsDelta: string;
} | {
  type: 'usage';
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
} | {
  type: 'finish';
  reason: FinishReason;
  replayState?: unknown;
};
type FinishReason = {
  kind: 'stop';
} | {
  kind: 'max-tokens';
} | {
  kind: 'tool-calls';
} | {
  kind: 'aborted';
  failure: {
    message: string;
    code: string;
  };
} | {
  kind: 'error';
  failure: {
    message: string;
    code: string;
  };
};
//#endregion
//#region src/types.d.ts

/** The free lanes this plugin speaks for. Order is the picker order. */
declare const LANE_IDS: readonly ["cline", "atomcode", "opencode"];
type LaneId = (typeof LANE_IDS)[number];
/** One model as its lane knows it: bare upstream id + whatever limits it has. */
interface LaneModel {
  /** Bare upstream model id — exactly what goes on the wire. */
  id: string;
  /** Human display name; falls back to the id. */
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  imageInput?: boolean;
  reasoning?: boolean;
  /** Effort ladder the upstream advertises, when it declares one. */
  reasoningLevels?: string[];
  /** Lane-specific upstream base override (AtomCode round-robins hosts). */
  baseUrl?: string;
}
type LaneStatus = 'warming' | 'ready' | 'degraded' | 'disabled';
interface LaneHealth {
  lane: LaneId;
  status: LaneStatus;
  /** Models the lane currently exposes. */
  models: number;
  /** Last error, or '' when the lane is clean. */
  detail: string;
  /** Catalog tier: live / cache / static / none. */
  catalog: string;
}
interface PluginLogger {
  debug?(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
/**
 * One upstream source of free models.
 *
 * Lanes own their credentials, their catalog refresh and their wire format;
 * the unified adapter only routes a resolved (lane, model) pair here.
 */
interface Lane {
  readonly id: LaneId;
  /** Badge appended to the picker display name, e.g. "Cline". */
  readonly label: string;
  /** Bare upstream model ids, in picker order. */
  models(): string[];
  entry(model: string): LaneModel | undefined;
  health(): LaneHealth;
  /** Warm the catalog and arm the refresh timer. Never throws. */
  start(): Promise<void>;
  stop(): void;
  /**
   * Stream one completion for `model` (bare id). Must always terminate with a
   * `usage` chunk followed by a `finish` chunk, including on failure.
   */
  stream(model: string, options: HarnessGenerateOptions): AsyncIterable<HarnessChunk>;
}
interface HarnessTool {
  name: string;
  description: string;
  parameters: unknown;
}
type HarnessBlock = {
  type: 'text';
  text: string;
} | {
  type: 'reasoning';
  text: string;
} | {
  type: 'tool-call';
  id: string;
  name: string;
  arguments: string;
} | {
  type: 'image';
  [key: string]: unknown;
} | {
  type: 'tool-result';
  toolCallId: string;
  content: HarnessBlock[];
  isError?: boolean;
  [key: string]: unknown;
};
interface HarnessMessage {
  role: 'system' | 'user' | 'assistant';
  content: HarnessBlock[];
  source?: {
    kind: string;
    provider?: string;
    model?: string;
    callId?: string;
    [key: string]: unknown;
  };
}
interface HarnessGenerateOptions {
  provider: string;
  model: string;
  messages: HarnessMessage[];
  system?: unknown;
  tools?: HarnessTool[];
  maxTokens?: number;
  temperature?: number;
  reasoning?: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
}
//#endregion
//#region src/config.d.ts
/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 *
 * One flat namespace with a per-lane prefix: DSH renders the settings card from
 * this schema, and a flat shape keeps every override a one-liner in the patch
 * file (`clineFreeOnly: false`) without nested-object default ambiguity.
 */
interface Free2dshConfig {
  /** Provider route registered for the merged catalog (the model picker column). */
  providerId?: string;
  /** Lanes to expose. Empty = every lane this plugin ships. */
  lanes?: string[];
  /** Catalog refresh interval in seconds. */
  refreshSeconds?: number;
  /** Plugin data dir for catalogs / token sidecars. Empty = ~/.free2dsh. */
  dataDir?: string;
  /** Cline OpenAI-compatible API base. */
  clineBaseURL?: string;
  /** Cline desktop credentials file. Empty = ~/.cline/data/settings/providers.json. */
  clineCredentialsPath?: string;
  /** Only expose Cline free models (default true). */
  clineFreeOnly?: boolean;
  /** Also expose the Cline Pass bucket (needs a paid subscription). */
  clineIncludePass?: boolean;
  /** AtomCode CLI home. Empty = ~/.atomcode (ATOMCODE_HOME overrides). */
  atomcodeHome?: string;
  /** Upstream `.../v1` bases, tried round-robin. Empty = config.toml + defaults. */
  atomcodeHosts?: string[];
  /** `X-AtomCode-Ver` value. Empty = the verified default. */
  atomcodeClientVersion?: string;
  /** Model id allowlist. Empty = every AtomCode model found. */
  atomcodeModels?: string[];
  /** Allow minting a fresh token when the CLI file token is stale. */
  atomcodeAllowRefresh?: boolean;
  /** OpenCode Zen base. */
  opencodeBaseURL?: string;
  /** Expose `muse-spark-*` (Responses-API-only; not usable on this wire). */
  opencodeIncludeResponsesOnly?: boolean;
  /** ms to wait for the first stream event. */
  firstEventMs?: number;
  /** ms of body silence tolerated mid-stream. */
  bodyIdleMs?: number;
}
type ResolvedConfig = Required<Omit<Free2dshConfig, 'lanes' | 'firstEventMs' | 'bodyIdleMs'>> & {
  /** Enabled lanes in canonical order; already validated against LANE_IDS. */
  lanes: LaneId[];
} & Pick<Free2dshConfig, 'firstEventMs' | 'bodyIdleMs'>;
declare function resolveConfig(config?: Free2dshConfig): ResolvedConfig;
/**
 * The plugin's `Config` — the DSH settings contract. Everything here is
 * ordinary composition configuration (set via cordis.patch.yml), so no
 * `.volatile()` node: the settings card stays read-only for these fields.
 */
declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
  providerId: Schema<string, string, "defined">;
  lanes: Schema<string[], string[], "defined">;
  refreshSeconds: Schema<number, number, "defined">;
  dataDir: Schema<string, string, "defined">;
  clineBaseURL: Schema<string, string, "defined">;
  clineCredentialsPath: Schema<string, string, "defined">;
  clineFreeOnly: Schema<boolean, boolean, "defined">;
  clineIncludePass: Schema<boolean, boolean, "defined">;
  atomcodeHome: Schema<string, string, "defined">;
  atomcodeHosts: Schema<string[], string[], "defined">;
  atomcodeClientVersion: Schema<string, string, "defined">;
  atomcodeModels: Schema<string[], string[], "defined">;
  atomcodeAllowRefresh: Schema<boolean, boolean, "defined">;
  opencodeBaseURL: Schema<string, string, "defined">;
  opencodeIncludeResponsesOnly: Schema<boolean, boolean, "defined">;
  firstEventMs: Schema<number, number, "plain">;
  bodyIdleMs: Schema<number, number, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
  providerId: Schema<string, string, "defined">;
  lanes: Schema<string[], string[], "defined">;
  refreshSeconds: Schema<number, number, "defined">;
  dataDir: Schema<string, string, "defined">;
  clineBaseURL: Schema<string, string, "defined">;
  clineCredentialsPath: Schema<string, string, "defined">;
  clineFreeOnly: Schema<boolean, boolean, "defined">;
  clineIncludePass: Schema<boolean, boolean, "defined">;
  atomcodeHome: Schema<string, string, "defined">;
  atomcodeHosts: Schema<string[], string[], "defined">;
  atomcodeClientVersion: Schema<string, string, "defined">;
  atomcodeModels: Schema<string[], string[], "defined">;
  atomcodeAllowRefresh: Schema<boolean, boolean, "defined">;
  opencodeBaseURL: Schema<string, string, "defined">;
  opencodeIncludeResponsesOnly: Schema<boolean, boolean, "defined">;
  firstEventMs: Schema<number, number, "plain">;
  bodyIdleMs: Schema<number, number, "plain">;
}>>, "plain">;
//#endregion
//#region src/catalog.d.ts
interface UnifiedModel {
  /** Id as the picker sees it: `<lane>/<bare>` on the merged route, `<bare>` on a lane route. */
  id: string;
  /** Bare upstream id — what goes on the wire. */
  bare: string;
  lane: LaneId;
  /** Lane badge appended to the display name. */
  label: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  inputModalities: Array<'text' | 'image'>;
}
interface ResolvedModel {
  lane: Lane;
  model: LaneModel;
  bare: string;
}
declare class UnifiedCatalog {
  #private;
  constructor(lanes: Lane[], mergedRoute: string);
  lanes(): Lane[];
  /** Lane ids in picker order. */
  laneIds(): LaneId[];
  /** Provider route for a lane id (`free2dsh-cline`), or undefined. */
  laneRoute(laneId: LaneId): string | undefined;
  /** True when `route` is one of the per-lane filter routes. */
  isLaneRoute(route: string): boolean;
  /** The lane a route belongs to, or undefined for the merged route. */
  laneForRoute(route: string): Lane | undefined;
  laneById(laneId: LaneId): Lane | undefined;
  /**
   * Every model visible on `route`, in lane order then lane order. A lane route
   * returns only that lane with bare ids.
   */
  list(route: string): UnifiedModel[];
  /**
   * Resolve a picker id to its lane and bare upstream id.
   *
   * Accepts `<lane>/<bare>`, a bare id on a lane route, and a bare id on the
   * merged route when exactly one lane knows it (so `opencode/big-pickle` and
   * a bare `big-pickle` both work). Ambiguous bare ids on the merged route fall
   * back to lane order rather than guessing wrong.
   */
  resolve(route: string, modelId: string): ResolvedModel | undefined;
  health(): LaneHealth[];
  /** One-line summary for the boot log. */
  summary(): string;
}
//#endregion
//#region src/adapter.d.ts
/**
 * The dsh-llm adapter for every free lane.
 *
 * Contract (structural, no host import): providerInfo / providerRetryPolicy /
 * imageRequestPricing / listModels / resolveModel / prepareCall / stream. The
 * adapter owns no credentials and no wire format — it resolves a picker id to
 * its lane, then hands the call over. Retry policy stays the host's job.
 *
 * A lane's own stream already runs under the shared watchdog; this outer pass
 * is the backstop for a lane that throws before returning its generator, so
 * dsh-llm always sees a terminal `usage` + `finish` pair.
 */
interface AdapterOptions {
  catalog: UnifiedCatalog;
  firstEventMs?: number;
  bodyIdleMs?: number;
}
declare class Free2dshAdapter {
  #private;
  constructor(options: AdapterOptions);
  providerInfo(provider: string): {
    id: string;
    name: string;
  };
  /** undefined = the host default retry policy. */
  providerRetryPolicy(_provider: string): undefined;
  imageRequestPricing(_provider: string, _model: string): undefined;
  /** Advisory catalog for the DSH model picker (deduped; dsh-llm rejects duplicates). */
  listModels(provider: string): Array<{
    provider: string;
    id: string;
    name: string;
    inputModalities: string[];
  }>;
  resolveModel(provider: string, model: string): {
    provider: string;
    id: string;
    name: string;
    inputModalities: string[];
    context: {
      contextWindow: number;
    };
    defaultMaxTokens: number;
  };
  prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<{
    model: ReturnType<Free2dshAdapter['resolveModel']>;
    stream: (options: HarnessGenerateOptions) => AsyncGenerator<HarnessChunk>;
  }>;
  /** Route one completion to the lane that owns `model`. */
  stream(provider: string, model: string, options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk>;
}
//#endregion
//#region src/cache.d.ts
/** Plugin data dir. `FREE2DSH_HOME` overrides the home part. */
declare function defaultDataDir(): string;
//#endregion
//#region src/lanes/cline-catalog.d.ts
interface ClineCatalogOptions {
  baseURL: string;
  credentialsPath: string;
  cachePath: string;
  freeOnly: boolean;
  includeClinePass: boolean;
  fetchImpl?: typeof fetch;
}
//#endregion
//#region src/lanes/cline.d.ts
interface ClineLaneOptions extends Pick<ClineCatalogOptions, 'baseURL' | 'credentialsPath' | 'cachePath' | 'freeOnly' | 'includeClinePass'> {
  refreshSeconds: number;
  firstEventMs?: number;
  bodyIdleMs?: number;
  logger: PluginLogger;
}
declare class ClineLane implements Lane {
  #private;
  readonly id: "cline";
  readonly label = "Cline";
  constructor(options: ClineLaneOptions);
  models(): string[];
  entry(model: string): LaneModel | undefined;
  health(): LaneHealth;
  start(): Promise<void>;
  stop(): void;
  stream(model: string, options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk>;
}
//#endregion
//#region src/lanes/atomcode.d.ts
interface AtomCodeLaneOptions {
  home: string;
  models: string[];
  hosts: string[];
  clientVersion: string;
  allowRefresh: boolean;
  refreshSeconds: number;
  /** Plugin data dir (~/.free2dsh); holds the catalog cache and token sidecar. */
  dataDir: string;
  firstEventMs?: number;
  bodyIdleMs?: number;
  logger: PluginLogger;
}
declare class AtomCodeLane implements Lane {
  #private;
  readonly id: "atomcode";
  readonly label = "AtomCode";
  constructor(options: AtomCodeLaneOptions);
  models(): string[];
  entry(model: string): LaneModel | undefined;
  hosts(): string[];
  health(): LaneHealth;
  start(): Promise<void>;
  stop(): void;
  /**
   * Re-read config.toml, fall back to the 7-day disk cache, then the static
   * roster. All local reads, so it is safe to run synchronously at boot and
   * the provider shows up fully populated.
   */
  refresh(): Promise<void>;
  stream(model: string, options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk>;
  /** Startup probe so a missing CLI login surfaces as a warning, not a failure. */
  probeCredentials(): Promise<void>;
  maxTokensFor(model: string): number;
  contextWindowFor(model: string): number;
}
//#endregion
//#region src/lanes/opencode.d.ts
interface OpenCodeLaneOptions {
  baseURL: string;
  dataDir: string;
  refreshSeconds: number;
  includeResponsesOnly: boolean;
  firstEventMs?: number;
  bodyIdleMs?: number;
  logger: PluginLogger;
  fetchImpl?: typeof fetch;
}
declare class OpenCodeLane implements Lane {
  #private;
  readonly id: "opencode";
  readonly label = "OpenCode Zen";
  constructor(options: OpenCodeLaneOptions);
  models(): string[];
  entry(model: string): LaneModel | undefined;
  health(): LaneHealth;
  start(): Promise<void>;
  stop(): void;
  /**
   * Live `GET /v1/models` ∩ free verdict, models.dev metadata enrichment
   * best-effort; 7-day disk cache next; verified static roster last.
   */
  refresh(): Promise<void>;
  stream(model: string, options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk>;
  contextWindowFor(model: string): number;
  maxTokensFor(model: string): number;
}
//#endregion
//#region src/index.d.ts
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
interface PluginContext {
  logger: PluginLogger;
  llm?: {
    registerAdapter(providers: string[], adapter: unknown): unknown;
  };
  effect?(fn: () => () => void): unknown;
}
declare const name = "free2dsh";
/** Bumped per release; logged at registration so the live code is identifiable. */
declare const PLUGIN_VERSION = "0.1.0";
/** Only `llm` gates this fiber: the adapter needs nothing else. */
declare const inject: readonly ["llm"];
/** Build the enabled lanes, in picker order, from resolved config. */
declare function buildLanes(config: ResolvedConfig, logger: PluginLogger, dataDir: string): Lane[];
declare function apply(ctx: PluginContext, config?: Free2dshConfig): void;
//#endregion
export { AtomCodeLane, ClineLane, Config, type FinishReason, Free2dshAdapter, type Free2dshConfig, type Free2dshConfig as Free2dshPluginConfig, type HarnessChunk, LANE_IDS, type Lane, type LaneId, type LaneModel, OpenCodeLane, PLUGIN_VERSION, PluginContext, type PluginLogger, type ResolvedConfig, UnifiedCatalog, type UnifiedModel, apply, buildLanes, defaultDataDir, inject, name, resolveConfig };
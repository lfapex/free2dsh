import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { readFileSync, statSync } from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

//#region src/chunks.ts
const EMPTY_RESPONSE$1 = "EMPTY_RESPONSE";
const QUOTA_EXCEEDED = "QUOTA_EXCEEDED";
/** Upstream error text -> harness failure code. */
function classifyError(text) {
	if (/\bRegionError\b|not available in your country/i.test(text)) return "REGION_BLOCKED";
	if (/\b(?:401|403)\b|unauthor|forbidden|invalid.?token/i.test(text)) return "AUTH";
	if (/insufficient|quota|billing|credit/i.test(text)) return QUOTA_EXCEEDED;
	if (/\b429\b|rate.?limit/i.test(text)) return "RATE_LIMIT";
	if (/\b413\b|payload too large|request body too large/i.test(text)) return "INVALID_REQUEST";
	if (/\b400\b|invalid.?request/i.test(text)) return "INVALID_REQUEST";
	if (/\b5\d\d\b/.test(text)) return "SERVER";
	if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return "TIMEOUT";
	if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|terminated|premature close/i.test(text)) return "NETWORK";
	return "UPSTREAM";
}
function errorFinish(message, code) {
	return {
		kind: "error",
		failure: {
			message,
			code: code ?? classifyError(message)
		}
	};
}
/** Terminal usage + finish pair for a stream that failed before/while streaming. */
function* terminalChunks(reason) {
	yield {
		type: "usage",
		usage: {
			inputTokens: 0,
			outputTokens: 0
		}
	};
	yield {
		type: "finish",
		reason
	};
}
function emptyResponseFinish(model) {
	return {
		kind: "error",
		failure: {
			message: `model "${model}" returned a completed response with no content`,
			code: EMPTY_RESPONSE$1
		}
	};
}

//#endregion
//#region src/watchdog.ts
/**
* Stream-liveness watchdog, shared by every lane.
*
* Neither fetch nor pi-ai owns a body-silence timeout, so a tunnel that
* connects but never streams would hang the turn forever. Two windows apply:
* FIRST-EVENT until the first chunk lands (connect stage answers in seconds)
* and BODY-IDLE once chunks flow (minutes of mid-stream silence is a dead
* tunnel, not pacing). Timeout-promise racing is the only mechanism that
* actually interrupts a hung next().
*
* A timeout must also STOP the work, not just stop reporting it. Racing the
* deadline abandons a pending next() that is still parked on the socket, so
* every lane receives an AbortController and the watchdog aborts on the way
* out. Without it a timed-out turn leaves its HTTP request streaming: the
* socket, the upstream generation and the credentials are all still pinned
* until the response finishes on its own.
*
* The wrapper also guarantees the contract every lane owes dsh-llm: the stream
* ends with `usage` then `finish`, on every path including a timeout, an early
* upstream close, and a lane that threw before emitting anything.
*/
const DEFAULT_FIRST_EVENT_MS = 3e4;
const DEFAULT_BODY_IDLE_MS = 12e4;
/** Thrown by the deadline promise; caught by the wrapper, never escapes. */
var WatchdogTimeout = class extends Error {
	code;
	constructor(message, code) {
		super(message);
		this.name = "WatchdogTimeout";
		this.code = code;
	}
};
const CLOSE_GRACE_MS = 100;
/** Close an async iterator, giving up after a short grace period. */
async function closeIterator(iterator) {
	let closing;
	try {
		closing = iterator.return?.(void 0);
	} catch {
		return;
	}
	if (!closing) return;
	let grace;
	await Promise.race([Promise.resolve(closing).catch(() => {}), new Promise((resolve) => {
		grace = setTimeout(resolve, CLOSE_GRACE_MS);
		grace.unref?.();
	})]);
	clearTimeout(grace);
}
async function* withWatchdogs(source, options) {
	const firstEventMs = options.firstEventMs ?? DEFAULT_FIRST_EVENT_MS;
	const bodyIdleMs = options.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS;
	const label = options.label;
	const firstMessage = `free2dsh[${label}]: timed out after ${firstEventMs}ms waiting for the first stream event (${options.model})`;
	const idleMessage = `free2dsh[${label}]: stream went silent for ${bodyIdleMs}ms mid-response (${options.model})`;
	const controller = options.abort;
	let detachCaller = () => {};
	if (controller && options.signal) if (options.signal.aborted) controller.abort(options.signal.reason);
	else {
		const forward = () => controller.abort(options.signal?.reason);
		options.signal.addEventListener("abort", forward, { once: true });
		detachCaller = () => options.signal?.removeEventListener("abort", forward);
	}
	const iterator = source[Symbol.asyncIterator]();
	const buffered = [];
	let sawAny = false;
	let finished = false;
	let lastChunkAt = Date.now();
	let timer;
	const deadline = () => {
		clearTimeout(timer);
		const window = sawAny ? bodyIdleMs : firstEventMs;
		const message = sawAny ? idleMessage : firstMessage;
		const ms = Math.max(0, window - (Date.now() - lastChunkAt));
		return new Promise((_, reject) => {
			timer = setTimeout(() => {
				const timeout = new WatchdogTimeout(message, sawAny ? "TIMEOUT_IDLE" : "TIMEOUT_FIRST_EVENT");
				if (controller && !controller.signal.aborted) controller.abort(timeout);
				reject(timeout);
			}, ms);
			timer.unref?.();
		});
	};
	const pull = async () => {
		try {
			return await Promise.race([iterator.next(), deadline()]);
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		for (;;) {
			const next = await pull();
			if (next.done) break;
			lastChunkAt = Date.now();
			sawAny = true;
			buffered.push(next.value);
			if (next.value.type === "finish" || next.value.type !== "usage") break;
		}
		for (const chunk of buffered) {
			if (chunk.type === "finish") finished = true;
			yield chunk;
		}
		buffered.length = 0;
		for (;;) {
			const next = await pull();
			if (next.done) break;
			lastChunkAt = Date.now();
			yield next.value;
			if (next.value.type === "finish") {
				finished = true;
				return;
			}
		}
	} catch (err) {
		clearTimeout(timer);
		const message = err instanceof Error ? err.message : String(err);
		if (!finished) yield* terminalChunks(errorFinish(`${message}`, err instanceof WatchdogTimeout ? err.code : void 0));
		finished = true;
		return;
	} finally {
		clearTimeout(timer);
		detachCaller();
		if (controller && !controller.signal.aborted) controller.abort();
		await closeIterator(iterator);
	}
	if (!finished) yield* terminalChunks(errorFinish(`free2dsh[${label}]: stream ended without a finish event (${options.model})`, "UPSTREAM"));
}

//#endregion
//#region src/adapter.ts
var Free2dshAdapter = class {
	#catalog;
	#firstEventMs;
	#bodyIdleMs;
	constructor(options) {
		this.#catalog = options.catalog;
		this.#firstEventMs = options.firstEventMs;
		this.#bodyIdleMs = options.bodyIdleMs;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: provider
		};
	}
	/** undefined = the host default retry policy. */
	providerRetryPolicy(_provider) {}
	imageRequestPricing(_provider, _model) {}
	/** Advisory catalog for the DSH model picker (deduped; dsh-llm rejects duplicates). */
	listModels(provider) {
		return this.#catalog.list(provider).map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			inputModalities: model.inputModalities
		}));
	}
	resolveModel(provider, model) {
		const entry = this.#catalog.resolve(provider, model);
		if (!entry) return {
			provider,
			id: model,
			name: model,
			inputModalities: ["text"],
			context: { contextWindow: 2e5 },
			defaultMaxTokens: 8192
		};
		return this.#toResolved(provider, this.#describe(provider, model, entry.lane, entry.model));
	}
	async prepareCall(provider, model, _signal) {
		return {
			model: this.resolveModel(provider, model),
			stream: (options) => this.stream(provider, model, options)
		};
	}
	/** Route one completion to the lane that owns `model`. */
	async *stream(provider, model, options) {
		const resolved = this.#catalog.resolve(provider, model);
		if (!resolved) {
			yield* terminalChunks(errorFinish(`free2dsh: unknown model "${model}" on provider "${provider}" — the catalog may be warming up, or the id belongs to another lane`, "UNKNOWN_MODEL"));
			return;
		}
		let inner;
		try {
			inner = resolved.lane.stream(resolved.bare, {
				...options,
				provider,
				model: resolved.bare
			});
		} catch (err) {
			yield* terminalChunks(errorFinish(`free2dsh[${resolved.lane.id}]: ${err.message}`));
			return;
		}
		yield* withWatchdogs({ [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator]() }, {
			...this.#firstEventMs !== void 0 ? { firstEventMs: this.#firstEventMs } : {},
			...this.#bodyIdleMs !== void 0 ? { bodyIdleMs: this.#bodyIdleMs } : {},
			label: resolved.lane.id,
			model: resolved.bare
		});
	}
	#describe(provider, model, lane, entry) {
		const found = this.#catalog.list(provider).find((candidate) => candidate.id === model || candidate.bare === entry.id);
		if (found) return found;
		const bare = this.#catalog.isLaneRoute(provider);
		return {
			id: bare ? model : `${lane.id}/${entry.id}`,
			bare: entry.id,
			lane: lane.id,
			label: lane.label,
			name: bare ? entry.name ?? entry.id : `${entry.name ?? entry.id} · ${lane.label}`,
			contextWindow: typeof entry.contextWindow === "number" && entry.contextWindow > 0 ? entry.contextWindow : 2e5,
			maxTokens: typeof entry.maxOutput === "number" && entry.maxOutput > 0 ? entry.maxOutput : 8192,
			inputModalities: entry.imageInput ? ["text", "image"] : ["text"]
		};
	}
	#toResolved(provider, model) {
		return {
			provider,
			id: model.id,
			name: model.name,
			inputModalities: model.inputModalities,
			context: { contextWindow: model.contextWindow },
			defaultMaxTokens: model.maxTokens
		};
	}
};

//#endregion
//#region src/cache.ts
/**
* 7-day TTL disk cache shared by the lane catalogs.
*
* Every lane has the same fallback shape — live source -> disk cache ->
* compiled-in static roster — and the cache only ever costs freshness, never
* correctness. A corrupt or truncated file is therefore treated as a miss
* rather than an error, and writes go through a temp file so a crash mid-write
* can never leave a half-parsed catalog behind.
*/
const CACHE_TTL_MS = 10080 * 60 * 1e3;
/** Plugin data dir. `FREE2DSH_HOME` overrides the home part. */
function defaultDataDir() {
	const configured = process.env.FREE2DSH_HOME?.trim();
	return configured && configured.length > 0 ? configured : join(homedir(), ".free2dsh");
}
function cacheFile(dataDir, lane) {
	return join(dataDir, "cache", `${lane}.json`);
}
/** Read a fresh cache envelope, or undefined on miss/expiry/corruption. */
async function readCache(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		const age = Date.now() - new Date(parsed.fetchedAt).getTime();
		if (!Number.isFinite(age) || age < 0 || age >= CACHE_TTL_MS) return void 0;
		if (!Array.isArray(parsed.entries)) return void 0;
		return parsed;
	} catch {
		return;
	}
}
/** Write the envelope atomically. Never throws — a failed cache is a miss later. */
async function writeCache(path, entries, meta) {
	try {
		await mkdir(dirname(path), { recursive: true });
		const body = {
			fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
			entries,
			...meta ? { meta } : {}
		};
		const tmp = `${path}.tmp-${process.pid}`;
		await writeFile(tmp, JSON.stringify(body), "utf8");
		await rename(tmp, path);
	} catch {}
}

//#endregion
//#region src/catalog.ts
/**
* The unified catalog: every lane's models behind one provider column.
*
* Ids are namespaced as `<lane>/<bare>` on the merged route so Cline's
* `cline-free/deepseek-v4.1-flash` and AtomCode's `qwen3.8-27b` cannot
* collide. Each lane also gets its own filter route (`free2dsh-cline`, …)
* where ids stay bare, which is handy when you only want to see one platform.
*/
const LANE_SEPARATOR = "/";
const DEFAULT_CONTEXT_WINDOW$3 = 2e5;
const DEFAULT_MAX_TOKENS$3 = 8192;
function contextWindowFor$1(model) {
	const declared = model?.contextWindow;
	return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW$3;
}
function maxTokensFor$1(model) {
	const declared = model?.maxOutput;
	return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_MAX_TOKENS$3;
}
var UnifiedCatalog = class {
	#lanes;
	#mergedRoute;
	constructor(lanes, mergedRoute) {
		this.#lanes = lanes;
		this.#mergedRoute = mergedRoute;
	}
	lanes() {
		return [...this.#lanes];
	}
	/** Lane ids in picker order. */
	laneIds() {
		return this.#lanes.map((lane) => lane.id);
	}
	/** Provider route for a lane id (`free2dsh-cline`), or undefined. */
	laneRoute(laneId) {
		const lane = this.#lanes.find((candidate) => candidate.id === laneId);
		return lane ? `${this.#mergedRoute}-${lane.id}` : void 0;
	}
	/** True when `route` is one of the per-lane filter routes. */
	isLaneRoute(route) {
		return this.#lanes.some((lane) => `${this.#mergedRoute}-${lane.id}` === route);
	}
	/** The lane a route belongs to, or undefined for the merged route. */
	laneForRoute(route) {
		return this.#lanes.find((lane) => `${this.#mergedRoute}-${lane.id}` === route);
	}
	laneById(laneId) {
		return this.#lanes.find((lane) => lane.id === laneId);
	}
	/**
	* Every model visible on `route`, in lane order then lane order. A lane route
	* returns only that lane with bare ids.
	*/
	list(route) {
		const lanes = this.laneForRoute(route) ? [this.laneForRoute(route)] : this.#lanes;
		const bare = this.isLaneRoute(route);
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		for (const lane of lanes) for (const id of lane.models()) {
			const model = lane.entry(id);
			if (!model) continue;
			const modelId = bare ? id : `${lane.id}${LANE_SEPARATOR}${id}`;
			if (seen.has(modelId)) continue;
			seen.add(modelId);
			out.push({
				id: modelId,
				bare: id,
				lane: lane.id,
				label: lane.label,
				name: bare ? model.name ?? id : `${model.name ?? id} · ${lane.label}`,
				contextWindow: contextWindowFor$1(model),
				maxTokens: maxTokensFor$1(model),
				inputModalities: model.imageInput ? ["text", "image"] : ["text"]
			});
		}
		return out;
	}
	/**
	* Resolve a picker id to its lane and bare upstream id.
	*
	* Accepts `<lane>/<bare>`, a bare id on a lane route, and a bare id on the
	* merged route when exactly one lane knows it (so `opencode/big-pickle` and
	* a bare `big-pickle` both work). Ambiguous bare ids on the merged route fall
	* back to lane order rather than guessing wrong.
	*/
	resolve(route, modelId) {
		const routeLane = this.laneForRoute(route);
		if (modelId.includes(LANE_SEPARATOR)) {
			const [prefix, ...rest] = modelId.split(LANE_SEPARATOR);
			const lane = this.laneById(prefix);
			const bare = rest.join(LANE_SEPARATOR);
			if (lane && bare.length > 0 && lane.entry(bare)) return {
				lane,
				model: lane.entry(bare),
				bare
			};
		}
		if (routeLane) {
			const model = routeLane.entry(modelId);
			if (model) return {
				lane: routeLane,
				model,
				bare: model.id
			};
			return;
		}
		for (const lane of this.#lanes) {
			const model = lane.entry(modelId);
			if (model) return {
				lane,
				model,
				bare: model.id
			};
		}
	}
	health() {
		return this.#lanes.map((lane) => lane.health());
	}
	/** One-line summary for the boot log. */
	summary() {
		return this.#lanes.map((lane) => {
			const health = lane.health();
			return `${lane.label} ${health.models}${health.detail ? " (stale)" : ""}`;
		}).join(" · ");
	}
};

//#endregion
//#region src/types.ts
/** The free lanes this plugin speaks for. Order is the picker order. */
const LANE_IDS = [
	"cline",
	"atomcode",
	"opencode"
];

//#endregion
//#region src/config.ts
const defaults = {
	providerId: "free2dsh",
	mergedRoute: false,
	lanes: [],
	refreshSeconds: 300,
	dataDir: "",
	clineBaseURL: "https://api.cline.bot/api/v1",
	clineCredentialsPath: "",
	clineFreeOnly: true,
	clineIncludePass: false,
	atomcodeHome: "",
	atomcodeHosts: [],
	atomcodeClientVersion: "",
	atomcodeModels: [],
	atomcodeAllowRefresh: true,
	opencodeBaseURL: "https://opencode.ai/zen",
	opencodeIncludeResponsesOnly: false
};
/**
* Enabled lanes in canonical order. Unknown names are dropped rather than
* throwing, so a typo costs one lane instead of the whole plugin.
*/
function resolveLanes(config) {
	const requested = (config.lanes ?? []).map((lane) => String(lane).trim().toLowerCase());
	if (requested.length === 0) return [...LANE_IDS];
	const wanted = new Set(requested);
	return LANE_IDS.filter((lane) => wanted.has(lane));
}
function resolveConfig(config = {}) {
	const provided = {};
	for (const [key, value] of Object.entries(config)) if (value !== void 0) provided[key] = value;
	return {
		...defaults,
		...provided,
		lanes: resolveLanes(provided)
	};
}
/**
* The plugin's `Config` — the DSH settings contract. Everything here is
* ordinary composition configuration (set via cordis.patch.yml), so no
* `.volatile()` node: the settings card stays read-only for these fields.
*/
const Config = Schema.object({
	providerId: Schema.string().default(defaults.providerId),
	mergedRoute: Schema.boolean().default(defaults.mergedRoute),
	lanes: Schema.array(Schema.string()).default(defaults.lanes),
	refreshSeconds: Schema.number().step(1).min(30).default(defaults.refreshSeconds),
	dataDir: Schema.string().default(defaults.dataDir),
	clineBaseURL: Schema.string().default(defaults.clineBaseURL),
	clineCredentialsPath: Schema.string().default(defaults.clineCredentialsPath),
	clineFreeOnly: Schema.boolean().default(defaults.clineFreeOnly),
	clineIncludePass: Schema.boolean().default(defaults.clineIncludePass),
	atomcodeHome: Schema.string().default(defaults.atomcodeHome),
	atomcodeHosts: Schema.array(Schema.string()).default(defaults.atomcodeHosts),
	atomcodeClientVersion: Schema.string().default(defaults.atomcodeClientVersion),
	atomcodeModels: Schema.array(Schema.string()).default(defaults.atomcodeModels),
	atomcodeAllowRefresh: Schema.boolean().default(defaults.atomcodeAllowRefresh),
	opencodeBaseURL: Schema.string().default(defaults.opencodeBaseURL),
	opencodeIncludeResponsesOnly: Schema.boolean().default(defaults.opencodeIncludeResponsesOnly),
	firstEventMs: Schema.number().step(1).min(1e3).max(6e5),
	bodyIdleMs: Schema.number().step(1).min(1e3).max(6e5)
});

//#endregion
//#region src/request.ts
/**
* Harness attachment root (mirrors dsh-attachment-local's resolveDshHome).
* DSH_HOME is always set by the harness child; the homedir fallback covers
* direct invocation (tests, tooling).
*/
function dshHome$1() {
	const configured = process.env.DSH_HOME?.trim();
	if (configured) return configured;
	return join(homedir(), ".dsh");
}
/** Content-addressed attachment path for a harness attachment reference. */
function attachmentObjectPath(ref) {
	const attachment = ref ?? {};
	const id = typeof attachment.attachmentId === "string" ? attachment.attachmentId : "";
	const sha = id.startsWith("sha256:") ? id.slice(7) : id;
	if (!/^[0-9a-f]{64}$/.test(sha)) return void 0;
	return join(dshHome$1(), "attachments", "v1", "objects", sha.slice(0, 2), sha);
}
async function attachmentToDataUrl(ref) {
	const attachment = ref ?? {};
	const path = attachmentObjectPath(ref);
	if (!path) return void 0;
	try {
		const bytes = await readFile(path);
		return `data:${typeof attachment.mediaType === "string" && attachment.mediaType.length > 0 ? attachment.mediaType : "image/png"};base64,${bytes.toString("base64")}`;
	} catch {
		return;
	}
}
async function imagePart$1(block) {
	if (block.offloaded === true) {
		const id = block.attachment?.attachmentId;
		return {
			type: "text",
			text: `[image omitted: offloaded to fit the request image budget${typeof id === "string" && id.length > 0 ? ` ${id.slice(0, 30)}` : ""}]`
		};
	}
	const url = await attachmentToDataUrl(block.attachment);
	if (!url) {
		const id = block.attachment?.attachmentId;
		return {
			type: "text",
			text: `[image omitted: unreadable attachment reference ${JSON.stringify(id ?? "")}]`
		};
	}
	return {
		type: "image_url",
		image_url: { url }
	};
}
/** user / tool-result blocks -> OpenAI content parts. */
async function partsFor(blocks, depth = 0) {
	const parts = [];
	if (depth > 8) return parts;
	for (const block of blocks ?? []) if (block.type === "text") parts.push({
		type: "text",
		text: block.text
	});
	else if (block.type === "image") parts.push(await imagePart$1(block));
	else if (block.type === "tool-result") parts.push(...await partsFor(block.content ?? [], depth + 1));
	return parts;
}
function textOnly(parts) {
	return parts.map((part) => part.type === "text" ? part.text : "").filter((text) => text.length > 0).join("");
}
function systemText(system) {
	if (typeof system === "string") return system;
	if (Array.isArray(system)) return system.map((entry) => {
		const block = entry;
		return block?.type === "text" && typeof block.text === "string" ? block.text : "";
	}).filter((text) => text.length > 0).join("\n");
	return "";
}
/**
* Map harness reasoning hints to the effort values free-lane models accept.
* The declared ladder wins when the model publishes one (qwen has `xhigh`).
*/
function reasoningEffortFor(options, levels) {
	const raw = (options.reasoningEffort ?? options.reasoning ?? "").toString().toLowerCase().trim();
	if (!raw || raw === "off" || raw === "none" || raw === "disabled" || raw === "default") return void 0;
	if (levels && levels.length > 0 && levels.includes(raw)) return raw;
	const canonical = raw === "minimal" || raw === "low" ? "low" : raw === "medium" || raw === "middle" ? "medium" : raw === "high" || raw === "xhigh" || raw === "max" || raw === "highest" ? "high" : void 0;
	if (!canonical) return void 0;
	if (levels && levels.length > 0 && !levels.includes(canonical)) return void 0;
	return canonical;
}
/**
* Build the payload object for `options`. `transform` gets the last word on
* the finished body (OpenCode's gate shape rewrites `tools`/`tool_choice`).
* `JSON.stringify(payload)` is the byte string that goes on the wire — one
* stringify, no re-encoding, so AtomCode's signature covers exactly these bytes.
*/
async function buildOpenAIPayload(options, entry, transform) {
	const messages = [];
	const systemParts = [];
	const fromOptions = systemText(options.system);
	if (fromOptions.length > 0) systemParts.push(fromOptions);
	for (const message of options.messages) if (message.role === "system") {
		const text = textOnly(await partsFor(message.content ?? []));
		if (text.length > 0) systemParts.push(text);
	}
	if (systemParts.length > 0) messages.push({
		role: "system",
		content: systemParts.join("\n\n")
	});
	for (const message of options.messages) {
		if (message.role === "system") continue;
		const blocks = message.content ?? [];
		if (message.role === "user") {
			const parts = await partsFor(blocks.filter((block) => block.type !== "tool-result"));
			const results = blocks.filter((block) => block.type === "tool-result");
			if (parts.length > 0 || results.length === 0) messages.push({
				role: "user",
				content: parts.length === 0 ? "" : parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts
			});
			for (const result of results) {
				let rparts = await partsFor(result.content ?? []);
				const hasImage = rparts.some((part) => part.type === "image_url");
				const hasText = rparts.some((part) => part.type === "text" && part.text.length > 0);
				if (!hasImage && !hasText) rparts = [{
					type: "text",
					text: "(no output)"
				}];
				messages.push({
					role: "tool",
					tool_call_id: result.toolCallId,
					content: rparts.length === 1 && rparts[0].type === "text" ? rparts[0].text : rparts
				});
			}
			continue;
		}
		const texts = [];
		const toolCalls = [];
		for (const block of blocks) if (block.type === "text") {
			if (block.text.length > 0) texts.push(block.text);
		} else if (block.type === "tool-call") toolCalls.push({
			id: block.id,
			type: "function",
			function: {
				name: block.name,
				arguments: block.arguments || "{}"
			}
		});
		const content = texts.join("");
		messages.push({
			role: "assistant",
			content: content.length > 0 || toolCalls.length === 0 ? content : null,
			...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
		});
	}
	let payload = {
		model: entry?.id ?? options.model,
		messages,
		stream: true,
		stream_options: { include_usage: true }
	};
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			...tool.description ? { description: tool.description } : {},
			...tool.parameters ? { parameters: tool.parameters } : {}
		}
	}));
	if (tools && tools.length > 0) {
		payload.tools = tools;
		payload.tool_choice = "auto";
	}
	if (typeof options.temperature === "number") payload.temperature = options.temperature;
	if (typeof options.maxTokens === "number" && options.maxTokens > 0) payload.max_tokens = options.maxTokens;
	const effort = reasoningEffortFor(options, entry?.reasoningLevels);
	if (effort) payload.reasoning_effort = effort;
	if (transform) payload = transform(payload);
	return {
		payload,
		body: Buffer.from(JSON.stringify(payload), "utf8")
	};
}

//#endregion
//#region src/sse.ts
var SseParser = class {
	#buffer = "";
	#dataLines = [];
	/** Push one text chunk; returns the events completed by it. */
	push(chunk) {
		this.#buffer += chunk;
		const events = [];
		let index;
		while ((index = this.#buffer.indexOf("\n")) !== -1) {
			const line = this.#buffer.slice(0, index).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(index + 1);
			if (line === "") {
				if (this.#dataLines.length > 0) {
					events.push({ data: this.#dataLines.join("\n") });
					this.#dataLines = [];
				}
				continue;
			}
			if (line.startsWith(":")) continue;
			if (line.startsWith("data:")) this.#dataLines.push(line.slice(5).replace(/^ /, ""));
		}
		return events;
	}
	/**
	* Flush a trailing event that arrived without a terminating blank line: the
	* unterminated buffer line is consumed as a final `data:` line.
	*/
	flush() {
		if (this.#buffer.length > 0) {
			const line = this.#buffer.replace(/\r$/, "");
			this.#buffer = "";
			if (line.startsWith("data:")) this.#dataLines.push(line.slice(5).replace(/^ /, ""));
		}
		if (this.#dataLines.length === 0) return [];
		const events = [{ data: this.#dataLines.join("\n") }];
		this.#dataLines = [];
		return events;
	}
};

//#endregion
//#region src/openai-stream.ts
function usageChunk(usage, fallback) {
	const input = usage?.prompt_tokens ?? 0;
	const output = usage?.completion_tokens ?? 0;
	const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
	const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
	if (!usage && fallback) return {
		inputTokens: 0,
		outputTokens: 0
	};
	return {
		inputTokens: input,
		outputTokens: output + (reasoning > 0 && output === 0 ? reasoning : 0),
		...cached > 0 ? { cacheReadTokens: cached } : {}
	};
}
function finishFromReason(finishReason, sawContent, model) {
	switch (finishReason) {
		case "length": return { kind: "max-tokens" };
		case "tool_calls":
		case "function_call": return { kind: "tool-calls" };
		case "content_filter": return errorFinish(`model "${model}" hit the upstream content filter`, "CONTENT_FILTER");
		default: return sawContent ? { kind: "stop" } : emptyResponseFinish(model);
	}
}
async function* openAiStream(request) {
	const label = request.label;
	let res;
	try {
		res = await fetch(request.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				...request.headers
			},
			body: request.body,
			signal: request.signal
		});
	} catch (err) {
		const message = err.message ?? String(err);
		yield* terminalChunks(err.name === "AbortError" || request.signal?.aborted === true ? {
			kind: "aborted",
			failure: {
				message: `free2dsh[${label}]: aborted`,
				code: "ABORTED"
			}
		} : errorFinish(`free2dsh[${label}]: request failed: ${message}`));
		return;
	}
	if (!res.ok) {
		if (res.status === 401 || res.status === 403) request.onAuthFailure?.();
		let text$1 = "";
		try {
			text$1 = (await res.text()).slice(0, 1200);
		} catch {}
		const detail = text$1.length > 0 ? `: ${text$1}` : "";
		yield* terminalChunks(res.status === 401 || res.status === 403 ? errorFinish(`free2dsh[${label}]: upstream rejected the session (HTTP ${res.status})${detail}`, "AUTH") : errorFinish(`free2dsh[${label}]: upstream HTTP ${res.status}${detail}`));
		return;
	}
	if (!res.body) {
		yield* terminalChunks(errorFinish(`free2dsh[${label}]: upstream returned no response body`));
		return;
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder("utf-8");
	const parser = new SseParser();
	let usage;
	let finishReason;
	let sawContent = false;
	let sawAnything = false;
	let done = false;
	let nextIndex = 0;
	let reasoning;
	let text;
	const tools = /* @__PURE__ */ new Map();
	let failure;
	try {
		for (;;) {
			const { done: streamDone, value } = await reader.read();
			if (streamDone) break;
			const decoded = decoder.decode(value, { stream: true });
			for (const event of parser.push(decoded)) {
				const data = event.data.trim();
				if (data === "[DONE]") {
					done = true;
					break;
				}
				let chunk;
				try {
					chunk = JSON.parse(data);
				} catch {
					continue;
				}
				sawAnything = true;
				if (chunk.usage) usage = chunk.usage;
				const errorField = chunk.error;
				if (errorField && !chunk.choices) {
					failure = errorFinish(`free2dsh[${label}]: ${typeof errorField === "string" ? errorField : errorField.message ?? JSON.stringify(errorField)}`);
					break;
				}
				const choice = chunk.choices?.[0];
				if (!choice) continue;
				if (choice.finish_reason !== void 0 && choice.finish_reason !== null) finishReason = choice.finish_reason;
				const delta = choice.delta;
				if (!delta) continue;
				const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
				if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
					sawContent = true;
					if (!reasoning) {
						reasoning = {
							index: nextIndex++,
							text: ""
						};
						yield {
							type: "block-start",
							index: reasoning.index,
							blockType: "reasoning"
						};
					}
					reasoning.text += reasoningDelta;
					yield {
						type: "reasoning-delta",
						index: reasoning.index,
						text: reasoningDelta
					};
				}
				if (typeof delta.content === "string" && delta.content.length > 0) {
					sawContent = true;
					if (!text) {
						text = {
							index: nextIndex++,
							text: ""
						};
						yield {
							type: "block-start",
							index: text.index,
							blockType: "text"
						};
					}
					text.text += delta.content;
					yield {
						type: "text-delta",
						index: text.index,
						text: delta.content
					};
				}
				for (const part of delta.tool_calls ?? []) {
					sawContent = true;
					const slot = part.index ?? 0;
					let state = tools.get(slot);
					if (!state) {
						state = {
							index: nextIndex++,
							id: part.id ?? "",
							name: part.function?.name ?? "",
							args: ""
						};
						tools.set(slot, state);
						yield {
							type: "block-start",
							index: state.index,
							blockType: "tool-call"
						};
					}
					if (typeof part.id === "string" && part.id.length > 0 && state.id.length === 0) state.id = part.id;
					if (typeof part.function?.name === "string" && part.function.name.length > 0 && state.name.length === 0) state.name = part.function.name;
					const args = part.function?.arguments ?? "";
					if (args.length > 0) {
						state.args += args;
						yield {
							type: "tool-call-delta",
							index: state.index,
							id: state.id,
							...state.name ? { name: state.name } : {},
							argumentsDelta: args
						};
					}
				}
			}
			if (done || failure) break;
		}
	} catch (err) {
		failure = err.name === "AbortError" || request.signal?.aborted === true ? {
			kind: "aborted",
			failure: {
				message: `free2dsh[${label}]: aborted`,
				code: "ABORTED"
			}
		} : errorFinish(`free2dsh[${label}]: stream failed: ${err.message ?? String(err)}`);
	} finally {
		try {
			await reader.cancel();
		} catch {}
	}
	if (failure && !sawAnything) {
		yield* terminalChunks(failure);
		return;
	}
	if (reasoning) yield {
		type: "block-end",
		index: reasoning.index,
		block: {
			type: "reasoning",
			text: reasoning.text
		}
	};
	if (text) yield {
		type: "block-end",
		index: text.index,
		block: {
			type: "text",
			text: text.text
		}
	};
	for (const state of tools.values()) yield {
		type: "block-end",
		index: state.index,
		block: {
			type: "tool-call",
			id: state.id,
			name: state.name,
			arguments: state.args
		}
	};
	yield {
		type: "usage",
		usage: usageChunk(usage, true)
	};
	if (failure) {
		yield {
			type: "finish",
			reason: failure
		};
		return;
	}
	if (request.signal?.aborted === true) {
		yield {
			type: "finish",
			reason: {
				kind: "aborted",
				failure: {
					message: `free2dsh[${label}]: aborted`,
					code: "ABORTED"
				}
			}
		};
		return;
	}
	let reason = finishFromReason(finishReason, sawContent, request.model);
	if (reason.kind === "stop" && finishReason == null && tools.size > 0) reason = { kind: "tool-calls" };
	if (reason.kind === "tool-calls" && tools.size === 0) reason = sawContent ? { kind: "stop" } : emptyResponseFinish(request.model);
	yield {
		type: "finish",
		reason
	};
}

//#endregion
//#region src/lanes/atomcode-auth.ts
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
const PLATFORM_BASE = "https://acs.atomgit.com";
/** Resolve the AtomCode home the same way the CLI does. */
function atomcodeHome(override) {
	const explicit = override?.trim();
	if (explicit && explicit.length > 0) return explicit;
	const env = process.env.ATOMCODE_HOME?.trim();
	if (env && env.length > 0) return env;
	return join(homedir(), ".atomcode");
}
function authPath(home) {
	return join(atomcodeHome(home), "auth.toml");
}
var CredentialsError$1 = class extends Error {
	code;
	constructor(message, code) {
		super(message);
		this.name = "CredentialsError";
		this.code = code;
	}
};
function readTomlString(toml, key) {
	const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
	if (m?.[1] !== void 0) return m[1];
	return toml.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, "m"))?.[1];
}
function parseAuthToml(toml) {
	const accessToken = readTomlString(toml, "access_token");
	const userId = readTomlString(toml, "id");
	if (!accessToken || !userId) return void 0;
	const refreshToken = readTomlString(toml, "refresh_token");
	const expiresIn = Number(readTomlString(toml, "expires_in"));
	const createdAt = Number(readTomlString(toml, "created_at"));
	const expiresAt = Number.isFinite(expiresIn) && Number.isFinite(createdAt) && expiresIn > 0 && createdAt > 0 ? (createdAt + expiresIn) * 1e3 : void 0;
	return {
		accessToken,
		userId,
		...refreshToken ? { refreshToken } : {},
		...expiresAt ? { expiresAt } : {}
	};
}
const authCache = /* @__PURE__ */ new Map();
/**
* mtime-cached read; the CLI rewrites the file, so caching by mtime is exact.
* Throws CredentialsError when the file is missing or carries no session.
*/
function readAuthCached(path) {
	const cached = authCache.get(path);
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		authCache.delete(path);
		throw new CredentialsError$1(`free2dsh[atomcode]: cannot read ${path}. Run \`atomcode login\` once, then retry.`, "ATOMCODE_NOT_INSTALLED");
	}
	if (cached && cached.mtimeMs === mtimeMs) {
		if (cached.auth === void 0) throw new CredentialsError$1(cached.error ?? `free2dsh[atomcode]: ${path} has no session`, "ATOMCODE_NOT_LOGGED_IN");
		return cached.auth;
	}
	let auth;
	let error;
	try {
		auth = parseAuthToml(readFileSync(path, "utf8"));
		if (!auth) error = `free2dsh[atomcode]: ${path} has no access_token/user id — run \`atomcode login\` again`;
	} catch (err) {
		error = `free2dsh[atomcode]: ${path} unreadable: ${err.message}`;
	}
	authCache.set(path, {
		mtimeMs,
		auth,
		error
	});
	if (!auth) throw new CredentialsError$1(error ?? `free2dsh[atomcode]: ${path} has no session`, "ATOMCODE_NOT_LOGGED_IN");
	return auth;
}
/** In-memory minted tokens, keyed by the auth file path. */
const liveTokens$1 = /* @__PURE__ */ new Map();
/** Single-flight refreshes, keyed by the auth file path. */
const pendingRefreshes$1 = /* @__PURE__ */ new Map();
function sidecarPath(cacheDir) {
	return join(cacheDir, "token.json");
}
async function readSidecar(cacheDir) {
	try {
		const parsed = JSON.parse(await readFile(sidecarPath(cacheDir), "utf8"));
		if (typeof parsed.accessToken === "string" && parsed.accessToken.length > 0) return {
			accessToken: parsed.accessToken,
			...typeof parsed.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {},
			fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : ""
		};
	} catch {}
}
async function writeSidecar(cacheDir, token) {
	try {
		const path = sidecarPath(cacheDir);
		const file = {
			accessToken: token.accessToken,
			...token.expiresAt ? { expiresAt: token.expiresAt } : {},
			fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}`;
		await writeFile(tmp, JSON.stringify(file), "utf8");
		await rename(tmp, path);
	} catch {}
}
async function refreshAccessToken(auth) {
	if (!auth.refreshToken) return void 0;
	try {
		const res = await fetch(`${PLATFORM_BASE}/oauth/refresh`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ refresh_token: auth.refreshToken }),
			signal: AbortSignal.timeout(2e4)
		});
		if (!res.ok) return void 0;
		const body = await res.json();
		const inner = typeof body.data === "object" && body.data !== null ? body.data : body;
		const accessToken = typeof inner.access_token === "string" ? inner.access_token : typeof inner.accessToken === "string" ? inner.accessToken : void 0;
		if (!accessToken) return void 0;
		const expiresIn = typeof inner.expires_in === "number" ? inner.expires_in : void 0;
		return {
			accessToken,
			...expiresIn ? { expiresAt: Date.now() + expiresIn * 1e3 } : {}
		};
	} catch {
		return;
	}
}
/**
* The token to sign the next request with. Order: fresh minted token ->
* fresh file token -> sidecar (CLI not running) -> refresh (when allowed) ->
* the file token as-is.
*/
async function getValidAccessToken$1(options = {}) {
	const path = authPath(options.home);
	const auth = readAuthCached(path);
	const now = Date.now();
	const cacheDir = options.cacheDir ?? join(homedir(), ".free2dsh", "cache", "atomcode");
	const fileFresh = auth.expiresAt === void 0 || now < auth.expiresAt - 12e4;
	const live = liveTokens$1.get(path);
	if (live && live.expiresAt !== void 0 && now < live.expiresAt - 12e4) return {
		accessToken: live.accessToken,
		userId: auth.userId,
		minted: true
	};
	if (fileFresh) {
		if (live) liveTokens$1.delete(path);
		return {
			accessToken: auth.accessToken,
			userId: auth.userId,
			minted: false
		};
	}
	const sidecar = await readSidecar(cacheDir);
	if (sidecar && (sidecar.expiresAt === void 0 || now < sidecar.expiresAt - 12e4)) {
		liveTokens$1.set(path, {
			accessToken: sidecar.accessToken,
			...sidecar.expiresAt ? { expiresAt: sidecar.expiresAt } : {}
		});
		return {
			accessToken: sidecar.accessToken,
			userId: auth.userId,
			minted: true
		};
	}
	if (options.allowRefresh === false) return {
		accessToken: auth.accessToken,
		userId: auth.userId,
		minted: false
	};
	let pending = pendingRefreshes$1.get(path);
	if (!pending) {
		pending = refreshAccessToken(auth).finally(() => pendingRefreshes$1.delete(path));
		pendingRefreshes$1.set(path, pending);
	}
	const refreshed = await pending;
	if (refreshed) {
		liveTokens$1.set(path, refreshed);
		await writeSidecar(cacheDir, refreshed);
		return {
			accessToken: refreshed.accessToken,
			userId: auth.userId,
			minted: true
		};
	}
	return {
		accessToken: auth.accessToken,
		userId: auth.userId,
		minted: false
	};
}
/** 401/403 from upstream: drop the minted token so the next call re-reads. */
function dropLiveToken(home) {
	liveTokens$1.delete(authPath(home));
}
/** Exposed for the startup probe: read without minting. */
async function readAtomCodeCredentials(home) {
	const path = authPath(home);
	try {
		await stat(path);
	} catch {
		throw new CredentialsError$1(`free2dsh[atomcode]: no AtomCode login at ${path}. Run \`atomcode login\` once, then retry.`, "ATOMCODE_NOT_INSTALLED");
	}
	return readAuthCached(path);
}

//#endregion
//#region src/lanes/atomcode-models.ts
/** Free-lane account names accepted from config.toml. */
const FREE_ACCOUNTS = new Set(["AtomGit"]);
/** Fallback roster used when config.toml is missing or has no AtomGit model. */
const STATIC_ATOMCODE_MODELS = [{
	id: "qwen3.8-27b",
	name: "qwen3.8-27b",
	baseUrl: "https://llm-api.atomgit.com/v1",
	contextWindow: 262144,
	imageInput: true,
	reasoning: true,
	reasoningLevels: [
		"low",
		"medium",
		"xhigh"
	]
}, {
	id: "glm5.3-flash",
	name: "glm5.3-flash",
	baseUrl: "https://llm-api.atomgit.com/v1",
	contextWindow: 512e3,
	reasoning: true,
	reasoningLevels: ["low", "high"]
}];
/** `[provider_accounts.Name]` -> base_url map. */
function parseProviderAccounts(toml) {
	const out = /* @__PURE__ */ new Map();
	const sections = toml.split(/^\[(?![\s\]])/m);
	for (const section of sections) {
		const header = /^\s*provider_accounts\.("?)([^"\].]+)\1\s*\]/.exec(section);
		if (!header) continue;
		const base = /base_url\s*=\s*"([^"]*)"/.exec(section)?.[1];
		if (base) out.set(header[2], base.replace(/\/+$/, ""));
	}
	return out;
}
/**
* `[models."ID"]` sections whose `account` is on the free lane. The DSH-facing
* id is the bare upstream `model` value, so `AtomGit-qwen3.8-27b` in config.toml
* arrives as `qwen3.8-27b`.
*/
function parseAtomGitModels(toml) {
	const accounts = parseProviderAccounts(toml);
	const out = [];
	for (const match of toml.matchAll(/\[models\."([^"]+)"\]\s*([\s\S]*?)(?=\n\[|$)/g)) {
		const key = match[1];
		const profile = match[2] ?? "";
		const account = /account\s*=\s*"([^"]*)"/.exec(profile)?.[1];
		if (!account || !FREE_ACCOUNTS.has(account)) continue;
		const model = /model\s*=\s*"([^"]*)"/.exec(profile)?.[1];
		if (!model) continue;
		const ctx = Number(/context_window\s*=\s*(\d+)/.exec(profile)?.[1]);
		const maxOut = Number(/max_output_tokens\s*=\s*(\d+)/.exec(profile)?.[1]);
		const levels = /reasoning_effort_levels\s*=\s*\[([^\]]*)\]/.exec(profile)?.[1];
		const baseUrl = accounts.get(account);
		const entry = {
			id: model,
			name: model
		};
		if (baseUrl) entry.baseUrl = baseUrl;
		if (Number.isFinite(ctx) && ctx > 0) entry.contextWindow = ctx;
		if (Number.isFinite(maxOut) && maxOut > 0) entry.maxOutput = maxOut;
		if (/supports_vision\s*=\s*true/.test(profile)) entry.imageInput = true;
		if (!/supports_reasoning\s*=\s*false/.test(profile)) entry.reasoning = true;
		if (levels) entry.reasoningLevels = [...levels.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		if (key && key !== model) entry.name = entry.name ?? key;
		out.push(entry);
	}
	return out;
}

//#endregion
//#region src/lanes/atomcode-signing.ts
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
const DEFAULT_MASTER_KEY_HEX = "e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123";
/**
* Client version sent as `X-AtomCode-Ver` (and hashed into the signature salt).
* Bump it when AtomCode updates and the gateway starts rejecting `1`
* signatures; `atomcodeClientVersion` in the plugin config overrides it.
*/
const DEFAULT_CLIENT_VERSION = "5.2.1";
function signAtomCodeRequest(options) {
	const masterKey = Buffer.from(options.masterKeyHex ?? DEFAULT_MASTER_KEY_HEX, "hex");
	const tokenHash = createHash("sha256").update(options.accessToken, "utf8").digest();
	const versionHash = createHash("sha256").update(options.clientVersion, "utf8").digest();
	const hourBucket = Buffer.alloc(8);
	hourBucket.writeBigUInt64LE(BigInt(Math.floor(options.timestampSeconds / 3600)));
	const signingKey = createHmac("sha256", createHmac("sha256", Buffer.concat([
		Buffer.from(options.userId, "utf8"),
		Buffer.from([1]),
		hourBucket,
		tokenHash,
		versionHash
	])).update(masterKey).digest()).update("atomcode-signing-v1").update(Buffer.from([1])).digest();
	const bodyHash = createHash("sha256").update(options.body).digest("hex");
	const canonical = [
		"v1",
		options.method.toUpperCase(),
		options.path,
		String(options.timestampSeconds),
		options.nonce.toString("hex"),
		bodyHash
	].join("\n");
	const signature = createHmac("sha256", signingKey).update(canonical, "utf8").digest("hex");
	return {
		"X-AtomCode-Sig": `v1:${signature}`,
		"X-AtomCode-Ts": String(options.timestampSeconds),
		"X-AtomCode-Nonce": options.nonce.toString("hex"),
		"X-AtomCode-Alg": "1",
		"X-AtomCode-Ver": options.clientVersion
	};
}
/** Fresh 16-byte nonce for one request. */
function newNonce() {
	return randomBytes(16);
}

//#endregion
//#region src/lanes/atomcode.ts
/**
* The AtomCode lane: the AtomGit CodingPlan free lane, driven by the local
* AtomCode CLI login and signed with `atomcode-signing-v1`.
*
* This lane owns its wire rather than borrowing pi-ai, because the signature
* covers the exact request bytes — the payload is built and stringified here,
* signed, then posted through the shared OpenAI SSE reader. Host round-robin
* makes repeated attempts fail over instead of hammering one gateway.
*/
const ATOMCODE_LABEL = "AtomCode";
/** Verified AtomGit gateways, used when config.toml declares no base_url. */
const DEFAULT_HOSTS = ["https://llm-api.atomgit.com/v1", "https://api-ai.gitcode.com/v1"];
const DEFAULT_CONTEXT_WINDOW$2 = 262144;
const DEFAULT_MAX_TOKENS$2 = 8192;
var AtomCodeLane = class {
	id = "atomcode";
	label = ATOMCODE_LABEL;
	#options;
	#cachePath;
	#logger;
	#entries = [];
	#tier = "static";
	#lastError = "";
	#timer;
	#hostCursor = 0;
	constructor(options) {
		this.#options = options;
		this.#cachePath = cacheFile(options.dataDir, "atomcode");
		this.#logger = options.logger;
	}
	models() {
		return this.#entries.map((entry) => entry.id);
	}
	entry(model) {
		return this.#entries.find((entry) => entry.id === model || entry.name === model);
	}
	hosts() {
		const configured = this.#options.hosts.filter((host) => host.length > 0).map((host) => host.replace(/\/+$/, ""));
		if (configured.length > 0) return configured;
		const derived = [...new Set(this.#entries.map((entry) => entry.baseUrl).filter((host) => !!host))];
		return [...new Set([...derived, ...DEFAULT_HOSTS])];
	}
	health() {
		return {
			lane: "atomcode",
			status: this.#lastError && this.#entries.length === 0 ? "degraded" : "ready",
			models: this.#entries.length,
			detail: this.#lastError,
			catalog: this.#tier
		};
	}
	/**
	* This lane's catalog is local (config.toml → cache → static), so priming it
	* is just its refresh; the guard keeps a warmed catalog from being re-read.
	*/
	async prime() {
		if (this.#entries.length === 0) await this.refresh();
	}
	async start() {
		await this.prime();
		this.#report();
		this.#timer = setInterval(() => {
			try {
				this.refresh();
			} catch (err) {
				this.#lastError = err.message;
			}
		}, Math.max(30, this.#options.refreshSeconds) * 1e3);
		this.#timer.unref?.();
	}
	stop() {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = void 0;
		}
	}
	/**
	* Re-read config.toml, fall back to the 7-day disk cache, then the static
	* roster. All local reads, so it is safe to run synchronously at boot and
	* the provider shows up fully populated.
	*/
	async refresh() {
		const configPath = join(atomcodeHome(this.#options.home), "config.toml");
		let toml = "";
		try {
			toml = await readFile(configPath, "utf8");
		} catch (err) {
			this.#lastError = `config.toml unreadable at ${configPath}: ${err.message}`;
		}
		if (toml) {
			const entries = this.#filter(parseAtomGitModels(toml));
			if (entries.length > 0) {
				this.#entries = entries;
				this.#tier = "live";
				this.#lastError = "";
				await writeCache(this.#cachePath, entries, { hosts: this.hosts() });
				return;
			}
		}
		const cached = await readCache(this.#cachePath);
		if (cached && cached.entries.length > 0) {
			this.#entries = this.#filter(cached.entries);
			this.#tier = "cache";
			if (!this.#lastError) this.#lastError = "config.toml had no free-lane models — serving the cached roster";
			return;
		}
		this.#entries = this.#filter(STATIC_ATOMCODE_MODELS);
		this.#tier = "static";
		if (!this.#lastError) this.#lastError = "config.toml had no free-lane models — serving the static roster";
	}
	#report() {
		if (this.#lastError) {
			this.#logger.warn(`free2dsh[atomcode]: catalog ${this.#tier} — ${this.models().join(", ") || "(none)"}; ${this.#lastError}`);
			return;
		}
		this.#logger.info(`free2dsh[atomcode]: catalog ${this.#tier} — ${this.models().join(", ") || "(none)"} via ${this.hosts().join(", ")}`);
	}
	#filter(entries) {
		const allow = this.#options.models.filter((id) => id.length > 0);
		const allowSet = new Set(allow);
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		for (const entry of entries) {
			if (allow.length > 0 && !allowSet.has(entry.id) && !allowSet.has(entry.name ?? "")) continue;
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			out.push(entry);
		}
		return out;
	}
	/**
	* Round-robin across the host list (entry's own base_url first, then the
	* configured/verified gateways) so a repeated attempt fails over instead of
	* hammering one host. Retry policy itself stays the host's job.
	*/
	#pickHost(entry) {
		const configured = this.#options.hosts.filter((host) => host.length > 0);
		const base = entry?.baseUrl?.replace(/\/+$/, "");
		const all = this.hosts();
		const hosts = configured.length > 0 ? configured : base ? [base, ...all.filter((host) => host !== base)] : all;
		const list = hosts.length > 0 ? hosts : [DEFAULT_HOSTS[0]];
		const chosen = list[this.#hostCursor % list.length];
		this.#hostCursor = (this.#hostCursor + 1) % list.length;
		return chosen.replace(/\/+$/, "");
	}
	async *stream(model, options) {
		const entry = this.entry(model);
		const { body } = await buildOpenAIPayload(options, entry);
		const { accessToken, userId } = await getValidAccessToken$1({
			home: this.#options.home,
			allowRefresh: this.#options.allowRefresh,
			cacheDir: join(this.#options.dataDir, "cache")
		});
		const url = `${this.#pickHost(entry)}/chat/completions`;
		const parsed = new URL(url);
		const clientVersion = this.#options.clientVersion.trim() || DEFAULT_CLIENT_VERSION;
		const signed = signAtomCodeRequest({
			method: "POST",
			path: parsed.pathname + parsed.search,
			body,
			accessToken,
			userId,
			clientVersion,
			timestampSeconds: Math.floor(Date.now() / 1e3),
			nonce: newNonce()
		});
		const abort = new AbortController();
		yield* withWatchdogs(openAiStream({
			url,
			headers: {
				authorization: `Bearer ${accessToken}`,
				...signed
			},
			body,
			signal: abort.signal,
			model,
			contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW$2,
			label: this.id,
			onAuthFailure: () => {
				this.#logger.warn("free2dsh[atomcode]: upstream 401/403 — dropping the minted token for the next call");
				dropLiveToken(this.#options.home);
			}
		}), {
			...this.#options.firstEventMs !== void 0 ? { firstEventMs: this.#options.firstEventMs } : {},
			...this.#options.bodyIdleMs !== void 0 ? { bodyIdleMs: this.#options.bodyIdleMs } : {},
			label: this.id,
			model,
			abort,
			...options.signal ? { signal: options.signal } : {}
		});
	}
	/** Startup probe so a missing CLI login surfaces as a warning, not a failure. */
	async probeCredentials() {
		const auth = await readAtomCodeCredentials(this.#options.home);
		const until = auth.expiresAt ? new Date(auth.expiresAt).toISOString() : "unknown expiry";
		this.#logger.info(`free2dsh[atomcode]: AtomCode login found (user ${auth.userId.slice(0, 12)}…), token valid until ${until}`);
	}
	maxTokensFor(model) {
		const declared = this.entry(model)?.maxOutput;
		return typeof declared === "number" && declared > 0 ? Math.min(declared, DEFAULT_MAX_TOKENS$2) : DEFAULT_MAX_TOKENS$2;
	}
	contextWindowFor(model) {
		const declared = this.entry(model)?.contextWindow;
		return typeof declared === "number" && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW$2;
	}
};

//#endregion
//#region src/events.ts
const CONTEXT_WINDOW_EXCEEDED = "CONTEXT_WINDOW_EXCEEDED";
const EMPTY_RESPONSE = "EMPTY_RESPONSE";
function isContextOverflow(message, contextWindow) {
	return message.stopReason === "stop" && message.usage.input > contextWindow;
}
/** mapStopReason (dsh-llm-pi-ai index.js). */
function mapStopReason(message, contextWindow) {
	if (isContextOverflow(message, contextWindow) || message.stopReason === "error" && message.errorMessage !== void 0 && /context/i.test(message.errorMessage) && /exceed|window|length|token/i.test(message.errorMessage)) return {
		kind: "error",
		failure: {
			message: message.errorMessage ?? `free2dsh[cline]: pi-ai detected context overflow for model "${message.model}"`,
			code: CONTEXT_WINDOW_EXCEEDED
		}
	};
	switch (message.stopReason) {
		case "stop":
			if (message.content.length === 0) return {
				kind: "error",
				failure: {
					message: `model "${message.model}" returned a completed response with no content`,
					code: EMPTY_RESPONSE
				}
			};
			return { kind: "stop" };
		case "length": return { kind: "max-tokens" };
		case "toolUse": return { kind: "tool-calls" };
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: message.errorMessage ?? "free2dsh[cline]: stream aborted",
				code: "ABORTED"
			}
		};
		case "error": return {
			kind: "error",
			failure: {
				message: message.errorMessage ?? "free2dsh[cline]: pi-ai stream error",
				code: classifyError(message.errorMessage ?? "")
			}
		};
	}
}
function mapUsage(usage) {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
		...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
	};
}
/**
* Translate one pi-ai event stream into harness chunks. pi-ai never throws
* mid-stream: failures arrive as `error` events and become error/aborted
* finish chunks.
*/
async function* toStreamChunks(events, contextWindow) {
	const toolIds = /* @__PURE__ */ new Map();
	for await (const event of events) switch (event.type) {
		case "start": break;
		case "text_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "text"
			};
			break;
		case "text_delta":
			yield {
				type: "text-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "text_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "text",
					text: event.content
				}
			};
			break;
		case "thinking_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "reasoning"
			};
			break;
		case "thinking_delta":
			yield {
				type: "reasoning-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "thinking_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "reasoning",
					text: event.content
				}
			};
			break;
		case "toolcall_start": {
			const partial = event.partial.content[event.contentIndex];
			const id = partial?.type === "toolCall" ? partial.id ?? "" : "";
			const name$1 = partial?.type === "toolCall" ? partial.name ?? "" : "";
			toolIds.set(event.contentIndex, {
				id,
				name: name$1
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "tool-call"
			};
			break;
		}
		case "toolcall_delta": {
			const known = toolIds.get(event.contentIndex);
			yield {
				type: "tool-call-delta",
				index: event.contentIndex,
				id: known?.id ?? "",
				...known?.name !== void 0 && known.name.length > 0 ? { name: known.name } : {},
				argumentsDelta: event.delta
			};
			break;
		}
		case "toolcall_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "tool-call",
					id: event.toolCall.id,
					name: event.toolCall.name,
					arguments: JSON.stringify(event.toolCall.arguments)
				}
			};
			break;
		case "done":
			yield {
				type: "usage",
				usage: mapUsage(event.message.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.message, contextWindow)
			};
			return;
		case "error":
			yield {
				type: "usage",
				usage: mapUsage(event.error.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.error, contextWindow)
			};
			return;
	}
	throw new Error("free2dsh[cline]: pi-ai event stream ended without done/error");
}

//#endregion
//#region src/ids.ts
/**
* Stable per-conversation identifiers for upstream correlation headers.
*
* Both the Cline and the OpenCode Zen backends are keyed on a session id so
* upstream prompt caching can hit across the growing history of a
* conversation. We derive it the way the real clients do: a SHA-256 over the
* conversation's first user turn (stable across retries of the same turn,
* different across turns), plus a fresh id per request.
*/
/** First user turn keeps a conversation stable across its growing history. */
function conversationSeed(messages) {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const encoded = JSON.stringify(message.content ?? null);
		if (encoded !== "null" && encoded.length > 0) return encoded;
	}
	return randomBytes(16).toString("hex");
}
function firstUserText(messages) {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		if (text.length > 0) return text;
	}
	return "";
}
function hashParts(...parts) {
	const h = createHash("sha256");
	for (const part of parts) {
		h.update(part ?? "\0");
		h.update("");
	}
	return h.digest("hex");
}
/**
* Cline's header set: a 32-hex session id plus a UUID request id.
* Derived from (model, system prompt, first user message) so a retry of the
* same turn reuses the session while the next turn rolls a new one.
*/
function deriveRequestIDs(options) {
	return {
		session: hashParts(options.model, options.system, options.firstMessageText).slice(0, 32),
		request: randomUUID()
	};
}
const ZEN_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
* "ses_" + 12 hex + 14 base62 — the only session shape Zen's anonymous lane
* accepts. Anything else is reshaped deterministically from the seed, so the
* same conversation always lands on the same session id.
*/
function canonicalSessionId(seed) {
	if (ZEN_SESSION_PATTERN.test(seed)) return seed;
	const sum = createHash("sha256").update(`ses\u0000${seed}`).digest();
	const timePart = sum.subarray(0, 6).toString("hex");
	let n = BigInt(`0x${sum.subarray(6, 16).toString("hex")}`);
	const randomPart = [];
	for (let i = 0; i < 14; i += 1) {
		randomPart.unshift(BASE62[Number(n % 62n)]);
		n /= 62n;
	}
	return `ses_${timePart}${randomPart.join("")}`;
}
function deriveZenIds(messages, projectSeed) {
	return {
		session: canonicalSessionId(conversationSeed(messages)),
		request: `req_${randomBytes(16).toString("hex")}`,
		project: `prj_${createHash("sha256").update(`prj\u0000${projectSeed}`).digest().subarray(0, 12).toString("hex")}`
	};
}

//#endregion
//#region src/messages.ts
function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function parseArguments(raw) {
	if (typeof raw !== "string" || raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
	} catch {
		return { raw };
	}
}
/** Harness attachment root (mirrors dsh-attachment-local's resolveDshHome). */
function dshHome() {
	const configured = process.env.DSH_HOME?.trim();
	if (configured) return configured;
	return join(homedir(), ".dsh");
}
async function toPiImage(ref) {
	const attachment = ref ?? {};
	const id = typeof attachment.attachmentId === "string" ? attachment.attachmentId : "";
	const sha = id.startsWith("sha256:") ? id.slice(7) : id;
	if (!/^[0-9a-f]{64}$/.test(sha)) return {
		type: "text",
		text: `[image omitted: unreadable attachment reference ${JSON.stringify(id)}]`
	};
	const path = join(dshHome(), "attachments", "v1", "objects", sha.slice(0, 2), sha);
	try {
		return {
			type: "image",
			data: (await readFile(path)).toString("base64"),
			mimeType: typeof attachment.mediaType === "string" && attachment.mediaType.length > 0 ? attachment.mediaType : "image/png"
		};
	} catch {
		return {
			type: "text",
			text: `[image omitted: failed to read normalized attachment ${JSON.stringify(id)}]`
		};
	}
}
function offloadedImagePart(ref) {
	const id = ref?.attachmentId;
	return {
		type: "text",
		text: `[image omitted: offloaded to fit the request image budget${typeof id === "string" && id.length > 0 ? ` ${id.slice(0, 30)}` : ""}]`
	};
}
async function imagePart(block) {
	return block.offloaded === true ? offloadedImagePart(block.attachment) : toPiImage(block.attachment);
}
async function userParts(blocks) {
	const parts = [];
	for (const block of blocks) if (block.type === "text") {
		if (block.text.length > 0) parts.push({
			type: "text",
			text: block.text
		});
	} else if (block.type === "image") parts.push(await imagePart(block));
	return parts;
}
async function toolResultParts(blocks) {
	const parts = [];
	for (const block of blocks) if (block.type === "text") parts.push({
		type: "text",
		text: block.text
	});
	else if (block.type === "image") parts.push(await imagePart(block));
	else if (block.type === "tool-result") parts.push(...await toolResultParts(block.content));
	return parts;
}
function toPiAssistant(message, providerId) {
	const content = [];
	for (const block of message.content) switch (block.type) {
		case "text":
			content.push({
				type: "text",
				text: block.text
			});
			break;
		case "reasoning":
			content.push({
				type: "thinking",
				thinking: block.text
			});
			break;
		case "tool-call":
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: parseArguments(block.arguments)
			});
			break;
		default: break;
	}
	const source = message.source;
	const model = source?.kind === "model" && typeof source.model === "string" ? source.model : providerId;
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: source?.kind === "model" && typeof source.provider === "string" ? source.provider : providerId,
		model,
		usage: zeroUsage(),
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0
	};
}
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Convert the harness conversation into a pi-ai Context (async: images hit disk). */
async function toPiContext(options) {
	const providerId = options.provider;
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of options.messages) {
		if (message.role === "system") {
			const text = flattenText(message);
			if (text.length > 0) messages.push({
				role: "user",
				content: text,
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toPiAssistant(message, providerId);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
			messages.push(assistant);
			continue;
		}
		const parts = await userParts(message.content);
		const results = message.content.filter((block) => block.type === "tool-result");
		if (parts.length > 0 || results.length === 0) {
			const first = parts[0];
			let content;
			if (parts.length === 0) content = "";
			else if (parts.length === 1 && first?.type === "text") content = first.text;
			else content = parts;
			messages.push({
				role: "user",
				content,
				timestamp: 0
			});
		}
		for (const result of results) {
			let rparts = await toolResultParts(result.content);
			const hasImage = rparts.some((part) => part.type === "image");
			const hasText = rparts.some((part) => part.type === "text" && part.text.length > 0);
			if (!hasImage && !hasText) rparts = [{
				type: "text",
				text: "(no output)"
			}];
			messages.push({
				role: "toolResult",
				toolCallId: result.toolCallId,
				toolName: toolNames.get(result.toolCallId) ?? "unknown",
				content: rparts,
				isError: result.isError ?? false,
				timestamp: 0
			});
		}
	}
	const context = { messages };
	if (typeof options.system === "string" && options.system.length > 0) context.systemPrompt = options.system;
	const tools = options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	if (tools && tools.length > 0) context.tools = tools;
	return context;
}

//#endregion
//#region src/lanes/cline-credentials.ts
var CredentialsError = class extends Error {
	code;
	constructor(message, code) {
		super(message);
		this.name = "CredentialsError";
		this.code = code;
	}
};
/** Env override for the Cline home, mirroring the desktop app's layout. */
function defaultCredentialsPath() {
	const clineHome = process.env.CLINE_HOME?.trim();
	return join(clineHome && clineHome.length > 0 ? clineHome : join(homedir(), ".cline"), "data", "settings", "providers.json");
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Read and validate the Cline provider credentials with actionable errors. */
async function readClineCredentials(path = defaultCredentialsPath()) {
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		const code = err?.code === "ENOENT" ? "CLINE_NOT_INSTALLED" : "CLINE_UNREADABLE";
		throw new CredentialsError(`free2dsh[cline]: cannot read Cline credentials at ${path} (${err.message}). Open the Cline desktop app and log in once, then retry.`, code);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CredentialsError(`free2dsh[cline]: ${path} is not valid JSON (Cline may be mid-write); retry shortly.`, "CLINE_MALFORMED");
	}
	if (!isRecord(parsed) || !isRecord(parsed.providers)) throw new CredentialsError(`free2dsh[cline]: unexpected providers.json shape at ${path}.`, "CLINE_MALFORMED");
	const cline = parsed.providers.cline;
	const settings = isRecord(cline) ? cline.settings : void 0;
	const authBlock = isRecord(settings) ? settings.auth : void 0;
	if (!isRecord(cline) || !isRecord(authBlock)) throw new CredentialsError("free2dsh[cline]: no Cline account session found in providers.json. Open the Cline desktop app, sign in (Cline provider), then retry.", "CLINE_NOT_LOGGED_IN");
	const accessToken = authBlock.accessToken;
	const refreshToken = authBlock.refreshToken;
	const accountId = authBlock.accountId ?? (isRecord(authBlock.metadata) ? authBlock.metadata?.userInfo?.clineUserId : void 0);
	if (typeof accessToken !== "string" || accessToken.length === 0) throw new CredentialsError("free2dsh[cline]: providers.json has no accessToken; log in from the Cline desktop app.", "CLINE_NOT_LOGGED_IN");
	if (typeof accountId !== "string" || accountId.length === 0) throw new CredentialsError("free2dsh[cline]: providers.json has no accountId/clineUserId; log in from the Cline desktop app.", "CLINE_NOT_LOGGED_IN");
	const expiresAtRaw = authBlock.expiresAt;
	const expiresAt = typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw) ? expiresAtRaw : void 0;
	return {
		accessToken,
		accountId,
		...expiresAt !== void 0 ? { expiresAt } : {},
		...typeof refreshToken === "string" && refreshToken.length > 0 ? { refreshToken } : {}
	};
}
/**
* Headers the Cline desktop client itself sends. Two layers matter:
*  - attribution (HTTP-Referer / X-Title) and the account binding
*    (clineUserId), matching the desktop client;
*  - client identity (X-CLIENT-TYPE / X-CLIENT-VERSION / X-PLATFORM) — the
*    `cline-free/*` routing prefix is gated on these ("only available via
*    Cline product surfaces", live-verified: a plain Bearer alone gets 403).
*/
const CLINE_CLIENT_TYPE = process.env.CLINE_CLIENT_TYPE?.trim() || "cline-sdk";
const CLINE_CLIENT_VERSION = process.env.CLINE_CLIENT_VERSION?.trim() || "4.1.22";
function clineRequestHeaders(accountId) {
	return {
		clineUserId: accountId,
		"HTTP-Referer": "https://cline.bot",
		"X-Title": "Cline",
		"X-IS-MULTIROOT": "false",
		"X-CLIENT-TYPE": CLINE_CLIENT_TYPE,
		"X-CLIENT-VERSION": CLINE_CLIENT_VERSION,
		"X-PLATFORM": CLINE_CLIENT_TYPE,
		"X-PLATFORM-VERSION": CLINE_CLIENT_VERSION,
		"User-Agent": `Cline/${CLINE_CLIENT_VERSION}`
	};
}
let cache;
let cachePath = "";
/** mtime cache: avoid re-parsing the file on every request when unchanged. */
async function readClineCredentialsCached(path = defaultCredentialsPath()) {
	if (cache && cachePath === path) try {
		const { mtimeMs } = await stat(path);
		if (mtimeMs === cache.mtimeMs) return cache.creds;
	} catch {}
	const creds = await readClineCredentials(path);
	try {
		const { mtimeMs } = await stat(path);
		cache = {
			mtimeMs,
			creds
		};
		cachePath = path;
	} catch {
		cache = void 0;
	}
	return creds;
}
/**
* Token refresh against the Cline backend (`POST /api/v1/auth/refresh`).
* The backend does NOT rotate the refresh token (the response echoes the same
* one the desktop app keeps reusing), so refreshing here never kicks the
* desktop app out. The minted token lives only in memory — providers.json
* stays the desktop app's property.
*/
async function refreshClineToken(baseURL, creds) {
	if (!creds.refreshToken) throw new CredentialsError("free2dsh[cline]: no refreshToken in providers.json; open the Cline desktop app and log in again.", "CLINE_NO_REFRESH_TOKEN");
	const url = `${baseURL.replace(/\/+$/, "")}/auth/refresh`;
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				...clineRequestHeaders(creds.accountId)
			},
			body: JSON.stringify({
				refreshToken: creds.refreshToken,
				grantType: "refresh_token"
			}),
			signal: AbortSignal.timeout(2e4)
		});
	} catch (err) {
		throw new CredentialsError(`free2dsh[cline]: token refresh request failed: ${err.message}`, "CLINE_REFRESH_TRANSPORT");
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		if (response.status === 401 || response.status === 403) throw new CredentialsError("free2dsh[cline]: token refresh rejected (401/403) — the Cline session was revoked. Open the Cline desktop app and log in again.", "CLINE_REFRESH_REJECTED");
		throw new CredentialsError(`free2dsh[cline]: token refresh -> ${response.status} ${text.slice(0, 160)}`, "CLINE_REFRESH_FAILED");
	}
	const body = await response.json();
	const inner = isRecord(body.data) ? body.data : body;
	const accessToken = typeof inner.accessToken === "string" ? inner.accessToken : void 0;
	if (!accessToken) throw new CredentialsError("free2dsh[cline]: token refresh response had no accessToken.", "CLINE_REFRESH_FAILED");
	const rawExpiry = inner.expiresAt;
	let expiresAt;
	if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry)) expiresAt = rawExpiry < 0xe8d4a51000 ? rawExpiry * 1e3 : rawExpiry;
	else if (typeof rawExpiry === "string" && rawExpiry.length > 0) {
		const parsed = Date.parse(rawExpiry);
		if (Number.isFinite(parsed)) expiresAt = parsed;
	}
	return {
		...creds,
		accessToken,
		...expiresAt !== void 0 ? { expiresAt } : {}
	};
}
const EXPIRY_MARGIN_MS = 6e4;
/** In-memory refreshed tokens, keyed by resolved credentials path. */
const liveTokens = /* @__PURE__ */ new Map();
/** Single-flight refresh per path; concurrent callers share one request. */
const pendingRefreshes = /* @__PURE__ */ new Map();
/**
* Access token for one API call, refreshing proactively when the current token
* is at (or past) its expiry. When refresh fails but a token exists, the stale
* token is returned — the API call it arms may still succeed (clock skew) or
* surface a precise 401 upstream.
*/
async function getValidAccessToken(options) {
	const key = options.credentialsPath || defaultCredentialsPath();
	const creds = await readClineCredentialsCached(key);
	const live = liveTokens.get(key);
	const token = live?.accessToken ?? creds.accessToken;
	const expiresAt = live?.expiresAt ?? creds.expiresAt;
	if (token && (expiresAt === void 0 || Date.now() < expiresAt - EXPIRY_MARGIN_MS)) return {
		accessToken: token,
		accountId: creds.accountId,
		refreshed: false
	};
	let refreshedCreds;
	if (creds.refreshToken) {
		let pending = pendingRefreshes.get(key);
		if (!pending) {
			pending = refreshClineToken(options.baseURL, creds).finally(() => {
				pendingRefreshes.delete(key);
			});
			pendingRefreshes.set(key, pending);
		}
		try {
			refreshedCreds = await pending;
			liveTokens.set(key, refreshedCreds);
		} catch {}
	}
	if (refreshedCreds) return {
		accessToken: refreshedCreds.accessToken,
		accountId: refreshedCreds.accountId,
		refreshed: true
	};
	if (token) return {
		accessToken: token,
		accountId: creds.accountId,
		refreshed: false
	};
	throw new CredentialsError("free2dsh[cline]: no usable Cline token; open the Cline desktop app and log in.", "CLINE_NOT_LOGGED_IN");
}

//#endregion
//#region src/lanes/cline-catalog.ts
/**
* Free-model catalog for the Cline lane.
*
* Cline's "free" is TWO disjoint families:
*   1. Cline's own promo free fleet, served by
*      `GET {baseURL}/ai/cline/recommended-models` in the `free` bucket — ids
*      carry the `cline-free/` routing prefix (plus OpenRouter-style sponsored
*      ids like `stealth/space-bunny-alpha`). The backend gates those on client
*      identity headers, not on the token alone. The `clinePass` bucket of the
*      same endpoint needs a paid subscription (403 ENTITLEMENT_ERROR without
*      one), so it is opt-in.
*   2. OpenRouter-routed free models: `/models` rows whose id carries the
*      `:free` suffix.
*
* Fallback chain: live (recommended-models ∪ :free rows, OpenRouter metadata
* enrichment best-effort) -> 7-day disk cache -> compiled-in static roster.
*/
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/**
* Display-name badge pinned to the Cline free fleet. Some picker surfaces
* re-sort options alphabetically and ignore adapter order; `!` sorts before
* every letter under both code-point and locale collation, so the badge pins
* the fleet to the top in either world. Display-only — the wire id is untouched.
*/
const FLEET_BADGE = "! ";
/** Verified free roster (free bucket ∪ /models `:free`), compiled-in fallback. */
const STATIC_CLINE_MODELS = [
	{
		id: "cline-free/deepseek-v4.1-flash",
		name: FLEET_BADGE + "Deepseek-v4.1-Flash"
	},
	{
		id: "stealth/space-bunny-alpha",
		name: FLEET_BADGE + "Space Bunny Alpha"
	},
	{
		id: "cline-free/mimo-v2.6-flash",
		name: FLEET_BADGE + "Mimo V2.6 Flash"
	},
	{
		id: "cline-free/muse-spark-1.3-contributor",
		name: FLEET_BADGE + "Muse Spark 1.3 Contributor"
	},
	{ id: "apodex/apodex-1.1-mini:free" },
	{ id: "inclusionai/ling-3.0-flash-sante:free" },
	{ id: "qwen/qwen3.8-27b:free" },
	{ id: "dots-studio/dots-3-note-preview:free" },
	{ id: "liquid/lfm-2.5-2.6b:free" },
	{ id: "nvidia/nemotron-3.5-lightning:free" },
	{ id: "thinkingmachines/inkling-small:free" },
	{ id: "poolside/laguna-s-2.1:free" },
	{ id: "thinkingmachines/inkling:free" },
	{ id: "poolside/laguna-xs-2.1:free" },
	{ id: "cohere/north-mini-code:free" },
	{ id: "nvidia/nemotron-3.5-content-safety:free" },
	{ id: "nvidia/nemotron-3-ultra-550b-a55b:free" },
	{ id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" },
	{ id: "google/gemma-4-26b-a4b-it:free" },
	{ id: "google/gemma-4-31b-it:free" },
	{ id: "nvidia/nemotron-3-super-120b-a12b:free" }
];
function isFreeModel(id) {
	return id.endsWith(":free");
}
/** "cline-pass/glm-5.3" -> "Glm 5.3"; bucket names are often raw ids. */
function prettifyBucketName(raw, id) {
	if (typeof raw === "string" && raw.length > 0 && !raw.includes("/") && !/^[a-z0-9.-]+$/.test(raw)) return raw;
	return ((raw ?? id).split("/").at(-1) ?? id).replace(/[:].*$/, "").split("-").filter((part) => part.length > 0).map((part) => part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function fleetDisplayName(raw, id) {
	return FLEET_BADGE + prettifyBucketName(raw, id);
}
var ClineCatalog = class {
	#options;
	#entries = /* @__PURE__ */ new Map();
	#ordered = [];
	#tier = "pending";
	#lastError = "";
	#counts = {
		freeBucket: 0,
		clinePass: 0,
		openrouterFree: 0
	};
	#refreshing;
	constructor(options) {
		this.#options = {
			baseURL: options.baseURL.replace(/\/+$/, ""),
			credentialsPath: options.credentialsPath,
			cachePath: options.cachePath,
			freeOnly: options.freeOnly,
			includeClinePass: options.includeClinePass,
			fetchImpl: options.fetchImpl ?? fetch
		};
	}
	list() {
		if (this.#entries.size > 0) return [...this.#ordered];
		return STATIC_CLINE_MODELS.map((model) => model.id);
	}
	entry(model) {
		return this.#entries.get(model);
	}
	tier() {
		return this.#tier;
	}
	lastError() {
		return this.#lastError;
	}
	snapshot() {
		return {
			tier: this.#tier,
			total: this.#entries.size,
			...this.#counts,
			lastError: this.#lastError
		};
	}
	/** Tier 2: initial disk-cache read. Never throws. Returns a startup note. */
	async prime() {
		if (this.#tier === "live" || this.#entries.size > 0) return `already ${this.#tier} (${this.#entries.size} models)`;
		const cached = await readCache(this.#options.cachePath);
		if (cached && cached.entries.length > 0) {
			this.#ingest(cached.entries, "cache");
			return `cache (${cached.entries.length} models)`;
		}
		this.#ingest(STATIC_CLINE_MODELS, "static");
		return `static roster (${STATIC_CLINE_MODELS.length} models)`;
	}
	async refresh() {
		if (this.#refreshing) return this.#refreshing;
		this.#refreshing = this.#refreshOnce().finally(() => {
			this.#refreshing = void 0;
		});
		return this.#refreshing;
	}
	async #refreshOnce() {
		try {
			const [buckets, orFree] = await Promise.all([this.#fetchFreeBuckets(), this.#fetchOpenRouterFree()]);
			const entries = /* @__PURE__ */ new Map();
			for (const entry of buckets.values()) entries.set(entry.id, entry);
			for (const entry of orFree) if (!entries.has(entry.id)) entries.set(entry.id, entry);
			if (entries.size === 0) throw new Error("both free sources came back empty");
			this.#ingest([...entries.values()], "live");
			await writeCache(this.#options.cachePath, [...entries.values()], { ...this.#counts });
			this.#lastError = "";
		} catch (err) {
			this.#lastError = err instanceof Error ? err.message : String(err);
			if (this.#entries.size === 0) this.#ingest(STATIC_CLINE_MODELS, "static");
		}
	}
	/** Cline's own free fleet (the `free` bucket; `clinePass` is opt-in). */
	async #fetchFreeBuckets() {
		const { accessToken, accountId } = await getValidAccessToken({
			baseURL: this.#options.baseURL,
			credentialsPath: this.#options.credentialsPath
		});
		const url = `${this.#options.baseURL}/ai/cline/recommended-models`;
		const response = await this.#options.fetchImpl(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				...clineRequestHeaders(accountId)
			},
			signal: AbortSignal.timeout(15e3)
		});
		if (!response.ok) throw new Error(`GET recommended-models -> ${response.status}`);
		const body = await response.json();
		const entries = /* @__PURE__ */ new Map();
		const take = (rows, tag) => {
			let n = 0;
			for (const row of rows ?? []) {
				if (typeof row?.id !== "string" || row.id.length === 0) continue;
				n += 1;
				if (tag === "clinePass" && !this.#options.includeClinePass) continue;
				if (entries.has(row.id)) continue;
				entries.set(row.id, {
					id: row.id,
					name: fleetDisplayName(row.name, row.id)
				});
			}
			return n;
		};
		this.#counts.freeBucket = take(body.free, "free");
		this.#counts.clinePass = take(body.clinePass, "clinePass");
		return entries;
	}
	/** OpenRouter-routed free models: `:free` suffix rows of GET /models. */
	async #fetchOpenRouterFree() {
		const { accessToken, accountId } = await getValidAccessToken({
			baseURL: this.#options.baseURL,
			credentialsPath: this.#options.credentialsPath
		});
		const url = `${this.#options.baseURL}/models`;
		const response = await this.#options.fetchImpl(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...clineRequestHeaders(accountId)
			},
			signal: AbortSignal.timeout(15e3)
		});
		if (!response.ok) throw new Error(`GET /models -> ${response.status}`);
		const body = await response.json();
		const rows = body.data ?? body.models ?? [];
		const ids = [];
		for (const row of rows) {
			if (typeof row?.id !== "string" || row.id.length === 0) continue;
			if (this.#options.freeOnly && !isFreeModel(row.id)) continue;
			if (!ids.includes(row.id)) ids.push(row.id);
		}
		this.#counts.openrouterFree = ids.length;
		if (ids.length === 0) return [];
		const enriched = await this.#enrich(ids).catch(() => void 0);
		return ids.map((id) => ({ ...enriched?.get(id) ?? { id } }));
	}
	/**
	* Best-effort OpenRouter metadata: display name, context window, max output,
	* image input. Cline's OpenRouter ids are verbatim OpenRouter ids, so the
	* join is exact; any failure only costs the enrichment.
	*/
	async #enrich(ids) {
		const wanted = new Set(ids);
		const response = await this.#options.fetchImpl(OPENROUTER_MODELS_URL, {
			method: "GET",
			signal: AbortSignal.timeout(1e4)
		});
		if (!response.ok) throw new Error(`openrouter metadata -> ${response.status}`);
		const body = await response.json();
		const map = /* @__PURE__ */ new Map();
		for (const row of body.data ?? []) {
			if (typeof row?.id !== "string" || !wanted.has(row.id)) continue;
			const entry = { id: row.id };
			if (typeof row.name === "string" && row.name.length > 0) entry.name = row.name;
			if (typeof row.context_length === "number" && row.context_length > 0) entry.contextWindow = row.context_length;
			if (typeof row.top_provider?.max_completion_tokens === "number" && row.top_provider.max_completion_tokens > 0) entry.maxOutput = row.top_provider.max_completion_tokens;
			const inputs = row.architecture?.input_modalities;
			if (Array.isArray(inputs) && inputs.length > 0) entry.imageInput = inputs.includes("image");
			map.set(row.id, entry);
		}
		return map;
	}
	/** Picker order: Cline's own free fleet first, then by display name. */
	#compare(a, b) {
		const pinned = (model) => model.name?.startsWith(FLEET_BADGE) ? 0 : 1;
		const byPinned = pinned(a) - pinned(b);
		if (byPinned !== 0) return byPinned;
		const an = (a.name ?? a.id).toLowerCase();
		const bn = (b.name ?? b.id).toLowerCase();
		if (an !== bn) return an < bn ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	}
	#ingest(entries, tier) {
		const next = /* @__PURE__ */ new Map();
		for (const entry of entries) if (typeof entry?.id === "string" && entry.id.length > 0) next.set(entry.id, entry);
		if (next.size === 0) return;
		this.#entries = next;
		this.#ordered = [...next.values()].sort((a, b) => this.#compare(a, b)).map((entry) => entry.id);
		this.#tier = tier;
	}
};
/** Cache path for the Cline lane under the plugin data dir. */
function clineCachePath(dataDir) {
	return cacheFile(dataDir, "cline");
}

//#endregion
//#region src/lanes/cline.ts
/**
* The Cline lane: streams from Cline's OpenAI-compatible backend
* (api.cline.bot/api/v1) with the locally logged-in Cline desktop account's
* OAuth token, free models only.
*
* Unlike the AtomCode and OpenCode lanes, this one borrows its wire from
* pi-ai's openai-completions — the same implementation DSH uses for every
* OpenAI-compatible provider — and only adds credential injection, Cline's
* attribution/identity headers and the free-model catalog. pi-ai is loaded
* lazily so a broken or missing optional dependency degrades this one lane
* instead of taking the whole plugin down.
*/
const CLINE_LABEL = "Cline";
const DEFAULT_CONTEXT_WINDOW$1 = 262144;
const DEFAULT_MAX_TOKENS$1 = 32768;
let piPromise;
/** Load pi-ai once; undefined when it cannot be resolved. */
async function loadPi() {
	if (!piPromise) piPromise = (async () => {
		try {
			const pi = await import("@earendil-works/pi-ai");
			const openai = await import("@earendil-works/pi-ai/api/openai-completions");
			return {
				createProvider: pi.createProvider,
				api: openai
			};
		} catch {
			return;
		}
	})();
	return piPromise;
}
function contextWindowFor(model) {
	const declared = model?.contextWindow;
	return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW$1;
}
function maxTokensFor(model) {
	const declared = model?.maxOutput;
	return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_MAX_TOKENS$1;
}
var ClineLane = class {
	id = "cline";
	label = CLINE_LABEL;
	#catalog;
	#baseURL;
	#credentialsPath;
	#firstEventMs;
	#bodyIdleMs;
	#logger;
	#refreshSeconds;
	#timer;
	#provider;
	constructor(options) {
		this.#baseURL = options.baseURL.replace(/\/+$/, "");
		this.#credentialsPath = options.credentialsPath;
		this.#firstEventMs = options.firstEventMs;
		this.#bodyIdleMs = options.bodyIdleMs;
		this.#logger = options.logger;
		this.#refreshSeconds = options.refreshSeconds;
		this.#catalog = new ClineCatalog(options);
	}
	models() {
		return this.#catalog.list();
	}
	entry(model) {
		return this.#catalog.entry(model);
	}
	health() {
		const snapshot = this.#catalog.snapshot();
		return {
			lane: "cline",
			status: snapshot.lastError && snapshot.total === 0 ? "degraded" : snapshot.tier === "pending" ? "warming" : "ready",
			models: snapshot.total > 0 ? snapshot.total : this.#catalog.list().length,
			detail: snapshot.lastError,
			catalog: snapshot.tier
		};
	}
	/** Tier 2: seed from the disk cache so the lane is populated before the network. */
	async prime() {
		await this.#catalog.prime();
	}
	async start() {
		const note = await this.#catalog.prime();
		this.#logger.info(`free2dsh[cline]: catalog ${this.#catalog.tier()} (${note})`);
		await this.#catalog.refresh();
		this.#report();
		this.#timer = setInterval(() => {
			this.#catalog.refresh().then(() => this.#report());
		}, this.#refreshSeconds * 1e3);
		this.#timer.unref?.();
	}
	stop() {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = void 0;
		}
	}
	#report() {
		const snapshot = this.#catalog.snapshot();
		if (snapshot.lastError) {
			this.#logger.warn(`free2dsh[cline]: catalog issue (${snapshot.tier}): ${snapshot.lastError}`);
			return;
		}
		this.#logger.info(`free2dsh[cline]: catalog ${snapshot.tier} — ${snapshot.total} free models (free-bucket ${snapshot.freeBucket}, cline-pass ${snapshot.clinePass}, :free ${snapshot.openrouterFree})`);
	}
	/** Build (once) the pi-ai provider bound to this lane's base + credentials. */
	#piProvider() {
		if (!this.#provider) this.#provider = (async () => {
			const pi = await loadPi();
			if (!pi) return void 0;
			const credentialsPath = this.#credentialsPath;
			return pi.createProvider({
				id: "free2dsh-cline",
				name: CLINE_LABEL,
				baseUrl: this.#baseURL,
				auth: { apiKey: {
					name: "Cline account token",
					resolve: async () => {
						return { auth: { apiKey: (await getValidAccessToken({
							baseURL: this.#baseURL,
							credentialsPath
						})).accessToken } };
					}
				} },
				models: [],
				api: pi.api
			});
		})();
		return this.#provider;
	}
	async *stream(model, options) {
		const provider = await this.#piProvider();
		if (!provider) throw new Error("pi-ai is unavailable — install @earendil-works/pi-ai or disable the cline lane");
		const entry = this.entry(model);
		const context = await toPiContext(options);
		const ids = deriveRequestIDs({
			model,
			system: typeof options.system === "string" ? options.system : void 0,
			firstMessageText: firstUserText(options.messages)
		});
		const piModel = {
			id: model,
			name: entry?.name ?? model,
			api: "openai-completions",
			provider: "free2dsh-cline",
			baseUrl: this.#baseURL,
			reasoning: entry?.reasoning === true,
			input: entry?.imageInput ? ["text", "image"] : ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0
			},
			contextWindow: contextWindowFor(entry),
			maxTokens: maxTokensFor(entry)
		};
		const { accessToken, accountId } = await getValidAccessToken({
			baseURL: this.#baseURL,
			credentialsPath: this.#credentialsPath
		});
		const abort = new AbortController();
		yield* withWatchdogs(toStreamChunks(provider.streamSimple(piModel, context, {
			apiKey: accessToken,
			sessionId: ids.session,
			headers: clineRequestHeaders(accountId),
			signal: abort.signal,
			maxRetries: 0,
			temperature: options.temperature,
			maxTokens: options.maxTokens
		}), piModel.contextWindow), {
			...this.#firstEventMs !== void 0 ? { firstEventMs: this.#firstEventMs } : {},
			...this.#bodyIdleMs !== void 0 ? { bodyIdleMs: this.#bodyIdleMs } : {},
			label: this.id,
			model,
			abort,
			...options.signal ? { signal: options.signal } : {}
		});
	}
};

//#endregion
//#region src/lanes/opencode.ts
/**
* The OpenCode Zen lane: the anonymous free lane OpenCode's own CLI uses
* without an account.
*
* No credential to manage — the key is the literal string `public` — but the
* lane does have to look like the CLI: a matching user agent, Zen's canonical
* session/project ids derived per conversation, and (since 2026-09-16) a body
* shape that streams and carries the reserved `bash`/`read` function tools.
* Those gate tools are injected only when the caller does not already have a
* tool of the same name, and calls to them flow back to the harness like any
* real tool call — stripping them again strands a `tool-calls` finish with no
* tool for the harness to run, which silently ends the turn mid-task (the
* reference opencode2dsh plugin never filters the response either).
*/
const OPENCODE_LABEL = "OpenCode Zen";
const MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_CONTEXT_WINDOW = 2e5;
const DEFAULT_MAX_TOKENS = 32e3;
/**
* Ids that look free but do NOT work on the anonymous chat-completions lane:
*  - deepseek-v4-flash-free: HTTP 400 "Model is unavailable" — free only for
*    authenticated Zen accounts, models.dev still marks it cost 0.
*  - jev-1.13-free: HTTP 500 — rides the SystemOne endpoint, not chat
*    completions.
*/
const UNUSABLE_IDS = new Set(["deepseek-v4-flash-free", "jev-1.13-free"]);
/** `muse-spark-*` is Responses-API-only upstream, so it is off this wire. */
const RESPONSES_ONLY_PREFIX = "muse-spark-";
/** Verified against the anonymous lane with real chats. */
const STATIC_OPENCODE_MODELS = [
	{
		id: "big-pickle",
		name: "Big Pickle",
		reasoning: true
	},
	{
		id: "mimo-v2.5-free",
		name: "MiMo V2.5 Free",
		reasoning: true
	},
	{
		id: "mimo-v2.6-flash-free",
		name: "MiMo V2.6 Flash Free",
		contextWindow: 2e5,
		maxOutput: 32e3,
		reasoning: true,
		imageInput: true
	},
	{
		id: "ling-3.0-flash-fin-free",
		name: "Ling 3.0 Flash Fin Free",
		contextWindow: 262144,
		maxOutput: 32768,
		reasoning: true
	},
	{
		id: "ling-3.1-flash-free",
		name: "Ling 3.1 Flash Free",
		contextWindow: 262144,
		maxOutput: 32768,
		reasoning: true
	},
	{
		id: "fledge-alpha-free",
		name: "Fledge Alpha Free",
		contextWindow: 1e6,
		reasoning: true
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning Free",
		reasoning: true
	},
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra Free",
		reasoning: true
	}
];
const STATIC_VERIFIED_IDS = new Set(STATIC_OPENCODE_MODELS.map((model) => model.id));
/** The reserved tools the free lane gates on. Definitions are not inspected. */
const FREE_LANE_GATE_TOOLS = ["bash", "read"];
function zenUserAgent() {
	return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`;
}
function zenHeaders(ids, apiKey = "public") {
	return {
		authorization: `Bearer ${apiKey}`,
		"user-agent": zenUserAgent(),
		"x-opencode-client": "cli",
		"x-opencode-session": ids.session,
		"x-session-affinity": ids.session,
		"X-Session-Id": ids.session,
		"x-opencode-request": ids.request,
		"x-opencode-project": ids.project
	};
}
function gateTool(name$1) {
	return {
		type: "function",
		function: {
			name: name$1,
			description: "Reserved for the host runtime; do not call it.",
			parameters: {
				type: "object",
				properties: {}
			}
		}
	};
}
/**
* Rewrite the chat body so it passes the free-lane gate: force streaming and
* append the reserved bash/read tools, pinning tool_choice=none when the
* caller sent no tools of its own. Calls to an injected gate tool flow back to
* the harness like any tool call — the harness owns what happens with them.
*/
function applyFreeLaneShape(payload) {
	const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
	const names = new Set(tools.map((tool) => {
		if (typeof tool !== "object" || tool === null) return void 0;
		const fn = tool.function;
		return typeof fn?.name === "string" ? fn.name : void 0;
	}));
	const missing = FREE_LANE_GATE_TOOLS.filter((name$1) => !names.has(name$1));
	const next = {
		...payload,
		stream: true
	};
	if (missing.length > 0) {
		next.tools = [...tools, ...missing.map(gateTool)];
		if (tools.length === 0 && payload.tool_choice === void 0) next.tool_choice = "none";
	}
	if (next.stream_options === void 0) next.stream_options = { include_usage: true };
	return {
		payload: next,
		injected: missing.length > 0
	};
}
function isResponsesOnly(id) {
	return id.startsWith(RESPONSES_ONLY_PREFIX);
}
/** Free verdict for the ANONYMOUS lane. */
function freeVerdict(id, entry) {
	if (UNUSABLE_IDS.has(id) || entry?.deprecated) return false;
	if (STATIC_VERIFIED_IDS.has(id)) return true;
	if (id.toLowerCase().includes("free")) return true;
	const cost = entry?.cost;
	return cost !== void 0 && cost.input === 0 && cost.output === 0;
}
async function fetchModelsDev(fetchImpl) {
	const res = await fetchImpl(MODELS_DEV_URL, {
		signal: AbortSignal.timeout(2e4),
		headers: { accept: "application/json" }
	});
	if (!res.ok) throw new Error(`models.dev -> ${res.status}`);
	return (await res.json()).opencode?.models ?? {};
}
var OpenCodeLane = class {
	id = "opencode";
	label = OPENCODE_LABEL;
	#options;
	#fetch;
	#cachePath;
	#logger;
	#projectSeed = "free2dsh:default-project";
	#entries = [];
	#tier = "static";
	#lastError = "";
	#timer;
	#devCache;
	constructor(options) {
		this.#options = options;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#cachePath = cacheFile(options.dataDir, "opencode");
		this.#logger = options.logger;
	}
	models() {
		return this.#entries.map((entry) => entry.id);
	}
	entry(model) {
		return this.#entries.find((entry) => entry.id === model);
	}
	health() {
		return {
			lane: "opencode",
			status: this.#lastError && this.#entries.length === 0 ? "degraded" : "ready",
			models: this.#entries.length,
			detail: this.#lastError,
			catalog: this.#tier
		};
	}
	/**
	* Seed from the 7-day disk cache, then the hand-verified roster. This lane is
	* the only one whose catalog is not local — Cline primes from disk and
	* AtomCode reads config.toml — so without a primed start it is the one lane
	* that stays invisible until the network answers. Never throws.
	*/
	async prime() {
		if (this.#entries.length > 0) return;
		const cached = await readCache(this.#cachePath);
		if (cached && cached.entries.length > 0) {
			this.#entries = cached.entries;
			this.#tier = "cache";
			return;
		}
		this.#entries = [...STATIC_OPENCODE_MODELS];
		this.#tier = "static";
	}
	async start() {
		await this.prime();
		this.#logger.info(`free2dsh[opencode]: primed from ${this.#tier} — ${this.#entries.length} model(s)`);
		await this.refresh();
		if (this.#lastError) this.#logger.warn(`free2dsh[opencode]: ${this.#lastError}`);
		else this.#logger.info(`free2dsh[opencode]: catalog ${this.#tier} — ${this.models().join(", ") || "(none)"}`);
		this.#timer = setInterval(() => {
			this.refresh();
		}, Math.max(30, this.#options.refreshSeconds) * 1e3);
		this.#timer.unref?.();
	}
	stop() {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = void 0;
		}
	}
	/**
	* Live `GET /v1/models` ∩ free verdict, models.dev metadata enrichment
	* best-effort; 7-day disk cache next; verified static roster last.
	*
	* The live list is published the moment it arrives, using the verdicts that
	* need no metadata at all (hand-verified ids, and ids whose name says
	* "free"). models.dev is a multi-megabyte download that only *adds* metadata
	* and rescues zero-cost ids whose name does not say free, so gating the
	* catalog on it would leave this lane empty for as long as that download
	* takes — long enough for a host that snapshots the catalog at boot to show
	* the lane (and its route) as empty.
	*/
	async refresh() {
		let published = false;
		try {
			const liveList = await this.#fetchLiveList();
			this.#publish(this.#build(liveList, void 0));
			published = this.#tier === "live";
			const devModels = await this.#loadModelsDev().catch(() => ({}));
			const entries = this.#build(liveList, devModels);
			if (entries.length === 0) throw new Error("live list empty after the free filter");
			this.#entries = entries;
			this.#tier = "live";
			this.#lastError = "";
			await writeCache(this.#cachePath, entries);
		} catch (err) {
			this.#lastError = `live catalog unavailable: ${err.message}`;
			if (published) return;
			const cached = await readCache(this.#cachePath);
			if (cached && cached.entries.length > 0) {
				this.#entries = cached.entries;
				this.#tier = "cache";
				return;
			}
			this.#entries = [...STATIC_OPENCODE_MODELS];
			this.#tier = "static";
		}
	}
	/** Adopt a non-empty live list, leaving a primed catalog in place otherwise. */
	#publish(entries) {
		if (entries.length === 0) return;
		this.#entries = entries;
		this.#tier = "live";
		this.#lastError = "";
	}
	/**
	* Free-filter one live list. `dev` may be absent: metadata is optional, and
	* whatever the primed catalog already knew about an id is carried over so
	* publishing early never regresses a display name or a context window.
	*/
	#build(liveList, dev) {
		const known = new Map(this.#entries.map((entry) => [entry.id, entry]));
		const entries = [];
		for (const id of liveList) {
			if (isResponsesOnly(id) && !this.#options.includeResponsesOnly) continue;
			const meta = dev?.[id];
			if (!freeVerdict(id, meta)) continue;
			entries.push(mergeModel(this.#toModel(id, meta), known.get(id)));
		}
		return entries;
	}
	#toModel(id, entry) {
		const model = { id };
		if (entry?.name) model.name = entry.name;
		if (entry?.limit?.context) model.contextWindow = entry.limit.context;
		if (entry?.limit?.output) model.maxOutput = entry.limit.output;
		if (entry?.modalities?.input?.includes("image")) model.imageInput = true;
		if (entry?.reasoning) model.reasoning = true;
		return model;
	}
	/** models.dev metadata with a 7-day memory cache. */
	async #loadModelsDev() {
		if (this.#devCache && Date.now() - this.#devCache.at < 10080 * 60 * 1e3) return this.#devCache.value;
		const value = await fetchModelsDev(this.#fetch);
		this.#devCache = {
			at: Date.now(),
			value
		};
		return value;
	}
	async #fetchLiveList() {
		const ids = deriveZenIds([{
			role: "user",
			content: "catalog"
		}], this.#projectSeed);
		const res = await this.#fetch(`${this.#options.baseURL.replace(/\/+$/, "")}/v1/models`, {
			headers: { ...zenHeaders(ids) },
			signal: AbortSignal.timeout(2e4)
		});
		if (!res.ok) throw new Error(`GET /v1/models -> ${res.status}`);
		const body = await res.json();
		const out = [];
		for (const row of body.data ?? []) if (typeof row.id === "string" && row.id && !out.includes(row.id)) out.push(row.id);
		if (out.length === 0) throw new Error("GET /v1/models returned an empty list");
		return out;
	}
	async *stream(model, options) {
		const entry = this.entry(model);
		const shapedHolder = await buildOpenAIPayload(options, entry, (payload) => applyFreeLaneShape(payload).payload);
		const ids = deriveZenIds(shapedHolder.payload.messages, this.#projectSeed);
		const abort = new AbortController();
		yield* withWatchdogs(openAiStream({
			url: `${this.#options.baseURL.replace(/\/+$/, "")}/v1/chat/completions`,
			headers: zenHeaders(ids),
			body: shapedHolder.body,
			signal: abort.signal,
			model,
			contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			label: this.id
		}), {
			...this.#options.firstEventMs !== void 0 ? { firstEventMs: this.#options.firstEventMs } : {},
			...this.#options.bodyIdleMs !== void 0 ? { bodyIdleMs: this.#options.bodyIdleMs } : {},
			label: this.id,
			model,
			abort,
			...options.signal ? { signal: options.signal } : {}
		});
	}
	contextWindowFor(model) {
		const declared = this.entry(model)?.contextWindow;
		return typeof declared === "number" && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW;
	}
	maxTokensFor(model) {
		const declared = this.entry(model)?.maxOutput;
		return typeof declared === "number" && declared > 0 ? declared : DEFAULT_MAX_TOKENS;
	}
};
/**
* Overlay a freshly built model on the entry we already had for that id, so the
* fields the live list or models.dev left out keep their primed values.
*/
function mergeModel(fresh, known) {
	if (!known) return fresh;
	const levels = fresh.reasoningLevels ?? known.reasoningLevels;
	return {
		id: fresh.id,
		...(fresh.name ?? known.name) !== void 0 ? { name: fresh.name ?? known.name } : {},
		...(fresh.contextWindow ?? known.contextWindow) !== void 0 ? { contextWindow: fresh.contextWindow ?? known.contextWindow } : {},
		...(fresh.maxOutput ?? known.maxOutput) !== void 0 ? { maxOutput: fresh.maxOutput ?? known.maxOutput } : {},
		...(fresh.imageInput ?? known.imageInput) !== void 0 ? { imageInput: fresh.imageInput ?? known.imageInput } : {},
		...(fresh.reasoning ?? known.reasoning) !== void 0 ? { reasoning: fresh.reasoning ?? known.reasoning } : {},
		...levels !== void 0 ? { reasoningLevels: levels } : {}
	};
}

//#endregion
//#region src/index.ts
function registrationHandle(value) {
	if (typeof value !== "object" || value === null) return void 0;
	return typeof value.replace === "function" ? value : void 0;
}
const name = "free2dsh";
/** Bumped per release; logged at registration so the live code is identifiable. */
const PLUGIN_VERSION = "0.1.1";
/** Only `llm` gates this fiber: the adapter needs nothing else. */
const inject = ["llm"];
/** Build the enabled lanes, in picker order, from resolved config. */
function buildLanes(config, logger, dataDir) {
	const lanes = [];
	const wanted = new Set(config.lanes);
	if (wanted.has("cline")) lanes.push(new ClineLane({
		baseURL: config.clineBaseURL,
		credentialsPath: config.clineCredentialsPath || defaultCredentialsPath(),
		cachePath: clineCachePath(dataDir),
		freeOnly: config.clineFreeOnly,
		includeClinePass: config.clineIncludePass,
		refreshSeconds: config.refreshSeconds,
		...config.firstEventMs !== void 0 ? { firstEventMs: config.firstEventMs } : {},
		...config.bodyIdleMs !== void 0 ? { bodyIdleMs: config.bodyIdleMs } : {},
		logger
	}));
	if (wanted.has("atomcode")) lanes.push(new AtomCodeLane({
		home: config.atomcodeHome,
		models: config.atomcodeModels,
		hosts: config.atomcodeHosts,
		clientVersion: config.atomcodeClientVersion,
		allowRefresh: config.atomcodeAllowRefresh,
		refreshSeconds: config.refreshSeconds,
		dataDir,
		...config.firstEventMs !== void 0 ? { firstEventMs: config.firstEventMs } : {},
		...config.bodyIdleMs !== void 0 ? { bodyIdleMs: config.bodyIdleMs } : {},
		logger
	}));
	if (wanted.has("opencode")) lanes.push(new OpenCodeLane({
		baseURL: config.opencodeBaseURL,
		includeResponsesOnly: config.opencodeIncludeResponsesOnly,
		refreshSeconds: config.refreshSeconds,
		dataDir,
		...config.firstEventMs !== void 0 ? { firstEventMs: config.firstEventMs } : {},
		...config.bodyIdleMs !== void 0 ? { bodyIdleMs: config.bodyIdleMs } : {},
		logger
	}));
	return lanes;
}
function apply(ctx, config = {}) {
	const logger = ctx.logger;
	const resolved = resolveConfig(config);
	if (!ctx.llm || typeof ctx.llm.registerAdapter !== "function") {
		logger.error("free2dsh: llm service unavailable; adapter cannot register");
		return;
	}
	if (resolved.lanes.length === 0) {
		logger.error("free2dsh: no enabled lanes (check the `lanes` config); nothing to register");
		return;
	}
	const lanes = buildLanes(resolved, logger, resolved.dataDir.trim().length > 0 ? resolved.dataDir : defaultDataDir());
	const catalog = new UnifiedCatalog(lanes, resolved.providerId);
	const adapter = new Free2dshAdapter({
		catalog,
		...resolved.firstEventMs !== void 0 ? { firstEventMs: resolved.firstEventMs } : {},
		...resolved.bodyIdleMs !== void 0 ? { bodyIdleMs: resolved.bodyIdleMs } : {}
	});
	const laneRoutes = lanes.map((lane) => `${resolved.providerId}-${lane.id}`);
	const routes = resolved.mergedRoute ? [resolved.providerId, ...laneRoutes] : laneRoutes;
	const registration = registrationHandle(ctx.llm.registerAdapter(routes, adapter));
	logger.info(`free2dsh v${PLUGIN_VERSION}: adapter registered for ${routes.map((route) => `"${route}"`).join(", ")} — ${catalog.summary()}`);
	/**
	* Re-announce the route set so the host republishes `llm/adapters-updated`.
	*
	* Every catalog is warmed in the background, so at registration time no lane
	* has a model yet: a picker that reads the catalogue then would show the
	* plugin with empty groups, and — because that event is the only thing the
	* picker re-reads on — it would keep showing them until the user touched
	* settings or reconnected. Re-announcing as each lane becomes ready is what
	* makes models that arrive after activation visible.
	*/
	const announce = () => {
		try {
			registration?.replace?.(routes);
		} catch (err) {
			logger.warn(`free2dsh: route re-announce failed: ${err.message} (models still served)`);
		}
	};
	for (const lane of lanes) (async () => {
		await lane.prime?.();
		announce();
		await lane.start();
		announce();
		logger.info(`free2dsh: ${lane.label} ready — ${lane.health().models} model(s), catalog ${lane.health().catalog}`);
	})().catch((err) => {
		logger.warn(`free2dsh: ${lane.label} warm-up failed: ${err.message} (other lanes unaffected)`);
	});
	const maybeEffect = ctx.effect;
	if (typeof maybeEffect === "function") maybeEffect.call(ctx, () => () => {
		for (const lane of lanes) lane.stop();
	});
}

//#endregion
export { AtomCodeLane, ClineLane, Config, Free2dshAdapter, LANE_IDS, OpenCodeLane, PLUGIN_VERSION, UnifiedCatalog, apply, buildLanes, defaultDataDir, inject, name, resolveConfig };
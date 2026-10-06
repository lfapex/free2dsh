import type { Lane, LaneHealth, LaneId, LaneModel } from './types.ts'

/**
 * The unified catalog: every lane's models behind one provider column.
 *
 * Ids are namespaced as `<lane>/<bare>` on the merged route so Cline's
 * `cline-free/deepseek-v4.1-flash` and AtomCode's `qwen3.8-27b` cannot
 * collide. Each lane also gets its own filter route (`free2dsh-cline`, …)
 * where ids stay bare, which is handy when you only want to see one platform.
 */

export const LANE_SEPARATOR = '/'

export interface UnifiedModel {
  /** Id as the picker sees it: `<lane>/<bare>` on the merged route, `<bare>` on a lane route. */
  id: string
  /** Bare upstream id — what goes on the wire. */
  bare: string
  lane: LaneId
  /** Lane badge appended to the display name. */
  label: string
  name: string
  contextWindow: number
  maxTokens: number
  inputModalities: Array<'text' | 'image'>
}

export interface ResolvedModel {
  lane: Lane
  model: LaneModel
  bare: string
}

const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 8_192

function contextWindowFor(model: LaneModel | undefined): number {
  const declared = model?.contextWindow
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW
}

function maxTokensFor(model: LaneModel | undefined): number {
  const declared = model?.maxOutput
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_MAX_TOKENS
}

export class UnifiedCatalog {
  readonly #lanes: Lane[]
  readonly #mergedRoute: string

  constructor(lanes: Lane[], mergedRoute: string) {
    this.#lanes = lanes
    this.#mergedRoute = mergedRoute
  }

  lanes(): Lane[] {
    return [...this.#lanes]
  }

  /** Lane ids in picker order. */
  laneIds(): LaneId[] {
    return this.#lanes.map((lane) => lane.id)
  }

  /** Provider route for a lane id (`free2dsh-cline`), or undefined. */
  laneRoute(laneId: LaneId): string | undefined {
    const lane = this.#lanes.find((candidate) => candidate.id === laneId)
    return lane ? `${this.#mergedRoute}-${lane.id}` : undefined
  }

  /** True when `route` is one of the per-lane filter routes. */
  isLaneRoute(route: string): boolean {
    return this.#lanes.some((lane) => `${this.#mergedRoute}-${lane.id}` === route)
  }

  /** The lane a route belongs to, or undefined for the merged route. */
  laneForRoute(route: string): Lane | undefined {
    return this.#lanes.find((lane) => `${this.#mergedRoute}-${lane.id}` === route)
  }

  laneById(laneId: LaneId): Lane | undefined {
    return this.#lanes.find((lane) => lane.id === laneId)
  }

  /**
   * Every model visible on `route`, in lane order then lane order. A lane route
   * returns only that lane with bare ids.
   */
  list(route: string): UnifiedModel[] {
    const lanes = this.laneForRoute(route) ? [this.laneForRoute(route) as Lane] : this.#lanes
    const bare = this.isLaneRoute(route)
    const out: UnifiedModel[] = []
    const seen = new Set<string>()
    for (const lane of lanes) {
      for (const id of lane.models()) {
        const model = lane.entry(id)
        if (!model) continue
        const modelId = bare ? id : `${lane.id}${LANE_SEPARATOR}${id}`
        if (seen.has(modelId)) continue // dsh-llm rejects duplicate ids
        seen.add(modelId)
        out.push({
          id: modelId,
          bare: id,
          lane: lane.id,
          label: lane.label,
          name: bare ? (model.name ?? id) : `${model.name ?? id} · ${lane.label}`,
          contextWindow: contextWindowFor(model),
          maxTokens: maxTokensFor(model),
          inputModalities: model.imageInput ? ['text', 'image'] : ['text'],
        })
      }
    }
    return out
  }

  /**
   * Resolve a picker id to its lane and bare upstream id.
   *
   * Accepts `<lane>/<bare>`, a bare id on a lane route, and a bare id on the
   * merged route when exactly one lane knows it (so `opencode/big-pickle` and
   * a bare `big-pickle` both work). Ambiguous bare ids on the merged route fall
   * back to lane order rather than guessing wrong.
   */
  resolve(route: string, modelId: string): ResolvedModel | undefined {
    const routeLane = this.laneForRoute(route)

    if (modelId.includes(LANE_SEPARATOR)) {
      const [prefix, ...rest] = modelId.split(LANE_SEPARATOR)
      const lane = this.laneById(prefix as LaneId)
      const bare = rest.join(LANE_SEPARATOR)
      if (lane && bare.length > 0 && lane.entry(bare)) return { lane, model: lane.entry(bare) as LaneModel, bare }
    }

    if (routeLane) {
      const model = routeLane.entry(modelId)
      if (model) return { lane: routeLane, model, bare: model.id }
      return undefined
    }

    for (const lane of this.#lanes) {
      const model = lane.entry(modelId)
      if (model) return { lane, model, bare: model.id }
    }
    return undefined
  }

  health(): LaneHealth[] {
    return this.#lanes.map((lane) => lane.health())
  }

  /** One-line summary for the boot log. */
  summary(): string {
    const parts = this.#lanes.map((lane) => {
      const health = lane.health()
      return `${lane.label} ${health.models}${health.detail ? ' (stale)' : ''}`
    })
    return parts.join(' · ')
  }
}

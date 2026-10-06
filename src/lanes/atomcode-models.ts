/**
 * AtomCode model discovery.
 *
 * The AtomCode CLI keeps its roster in `~/.atomcode/config.toml`:
 *
 *   [provider_accounts.AtomGit]
 *   provider = "openai"
 *   base_url = "https://llm-api.atomgit.com/v1"
 *
 *   [models."AtomGit-qwen3.8-27b"]
 *   account  = "AtomGit"
 *   model    = "qwen3.8-27b"
 *   supports_vision = true
 *   context_window  = 262144
 *   reasoning_effort_levels = ["low", "medium", "xhigh"]
 *
 * The lane reuses that exact file so anything the user configured for the CLI
 * shows up here, and only exposes AtomGit free-lane models.
 */

import type { LaneModel } from '../types.ts'

/** Free-lane account names accepted from config.toml. */
export const FREE_ACCOUNTS = new Set(['AtomGit'])

/** Fallback roster used when config.toml is missing or has no AtomGit model. */
export const STATIC_ATOMCODE_MODELS: LaneModel[] = [
  {
    id: 'qwen3.8-27b',
    name: 'qwen3.8-27b',
    baseUrl: 'https://llm-api.atomgit.com/v1',
    contextWindow: 262_144,
    imageInput: true,
    reasoning: true,
    reasoningLevels: ['low', 'medium', 'xhigh'],
  },
  {
    id: 'glm5.3-flash',
    name: 'glm5.3-flash',
    baseUrl: 'https://llm-api.atomgit.com/v1',
    contextWindow: 512_000,
    reasoning: true,
    reasoningLevels: ['low', 'high'],
  },
]

/** `[provider_accounts.Name]` -> base_url map. */
export function parseProviderAccounts(toml: string): Map<string, string> {
  const out = new Map<string, string>()
  const sections = toml.split(/^\[(?![\s\]])/m)
  for (const section of sections) {
    const header = /^\s*provider_accounts\.("?)([^"\].]+)\1\s*\]/.exec(section)
    if (!header) continue
    const base = /base_url\s*=\s*"([^"]*)"/.exec(section)?.[1]
    if (base) out.set(header[2], base.replace(/\/+$/, ''))
  }
  return out
}

/**
 * `[models."ID"]` sections whose `account` is on the free lane. The DSH-facing
 * id is the bare upstream `model` value, so `AtomGit-qwen3.8-27b` in config.toml
 * arrives as `qwen3.8-27b`.
 */
export function parseAtomGitModels(toml: string): LaneModel[] {
  const accounts = parseProviderAccounts(toml)
  const out: LaneModel[] = []
  for (const match of toml.matchAll(/\[models\."([^"]+)"\]\s*([\s\S]*?)(?=\n\[|$)/g)) {
    const key = match[1]
    const profile = match[2] ?? ''
    const account = /account\s*=\s*"([^"]*)"/.exec(profile)?.[1]
    if (!account || !FREE_ACCOUNTS.has(account)) continue
    const model = /model\s*=\s*"([^"]*)"/.exec(profile)?.[1]
    if (!model) continue
    const ctx = Number(/context_window\s*=\s*(\d+)/.exec(profile)?.[1])
    const maxOut = Number(/max_output_tokens\s*=\s*(\d+)/.exec(profile)?.[1])
    const levels = /reasoning_effort_levels\s*=\s*\[([^\]]*)\]/.exec(profile)?.[1]
    const baseUrl = accounts.get(account)
    const entry: LaneModel = { id: model, name: model }
    if (baseUrl) entry.baseUrl = baseUrl
    if (Number.isFinite(ctx) && ctx > 0) entry.contextWindow = ctx
    if (Number.isFinite(maxOut) && maxOut > 0) entry.maxOutput = maxOut
    if (/supports_vision\s*=\s*true/.test(profile)) entry.imageInput = true
    if (!/supports_reasoning\s*=\s*false/.test(profile)) entry.reasoning = true
    if (levels) entry.reasoningLevels = [...levels.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    // The config section key stays searchable so a user who copied the key out
    // of config.toml still resolves.
    if (key && key !== model) entry.name = entry.name ?? key
    out.push(entry)
  }
  return out
}

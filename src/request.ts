import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { HarnessBlock, HarnessGenerateOptions, HarnessTool, LaneModel } from './types.ts'

/**
 * Harness GenerateOptions -> OpenAI chat.completions payload.
 *
 * Shared by the two lanes that own their wire instead of borrowing pi-ai:
 * AtomCode has to build the exact bytes it signs, and OpenCode Zen has to
 * inject its reserved gate tools. Conversion follows the semantics proven by
 * cline2dsh/messages.ts: system merged at the front, images loaded from the
 * harness attachment store, assistant tool-calls / tool-results mapped to
 * OpenAI shapes.
 */

export type OpenAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIContentPart[] | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface OpenAITool {
  type: 'function'
  function: { name: string; description?: string; parameters?: unknown }
}

export interface OpenAIPayload {
  model: string
  messages: OpenAIMessage[]
  stream: boolean
  stream_options?: { include_usage: boolean }
  tools?: unknown[]
  tool_choice?: string
  temperature?: number
  max_tokens?: number
  reasoning_effort?: string
  [key: string]: unknown
}

/**
 * Harness attachment root (mirrors dsh-attachment-local's resolveDshHome).
 * DSH_HOME is always set by the harness child; the homedir fallback covers
 * direct invocation (tests, tooling).
 */
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  if (configured) return configured
  return join(homedir(), '.dsh')
}

/** Content-addressed attachment path for a harness attachment reference. */
export function attachmentObjectPath(ref: unknown): string | undefined {
  const attachment = (ref ?? {}) as { attachmentId?: unknown }
  const id = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : ''
  const sha = id.startsWith('sha256:') ? id.slice(7) : id
  if (!/^[0-9a-f]{64}$/.test(sha)) return undefined
  return join(dshHome(), 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
}

async function attachmentToDataUrl(ref: unknown): Promise<string | undefined> {
  const attachment = (ref ?? {}) as { attachmentId?: unknown; mediaType?: unknown }
  const path = attachmentObjectPath(ref)
  if (!path) return undefined
  try {
    const bytes = await readFile(path)
    const mediaType = typeof attachment.mediaType === 'string' && attachment.mediaType.length > 0 ? attachment.mediaType : 'image/png'
    return `data:${mediaType};base64,${bytes.toString('base64')}`
  } catch {
    return undefined
  }
}

async function imagePart(block: { attachment?: unknown; offloaded?: unknown }): Promise<OpenAIContentPart> {
  if (block.offloaded === true) {
    const id = (block.attachment as { attachmentId?: string } | null | undefined)?.attachmentId
    const short = typeof id === 'string' && id.length > 0 ? ` ${id.slice(0, 30)}` : ''
    return { type: 'text', text: `[image omitted: offloaded to fit the request image budget${short}]` }
  }
  const url = await attachmentToDataUrl(block.attachment)
  if (!url) {
    const id = (block.attachment as { attachmentId?: string } | null | undefined)?.attachmentId
    return { type: 'text', text: `[image omitted: unreadable attachment reference ${JSON.stringify(id ?? '')}]` }
  }
  return { type: 'image_url', image_url: { url } }
}

/** user / tool-result blocks -> OpenAI content parts. */
async function partsFor(blocks: HarnessBlock[], depth = 0): Promise<OpenAIContentPart[]> {
  const parts: OpenAIContentPart[] = []
  if (depth > 8) return parts
  for (const block of blocks ?? []) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block as { attachment?: unknown; offloaded?: unknown }))
    } else if (block.type === 'tool-result') {
      parts.push(...(await partsFor(block.content ?? [], depth + 1)))
    }
  }
  return parts
}

function textOnly(parts: OpenAIContentPart[]): string {
  return parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter((text) => text.length > 0)
    .join('')
}

export function systemText(system: unknown): string {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((entry) => {
        const block = entry as { type?: unknown; text?: unknown }
        return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
      })
      .filter((text) => text.length > 0)
      .join('\n')
  }
  return ''
}

/**
 * Map harness reasoning hints to the effort values free-lane models accept.
 * The declared ladder wins when the model publishes one (qwen has `xhigh`).
 */
export function reasoningEffortFor(options: HarnessGenerateOptions, levels?: string[]): string | undefined {
  const raw = (options.reasoningEffort ?? options.reasoning ?? '').toString().toLowerCase().trim()
  if (!raw || raw === 'off' || raw === 'none' || raw === 'disabled' || raw === 'default') return undefined
  if (levels && levels.length > 0 && levels.includes(raw)) return raw
  const canonical =
    raw === 'minimal' || raw === 'low'
      ? 'low'
      : raw === 'medium' || raw === 'middle'
        ? 'medium'
        : raw === 'high' || raw === 'xhigh' || raw === 'max' || raw === 'highest'
          ? 'high'
          : undefined
  if (!canonical) return undefined
  if (levels && levels.length > 0 && !levels.includes(canonical)) return undefined
  return canonical
}

/**
 * Build the payload object for `options`. `transform` gets the last word on
 * the finished body (OpenCode's gate shape rewrites `tools`/`tool_choice`).
 * `JSON.stringify(payload)` is the byte string that goes on the wire — one
 * stringify, no re-encoding, so AtomCode's signature covers exactly these bytes.
 */
export async function buildOpenAIPayload(
  options: HarnessGenerateOptions,
  entry: Pick<LaneModel, 'id' | 'reasoningLevels'> | undefined,
  transform?: (payload: OpenAIPayload) => OpenAIPayload,
): Promise<{ payload: OpenAIPayload; body: Buffer }> {
  const messages: OpenAIMessage[] = []

  const systemParts: string[] = []
  const fromOptions = systemText(options.system)
  if (fromOptions.length > 0) systemParts.push(fromOptions)
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = textOnly(await partsFor(message.content ?? []))
      if (text.length > 0) systemParts.push(text)
    }
  }
  if (systemParts.length > 0) messages.push({ role: 'system', content: systemParts.join('\n\n') })

  for (const message of options.messages) {
    if (message.role === 'system') continue
    const blocks = message.content ?? []
    if (message.role === 'user') {
      // Plain parts first, then every tool-result as an OpenAI `tool` message
      // — in order, right where the harness put them.
      const parts = await partsFor(blocks.filter((block) => block.type !== 'tool-result'))
      const results = blocks.filter((block) => block.type === 'tool-result') as Array<
        Extract<HarnessBlock, { type: 'tool-result' }>
      >
      if (parts.length > 0 || results.length === 0) {
        messages.push({
          role: 'user',
          content: parts.length === 0 ? '' : parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
        })
      }
      for (const result of results) {
        let rparts = await partsFor(result.content ?? [])
        const hasImage = rparts.some((part) => part.type === 'image_url')
        const hasText = rparts.some((part) => part.type === 'text' && part.text.length > 0)
        if (!hasImage && !hasText) rparts = [{ type: 'text', text: '(no output)' }]
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: rparts.length === 1 && rparts[0].type === 'text' ? rparts[0].text : rparts,
        })
      }
      continue
    }
    // assistant: text + tool-calls (reasoning dropped: OpenAI-compat servers
    // reject unknown assistant fields and re-sending it doubles the tokens).
    const texts: string[] = []
    const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = []
    for (const block of blocks) {
      if (block.type === 'text') {
        if (block.text.length > 0) texts.push(block.text)
      } else if (block.type === 'tool-call') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments || '{}' },
        })
      }
    }
    const content = texts.join('')
    messages.push({
      role: 'assistant',
      content: content.length > 0 || toolCalls.length === 0 ? content : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })
  }

  let payload: OpenAIPayload = {
    model: entry?.id ?? options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }

  const tools = options.tools?.map((tool: HarnessTool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    },
  }))
  if (tools && tools.length > 0) {
    payload.tools = tools
    payload.tool_choice = 'auto'
  }
  if (typeof options.temperature === 'number') payload.temperature = options.temperature
  if (typeof options.maxTokens === 'number' && options.maxTokens > 0) payload.max_tokens = options.maxTokens
  const effort = reasoningEffortFor(options, entry?.reasoningLevels)
  if (effort) payload.reasoning_effort = effort

  if (transform) payload = transform(payload)
  return { payload, body: Buffer.from(JSON.stringify(payload), 'utf8') }
}

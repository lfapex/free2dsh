import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { HarnessBlock, HarnessGenerateOptions, HarnessMessage, HarnessTool } from './types.ts'

/**
 * Harness GenerateOptions -> pi-ai Context conversion.
 *
 * Only the Cline lane needs this: it borrows pi-ai's openai-completions wire
 * instead of owning one. Clean-room port of dsh-llm-pi-ai's textOnlyContext
 * (via cline2dsh). User and tool-result image blocks are kept: when the
 * catalog declares image input the adapter advertises it, and the bytes load
 * from the harness attachment store here.
 */

export type PiMessage =
  | { role: 'user'; content: string | PiContentBlock[]; timestamp: number }
  | {
      role: 'assistant',
      content: PiAssistantBlock[],
      api: 'openai-completions',
      provider: string,
      model: string,
      usage: PiUsage,
      stopReason: 'stop' | 'toolUse',
      timestamp: number,
    }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: PiContentBlock[]; isError: boolean; timestamp: number }

export type PiAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

export type PiContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export interface PiTool {
  name: string
  description: string
  parameters: unknown
}

export interface PiContext {
  systemPrompt?: string
  messages: PiMessage[]
  tools?: PiTool[]
}

export function zeroUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed }
  } catch {
    return { raw }
  }
}

/** Harness attachment root (mirrors dsh-attachment-local's resolveDshHome). */
function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  if (configured) return configured
  return join(homedir(), '.dsh')
}

async function toPiImage(ref: unknown): Promise<PiContentBlock> {
  const attachment = (ref ?? {}) as { attachmentId?: unknown; mediaType?: unknown }
  const id = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : ''
  const sha = id.startsWith('sha256:') ? id.slice(7) : id
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    return { type: 'text', text: `[image omitted: unreadable attachment reference ${JSON.stringify(id)}]` }
  }
  const path = join(dshHome(), 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
  try {
    const bytes = await readFile(path)
    return {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: typeof attachment.mediaType === 'string' && attachment.mediaType.length > 0 ? attachment.mediaType : 'image/png',
    }
  } catch {
    return { type: 'text', text: `[image omitted: failed to read normalized attachment ${JSON.stringify(id)}]` }
  }
}

function offloadedImagePart(ref: unknown): PiContentBlock {
  const id = (ref as { attachmentId?: unknown } | null | undefined)?.attachmentId
  const short = typeof id === 'string' && id.length > 0 ? ` ${id.slice(0, 30)}` : ''
  return { type: 'text', text: `[image omitted: offloaded to fit the request image budget${short}]` }
}

async function imagePart(block: { type?: unknown; attachment?: unknown; offloaded?: unknown }): Promise<PiContentBlock> {
  return block.offloaded === true ? offloadedImagePart(block.attachment) : toPiImage(block.attachment)
}

async function userParts(blocks: HarnessBlock[]): Promise<PiContentBlock[]> {
  const parts: PiContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block))
    }
  }
  return parts
}

async function toolResultParts(blocks: HarnessBlock[]): Promise<PiContentBlock[]> {
  const parts: PiContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block))
    } else if (block.type === 'tool-result') {
      parts.push(...(await toolResultParts(block.content)))
    }
  }
  return parts
}

function toPiAssistant(message: HarnessMessage, providerId: string): Extract<PiMessage, { role: 'assistant' }> {
  const content: PiAssistantBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        content.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call':
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
        break
      default:
        break
    }
  }
  const source = message.source
  const model = source?.kind === 'model' && typeof source.model === 'string' ? source.model : providerId
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: source?.kind === 'model' && typeof source.provider === 'string' ? source.provider : providerId,
    model,
    usage: zeroUsage(),
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

function flattenText(message: HarnessMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

/** Convert the harness conversation into a pi-ai Context (async: images hit disk). */
export async function toPiContext(options: HarnessGenerateOptions): Promise<PiContext> {
  const providerId = options.provider
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = flattenText(message)
      if (text.length > 0) messages.push({ role: 'user', content: text, timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, providerId)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    const parts = await userParts(message.content)
    const results = message.content.filter((block) => block.type === 'tool-result') as Array<
      Extract<HarnessBlock, { type: 'tool-result' }>
    >
    if (parts.length > 0 || results.length === 0) {
      const first = parts[0]
      let content: string | PiContentBlock[]
      if (parts.length === 0) content = ''
      else if (parts.length === 1 && first?.type === 'text') content = first.text
      else content = parts
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      let rparts = await toolResultParts(result.content)
      const hasImage = rparts.some((part) => part.type === 'image')
      const hasText = rparts.some((part) => part.type === 'text' && part.text.length > 0)
      if (!hasImage && !hasText) rparts = [{ type: 'text', text: '(no output)' }]
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: rparts,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  const context: PiContext = { messages }
  if (typeof options.system === 'string' && options.system.length > 0) context.systemPrompt = options.system
  const tools = options.tools?.map((tool: HarnessTool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  if (tools && tools.length > 0) context.tools = tools
  return context
}

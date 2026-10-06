// Live end-to-end check against the real OpenCode Zen anonymous lane — the one
// free lane that needs no account, so it is the only one verifiable end-to-end
// without credentials. Run: node test/live.mjs
// Env: FREE2DSH_LIVE_MODEL to pick a specific model id.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const lines = []
let adapter
const ctx = {
  logger: {
    info: (m) => lines.push(m),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`),
  },
  llm: { registerAdapter: (_providers, a) => { adapter = a } },
  effect: (fn) => { ctx.dispose = fn() },
}

apply(ctx, { lanes: ['opencode'], dataDir: mkdtempSync(join(tmpdir(), 'free2dsh-live-')) })

// Let the live catalog settle.
await new Promise((resolve) => setTimeout(resolve, 6000))
for (const line of lines) console.log(line)

const models = adapter.listModels('free2dsh')
console.log(`\nlive catalog (${models.length}):`)
for (const model of models) {
  const resolved = adapter.resolveModel('free2dsh', model.id)
  console.log(`  ${model.id}  — ${model.name}  ctx=${resolved.context.contextWindow}  max=${resolved.defaultMaxTokens}`)
}

const wanted = process.env.FREE2DSH_LIVE_MODEL
const target = (wanted ? models.find((m) => m.id === `opencode/${wanted}` || m.id === wanted) : undefined) ?? models[0]
if (!target) {
  console.log('\nno live models — nothing to probe')
  process.exit(1)
}

console.log(`\nprobing ${target.id} …`)
const started = Date.now()
let text = ''
let finish = null
let usage = null
for await (const chunk of adapter.stream('free2dsh', target.id, {
  provider: 'free2dsh',
  model: target.id,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }] }],
  maxTokens: 2000,
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'usage') usage = chunk.usage
  if (chunk.type === 'finish') finish = chunk.reason
}
console.log(`text   : ${JSON.stringify(text.slice(0, 200))}`)
console.log(`usage  : ${JSON.stringify(usage)}`)
console.log(`finish : ${JSON.stringify(finish)}`)
console.log(`elapsed: ${Date.now() - started}ms`)

ctx.dispose?.()
process.exit(finish && finish.kind === 'stop' ? 0 : 1)

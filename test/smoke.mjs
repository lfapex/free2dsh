// Runtime smoke test: boot the built plugin against a fake DSH host exactly
// the way cordis would, then print the merged picker catalog and per-lane
// health. Run: node test/smoke.mjs
//
// Every lane is pointed at a local stub upstream by default, so this is
// deterministic and offline; set FREE2DSH_LIVE=1 to talk to the real APIs.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, PLUGIN_VERSION, Config } from '../lib/index.js'

const live = process.env.FREE2DSH_LIVE === '1'
const home = mkdtempSync(join(tmpdir(), 'free2dsh-smoke-'))

/* ---- fake upstream: serves a canned OpenAI SSE stream ------------------ */
const sse = (lines) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const line of lines) controller.enqueue(encoder.encode(line))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

const cannedStream = () =>
  sse([
    'data: {"choices":[{"delta":{"content":"OK "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"from upstream"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4}}\n\n',
    'data: [DONE]\n\n',
  ])

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = typeof url === 'string' ? url : url.toString()
  if (live) return realFetch(url, init)
  // Order matters: the most specific path first, so each lane only ever sees
  // its own upstream shape.
  if (href.includes('/ai/cline/recommended-models')) {
    return json({ free: [{ id: 'cline-free/deepseek-v4.1-flash', name: 'Deepseek-v4.1-Flash' }], clinePass: [] })
  }
  if (href.includes('openrouter.ai/api/v1/models')) return json({ data: [] })
  if (href.includes('models.dev')) {
    return json({
      opencode: {
        models: {
          'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0 }, limit: { context: 1000000, output: 32000 } },
          'paid-thing': { name: 'Paid Thing', cost: { input: 3, output: 15 } },
        },
      },
    })
  }
  if (href.includes('/zen/v1/models')) return json({ data: [{ id: 'big-pickle' }, { id: 'paid-thing' }] })
  if (href.includes('/chat/completions')) return cannedStream()
  if (href.includes('/v1/chat/completions')) return cannedStream()
  if (href.endsWith('/models')) return json({ data: [{ id: 'qwen/qwen3.8-27b:free' }, { id: 'some-paid-model' }] })
  return json({})
}

/* ---- fake credentials so the Cline and AtomCode lanes can read files ---- */
const clineHome = join(home, 'cline')
mkdirSync(join(clineHome, 'data', 'settings'), { recursive: true })
writeFileSync(
  join(clineHome, 'data', 'settings', 'providers.json'),
  JSON.stringify({ providers: { cline: { settings: { auth: { accessToken: 'tok', accountId: 'usr-1' } } } } }),
)
const atomHome = join(home, 'atomcode')
mkdirSync(atomHome, { recursive: true })
writeFileSync(join(atomHome, 'auth.toml'), 'access_token = "tok"\nexpires_in = 604800\ncreated_at = 1791162795\n\n[user]\nid = "uid-1"\n')
writeFileSync(
  join(atomHome, 'config.toml'),
  [
    '[provider_accounts.AtomGit]',
    'base_url = "https://llm-api.atomgit.com/v1"',
    '',
    '[models."AtomGit-qwen3.8-27b"]',
    'account = "AtomGit"',
    'model = "qwen3.8-27b"',
    'context_window = 262144',
    '',
  ].join('\n'),
)

/* ---- fake DSH host ----------------------------------------------------- */
const lines = []
const ctx = {
  logger: {
    debug: (m) => lines.push(`debug ${m}`),
    info: (m) => lines.push(`info  ${m}`),
    warn: (m) => lines.push(`warn  ${m}`),
    error: (m) => lines.push(`error ${m}`),
  },
  llm: { registerAdapter: (providers, adapter) => { ctx.registered = { providers, adapter } } },
  effect: (fn) => { ctx.dispose = fn() },
}

apply(ctx, {
  dataDir: join(home, 'data'),
  clineCredentialsPath: join(clineHome, 'data', 'settings', 'providers.json'),
  atomcodeHome: atomHome,
})

const { providers, adapter } = ctx.registered
console.log(`plugin ${name} v${PLUGIN_VERSION}`)
console.log('registered routes:', providers.join(', '))
console.log('')

// Let the background warm-up finish.
await new Promise((resolve) => setTimeout(resolve, 1500))

for (const route of providers) {
  const models = adapter.listModels(route)
  console.log(`${route} (${models.length}):`)
  for (const model of models) console.log(`  ${model.id.padEnd(42)} ${model.name}`)
  console.log('')
}

// One real turn per lane, through the merged route.
async function turn(route, id) {
  let text = ''
  let finish = null
  let usage = null
  for await (const chunk of adapter.stream(route, id, {
    provider: route,
    model: id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK' }] }],
    maxTokens: 100,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text, usage, finish }
}

for (const id of adapter.listModels('free2dsh').map((model) => model.id)) {
  console.log(`turn ${id} ->`, JSON.stringify(await turn('free2dsh', id)))
}

// An unknown model must fail cleanly, not crash the host.
let unknownFinish = null
for await (const chunk of adapter.stream('free2dsh', 'ghost/model', { provider: 'free2dsh', model: 'ghost/model', messages: [] })) {
  if (chunk.type === 'finish') unknownFinish = chunk.reason
}
console.log('unknown model ->', JSON.stringify(unknownFinish))

ctx.dispose?.()
console.log('')
console.log('--- plugin log ---')
for (const line of lines) console.log(line)
console.log('')
console.log('schema ok:', Config({}).providerId === 'free2dsh')
process.exit(0)

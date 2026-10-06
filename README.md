# free2dsh

Every free LLM lane in **one** DSH plugin. Install it once and the model picker
offers the free models from three platforms behind a single `free2dsh`
provider:

| Lane | Provider route | What it is | Sign-in |
| --- | --- | --- | --- |
| **Cline** | `free2dsh-cline` | Cline's promo free fleet + its OpenRouter `:free` catalogue | Cline desktop app, logged in |
| **AtomCode** | `free2dsh-atomcode` | AtomGit CodingPlan free lane (`qwen3.8-27b`, `glm5.3-flash`, …) | `atomcode login` |
| **OpenCode Zen** | `free2dsh-opencode` | OpenCode's anonymous free lane — no account at all | none |

Merged route `free2dsh` shows all three at once. Model ids are namespaced
`<lane>/<id>` so Cline's `cline-free/deepseek-v4.1-flash` and AtomCode's
`qwen3.8-27b` can never collide; on a lane route the ids stay bare.

```
DSH session
│ harness chunks (block-start / text-delta / usage / finish …)
▼
Free2dshAdapter            one provider, resolves id -> (lane, model)
├── cline      → pi-ai openai-completions → api.cline.bot/api/v1   (Cline OAuth token)
├── atomcode   → signed SSE  → llm-api.atomgit.com / api-ai.gitcode.com
└── opencode   → SSE         → opencode.ai/zen/v1                   (Bearer public)
```

One lane being down, unconfigured or rate-limited never takes the others down:
lanes warm their catalogues independently in the background and the adapter
registers before any of them answer.

## Requirements

DSH ≥ 0.1.7, Node.js ≥ 20. Each lane needs its own prerequisites — see
[Per-lane setup](#per-lane-setup).

## Install

Straight from GitHub — nothing to build first, the bundle ships in the repo:

```sh
dsh plugin --profile web add github:lfapex/free2dsh
```

From a local checkout, if you are working on the source:

```sh
git clone https://github.com/lfapex/free2dsh.git
cd free2dsh && npm install && npm run build
dsh plugin --profile web add file:$PWD
```

Restart the profile afterwards. `free2dsh` appears in the model picker; the
per-lane routes (`free2dsh-cline`, …) show up next to it.

The repo declares **no install-time build scripts**: `lib/` is committed, so
pnpm never has to run anything while installing the plugin. That is deliberate —
pnpm blocks git-hosted build scripts until the consumer allowlists them, which
would otherwise make the plugin uninstallable (see Troubleshooting).

## Per-lane setup

You only need the platforms you actually want — an unusable lane logs one
warning and contributes nothing.

**OpenCode Zen** — nothing to do. It is the anonymous lane and needs no key,
no account and no local files.

**AtomCode** — install the AtomCode CLI and run `atomcode login` once. The lane
reads `~/.atomcode/auth.toml` and the AtomGit model profiles from
`~/.atomcode/config.toml` (override with `ATOMCODE_HOME` or the
`atomcodeHome` config).

**Cline** — install the Cline desktop app and log in **once**. The lane reads
`~/.cline/data/settings/providers.json` (override with `CLINE_HOME` or the
`clineCredentialsPath` config) and then keeps the session alive on its own:
when the access token reaches its expiry it renews it in-process via
`POST /api/v1/auth/refresh`, single-flighted per credentials file. Cline's
backend does not rotate the refresh token, so the desktop app is unaffected
and you do **not** need it running. The renewed token lives only in memory —
`providers.json` is never rewritten, so it stays the desktop app's property.

You only have to sign in again when the refresh token itself is gone or
revoked (`providers.json` has no `refreshToken`, or the refresh answers
401/403). Cline's free quota is shared with the desktop app.

## Configuration

Defaults need no edits. Override anything in the profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: free2dsh
      name: 'free2dsh'
      config:
        lanes: [cline, opencode]     # default: all three
        refreshSeconds: 300
        clineIncludePass: false      # Cline Pass needs a paid subscription
        atomcodeAllowRefresh: false  # never POST the OAuth refresh
        firstEventMs: 30000
        bodyIdleMs: 120000
```

| Option | Default | Meaning |
| --- | --- | --- |
| `providerId` | `free2dsh` | merged route name; lane routes are derived as `<providerId>-<lane>` |
| `lanes` | all | subset of `cline`, `atomcode`, `opencode` |
| `refreshSeconds` | `300` | catalogue refresh cadence (min 30) |
| `dataDir` | `~/.free2dsh` | catalogues + the AtomCode token sidecar (`FREE2DSH_HOME`) |
| `clineBaseURL` | `https://api.cline.bot/api/v1` | |
| `clineCredentialsPath` | `~/.cline/data/settings/providers.json` | |
| `clineFreeOnly` | `true` | expose only `:free` ids from Cline's `/models` |
| `clineIncludePass` | `false` | also expose the Cline Pass bucket (403 without a subscription) |
| `atomcodeHome` | `~/.atomcode` | |
| `atomcodeHosts` | from `config.toml` + two verified gateways | tried round-robin |
| `atomcodeClientVersion` | `5.2.1` | `X-AtomCode-Ver`; bump when the gateway rejects `1` signatures |
| `atomcodeModels` | all | model id allowlist |
| `atomcodeAllowRefresh` | `true` | mint a token when the CLI file token is stale |
| `opencodeBaseURL` | `https://opencode.ai/zen` | |
| `opencodeIncludeResponsesOnly` | `false` | expose `muse-spark-*` (Responses-API-only, not usable on this wire) |
| `firstEventMs` | `30000` | watchdog: time to the first stream event |
| `bodyIdleMs` | `120000` | watchdog: mid-response body silence |

## How each lane works

**Cline.** Free is two disjoint families: the promo free fleet served by
`GET /ai/cline/recommended-models` (the `free` bucket; `clinePass` is
opt-in), and the OpenRouter-routed `:free` rows of `GET /models`. Requests
carry the Cline client's identity headers — the `cline-free/*` routing prefix
is gated on those, a bare Bearer gets 403. The wire itself is DSH's own
pi-ai `openai-completions` implementation, so the lane only adds credentials,
headers and the catalogue.

**AtomCode.** Owns its wire because `atomcode-signing-v1` covers the exact
request bytes: the payload is built, stringified, signed (HKDF-SHA256 salt
bound to the user id, the hour bucket and the token/version hashes, then an
HMAC over the canonical request string) and posted as-is. Hosts round-robin so
a retry fails over instead of hammering one gateway.

**OpenCode Zen.** No credential — the key is the literal string `public` — but
the requests have to look like the CLI's: matching user agent, Zen's canonical
`ses_…` session and `prj_…` project ids derived per conversation, and (since
2026-09-16) a body shape that streams and carries the reserved `bash`/`read`
function tools. Those gate tools are stripped back out of the stream, so the
harness never sees a phantom tool call. `muse-spark-*` is Responses-API-only
upstream and stays off this wire.

Every lane falls back the same way: **live source → 7-day disk cache →
compiled-in static roster**, so the picker is populated even when an upstream
is unreachable. Failed refreshes are logged and never block the other lanes.

## Resilience

- **Watchdogs.** `fetch` owns no body-silence timeout, so a tunnel that
  connects but never streams would hang the turn forever. Each lane runs its
  stream through a shared watchdog: a first-event window, then a body-idle
  window, both surfaced as a classified `finish` chunk rather than a hang.
- **Terminators.** Every stream ends with `usage` then `finish` — on success,
  on upstream error, on timeout, and even when a lane throws before returning
  its generator.
- **One upstream attempt per call.** Retry policy stays DSH's job.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| A lane shows 0 models and a warning | expected when you have no account for it — the other lanes still work |
| `CLINE_NOT_LOGGED_IN` | open the Cline desktop app and sign in |
| Cline calls start 401ing | the renewal failed — sign in from the Cline desktop app again; the desktop app need not stay running |
| `CLINE_NO_REFRESH_TOKEN` | `providers.json` carries no `refreshToken`, so there is nothing to renew with; sign in from the Cline desktop app |
| Cline `cline-free/*` returns 403 | the backend rejected the client identity headers; check `CLINE_CLIENT_TYPE` / `CLINE_CLIENT_VERSION` |
| `ATOMCODE_NOT_INSTALLED` | run `atomcode login` |
| AtomCode 401/403 right after boot | the CLI file token was stale; `atomcodeAllowRefresh: true` mints one, otherwise log in again |
| OpenCode only lists a few models | the live fetch raced your network; the next refresh fixes it |
| `RATE_LIMIT` on Zen | the anonymous lane is quota-per-IP — switch network node or wait |
| `REGION_BLOCKED` | Zen rejected the current region for that model; pick another |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | you installed a revision that still declared a `prepare` script; pnpm ≥ 10.26 blocks git-hosted build scripts until the *consumer* approves them. Install a revision without one (the bundle is committed, so there is nothing to build), or allowlist the plugin in the profile's `pnpm-workspace.yaml` under `allowBuilds` |

Health snapshots live under `<dataDir>/cache/` — `cline.json`, `atomcode.json`,
`opencode.json`.

## Development

```sh
npm install
npm run typecheck
npm test          # 63 unit tests, no network
npm run smoke     # boots the built plugin against a stub upstream, offline
npm run live      # real OpenCode Zen round trip (no account needed)
```

Architecture lives in `src/lanes/*` — one file per platform (credentials,
catalogue, wire) behind the `Lane` interface in `src/types.ts`. The shared
plumbing (`chunks`, `watchdog`, `request`, `openai-stream`, `sse`, `ids`) is
lane-agnostic, and `catalog.ts` + `adapter.ts` are the only place that knows
about more than one lane.

## Credits

Built by merging three existing DSH plugins and their upstream research:
[cline2dsh](https://github.com/lfapex/cline2dsh) (own),
[atomcode2dsh](https://github.com/lfapex/atomcode2dsh) (own), and
[opencode2dsh](https://github.com/FishBottle7/opencode2dsh) by @FishBottle7 —
which in turn credits [opencode2api](https://github.com/jasonxu114514) for the
anonymous-lane request disguise.

## License

MIT © lfapex

# free2dsh

一个 DSH 插件，同时接入三个平台的免费模型。装一次，模型选择器里就同时出现
**Cline 免费舰队**、**AtomCode（AtomGit CodingPlan）** 和 **OpenCode Zen 匿名免费通道**，
统一挂在一个 `free2dsh` provider 下。

| 通道 | provider 路由 | 内容 | 需要登录吗 |
| --- | --- | --- | --- |
| **Cline** | `free2dsh-cline` | Cline 推广免费舰队 + OpenRouter `:free` 目录 | Cline 桌面版已登录 |
| **AtomCode** | `free2dsh-atomcode` | AtomGit CodingPlan 免费通道（`qwen3.8-27b`、`glm5.3-flash` …） | 执行过 `atomcode login` |
| **OpenCode Zen** | `free2dsh-opencode` | OpenCode 匿名免费通道 | 不需要 |

合并路由 `free2dsh` 一次显示全部三个通道。模型 id 带 `<通道>/` 前缀，避免 Cline 的
`cline-free/deepseek-v4.1-flash` 和 AtomCode 的 `qwen3.8-27b` 撞名；单通道路由下
id 保持原样。

```
DSH 会话
│ harness chunks（block-start / text-delta / usage / finish …）
▼
Free2dshAdapter            一个 provider，把 id 解析成 (通道, 模型)
├── cline      → pi-ai openai-completions → api.cline.bot/api/v1   （Cline OAuth 令牌）
├── atomcode   → 签名 SSE → llm-api.atomgit.com / api-ai.gitcode.com
└── opencode   → SSE        → opencode.ai/zen/v1                   （Bearer public）
```

任何一个通道挂掉、没配置或被限流，都不会拖垮其他通道：适配器先注册，各通道在后台
各自预热目录。

## 环境要求

DSH ≥ 0.1.7、Node.js ≥ 20。每个通道另有自己的前置条件，见[各通道准备](#各通道准备)。

## 安装

```sh
git clone https://github.com/lfapex/free2dsh.git
cd free2dsh && npm install && npm run build
dsh plugin --profile web add file:$PWD
```

装完重启 profile，模型选择器里出现 `free2dsh`，旁边还有三个单通道路由
（`free2dsh-cline` 等）。

## 各通道准备

只准备你真正要用的平台即可 —— 用不上的通道只会打一条 warning，不贡献任何模型。

**OpenCode Zen**：什么都不用做。匿名通道，不需要 key、不需要账号、不读本地文件。

**AtomCode**：装好 AtomCode CLI，执行一次 `atomcode login`。插件读取
`~/.atomcode/auth.toml` 和 `~/.atomcode/config.toml` 里的 AtomGit 模型档案
（可用 `ATOMCODE_HOME` 或配置项 `atomcodeHome` 覆盖）。

**Cline**：装好 Cline 桌面版并登录**一次**。插件读取
`~/.cline/data/settings/providers.json`（可用 `CLINE_HOME` 或配置项
`clineCredentialsPath` 覆盖），之后自己维持会话：访问令牌到期时通过
`POST /api/v1/auth/refresh` 在进程内续期（按凭据文件 single-flight 去重）。Cline
后端**不轮换** refresh token，因此不会影响桌面版，**不需要**开着桌面版。续期出来的
令牌只存在内存里 —— `providers.json` 不会被回写，始终是桌面版自己的文件。

只有当 refresh token 本身丢失或被撤销时（`providers.json` 里没有 `refreshToken`，
或刷新接口返回 401/403）才需要重新登录。Cline 的免费额度与桌面版共享。

## 配置

默认无需改动。要覆盖就在 profile 的 `cordis.patch.yml` 里写：

```yaml
- insert:
    - id: free2dsh
      name: 'free2dsh'
      config:
        lanes: [cline, opencode]     # 默认三个全开
        refreshSeconds: 300
        clineIncludePass: false      # Cline Pass 需要付费订阅
        atomcodeAllowRefresh: false  # 禁止发起 OAuth 刷新
        firstEventMs: 30000
        bodyIdleMs: 120000
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `providerId` | `free2dsh` | 合并路由名；单通道路由按 `<providerId>-<通道>` 派生 |
| `lanes` | 全部 | `cline` / `atomcode` / `opencode` 的子集 |
| `refreshSeconds` | `300` | 目录刷新周期（最小 30） |
| `dataDir` | `~/.free2dsh` | 目录缓存 + AtomCode 令牌 sidecar（`FREE2DSH_HOME`） |
| `clineBaseURL` | `https://api.cline.bot/api/v1` | |
| `clineCredentialsPath` | `~/.cline/data/settings/providers.json` | |
| `clineFreeOnly` | `true` | 只暴露 Cline `/models` 里带 `:free` 的 id |
| `clineIncludePass` | `false` | 同时暴露 Cline Pass 桶（无订阅会 403） |
| `atomcodeHome` | `~/.atomcode` | |
| `atomcodeHosts` | `config.toml` 里的 + 两个已验证网关 | 轮询尝试 |
| `atomcodeClientVersion` | `5.2.1` | `X-AtomCode-Ver`；网关拒绝 `1` 签名时调大 |
| `atomcodeModels` | 全部 | 模型 id 白名单 |
| `atomcodeAllowRefresh` | `true` | CLI 文件令牌过期时自行换取新令牌 |
| `opencodeBaseURL` | `https://opencode.ai/zen` | |
| `opencodeIncludeResponsesOnly` | `false` | 暴露 `muse-spark-*`（仅 Responses API，本通道用不了） |
| `firstEventMs` | `30000` | 看门狗：等待首个流事件的毫秒数 |
| `bodyIdleMs` | `120000` | 看门狗：正文中允许的静默毫秒数 |

## 各通道原理

**Cline。** Cline 的「免费」是两族互不相交的模型：推广免费舰队走
`GET /ai/cline/recommended-models` 的 `free` 桶（`clinePass` 桶需订阅，默认关闭），
另一族是 `GET /models` 里 OpenRouter 路由的 `:free` 行。请求必须带上 Cline 客户端的
身份头 —— `cline-free/*` 路由前缀就是按这些头放行的，只带 Bearer 会 403。线路层直接复用
DSH 自带的 pi-ai `openai-completions`，本通道只补凭据、请求头和模型目录。

**AtomCode。** 自己实现线路层，因为 `atomcode-signing-v1` 覆盖的是**请求的原始字节**：
先构造 payload、只 stringify 一次、签名（盐绑定 user id、小时桶、token/version 哈希的
HKDF-SHA256，再对规范化请求串做 HMAC），然后原样发出。网关轮询，重试时自动切换而不是
死磕一个。

**OpenCode Zen。** 不需要凭据（key 就是字面量 `public`），但请求必须像 CLI 发的：一致的
user agent、按会话派生的 `ses_…` session 与 `prj_…` project id，以及（自 2026-09-16 起）
必须流式且携带保留的 `bash`/`read` function tools 的请求体形状。这些「闸门工具」会在读
流时再被剥掉，harness 不会看到幻影工具调用。`muse-spark-*` 上游只支持 Responses API，
不挂在 chat completions 这条线上。

三个通道的回退链一致：**实时源 → 7 天磁盘缓存 → 编译期静态名单**，上游不可达时选择器
照样有模型。刷新失败只记日志，不会阻塞其他通道。

## 稳定性

- **看门狗。** `fetch` 本身没有「正文静默」超时，隧道连上却一直不出数据会把这一轮对话
  永久挂死。每个通道的流都套了同一个看门狗：先首事件窗口、再正文静默窗口，超时以带
  分类的 `finish` chunk 收场，而不是挂起。
- **收尾保证。** 无论成功、上游报错、超时，还是通道在返回生成器之前就抛异常，流都以
  `usage` + `finish` 结束。
- **每轮只打一次上游。** 重试策略交给 DSH。

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 某通道 0 个模型并伴随 warning | 没这个平台的账号时的正常表现，其他通道照常用 |
| `CLINE_NOT_LOGGED_IN` | 打开 Cline 桌面版登录一次 |
| Cline 调用开始 401 | 续期失败；在 Cline 桌面版重新登录一次（桌面版不需要常驻） |
| `CLINE_NO_REFRESH_TOKEN` | `providers.json` 里没有 `refreshToken`；在 Cline 桌面版重新登录 |
| Cline `cline-free/*` 返回 403 | 客户端身份头被拒，检查 `CLINE_CLIENT_TYPE` / `CLINE_CLIENT_VERSION` |
| `ATOMCODE_NOT_INSTALLED` | 执行 `atomcode login` |
| AtomCode 刚启动就 401/403 | CLI 文件令牌过期；`atomcodeAllowRefresh: true` 会自行换取，否则重新登录 |
| OpenCode 模型偏少 | 实时拉取时网络还没就绪，下一轮刷新会补齐 |
| Zen 报 `RATE_LIMIT` | 匿名通道按 IP 限流，换节点或稍等 |
| 报 `REGION_BLOCKED` | Zen 判定当前地区不可用，换一个模型 |

健康快照在 `<dataDir>/cache/` 下：`cline.json`、`atomcode.json`、`opencode.json`。

## 开发

```sh
npm install
npm run typecheck
npm test          # 63 个单元测试，不联网
npm run smoke     # 用桩上游启动编译产物，离线可跑
npm run live      # 真实 OpenCode Zen 往返（无需账号）
```

架构在 `src/lanes/*`：每个平台一个文件（凭据、目录、线路），都实现 `src/types.ts`
里的 `Lane` 接口。共享管道（`chunks`、`watchdog`、`request`、`openai-stream`、
`sse`、`ids`）与通道无关；只有 `catalog.ts` 和 `adapter.ts` 知道「不止一个通道」这件事。

## 致谢

本项目由三个已有 DSH 插件及其上游研究成果合并而来：
[cline2dsh](https://github.com/lfapex/cline2dsh)（自有）、
[atomcode2dsh](https://github.com/lfapex/atomcode2dsh)（自有），以及 @FishBottle7 的
[opencode2dsh](https://github.com/FishBottle7/opencode2dsh) —— 后者又致谢了
[opencode2api](https://github.com/jasonxu114514) 的匿名通道请求伪装。

## License

MIT © lfapex

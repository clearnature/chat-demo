# 架构与计划：OpenCode 走 Anthropic Messages + SearXNG 本地搜索

> 目标：让 chat-demo 在「非 DeepSeek 官方 API」（OpenCode Go）下也能使用「智能搜索」（web_search / read_url），
> 复用现有 DeepSeek Anthropic 客户端与解析器，搜索走本地 SearXNG，不依赖 DeepSeek 服务端工具。

## 1. 背景与实测结论

- DeepSeek 官方的 `deepseek_web_search` / `deepseek_read_url` 是**服务端工具**，OpenCode Go 网关不透传。
- OpenCode Go 的 `https://opencode.ai/zen/go/v1/messages` **支持 Anthropic Messages 协议**
  （需要 `x-opencode-session`，`x-api-key` 或 Bearer 均可），SSE 事件格式与 Anthropic 一致。
- 该端点**不支持** Anthropic 服务端 `web_search_20250305` 工具，但**支持客户端工具**
  （`tools: [{name, description, input_schema}]`），返回标准 `tool_use`，`tool_result` 往返正常。
- 已实测模型：`deepseek-v4.1-flash`、`grok-4.7`、`claude-haiku-5-5` 均可 tool_use。
- 服务器已恢复本地 SearXNG：`https://aecci.net/searx/search?q=...&format=json`（20 条结果/查询，中英文均可用）。

## 2. 总体架构

```
┌──────────────────────────── 浏览器 chat-demo ────────────────────────────┐
│                                                                          │
│  store.streamReply                                                       │
│    │                                                                     │
│    ├── provider=deepseek ──▶ api/client.ts ──▶ /anthropic/v1/messages    │
│    │                          （服务端工具，现有逻辑不变）                │
│    │                                                                     │
│    └── provider=opencode ──▶ api/anthropic.ts（新增，可配置 transport）  │
│                               │  POST /oc-api/messages                   │
│                               │  headers: x-api-key + anthropic-version   │
│                               │           + x-opencode-session            │
│                               ▼                                          │
│                        stream events（parseEvent.ts 复用）               │
│                               │                                          │
│                        tool_use 块 ──▶ chat/tools.ts 执行                │
│                               │        web_search → GET /searx/search    │
│                               │        read_url   → GET /read-api/...    │
│                               ▼                                          │
│                        tool_result 回传，继续下一轮（≤3 轮）             │
│                               │                                          │
│                        reply.ts / view.ts（复用现有搜索步骤渲染）        │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                       同源 nginx（无 CORS、无额外 key）
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
        /searx/ → 127.0.0.1:8888             /read-api/ → 127.0.0.1:8889
        SearXNG（已恢复，原生 systemd）      正文提取代理（阶段 2 新增，SSRF 防护）
```

### 2.1 关键设计决策

**D1. Transport 抽象，而非复制客户端**
`api/anthropic.ts` 泛化现有 `api/client.ts` 的 `streamMessage`：请求体不变，
差异只在 baseUrl、鉴权头、会话头。DeepSeek 与 OpenCode 共用同一套 SSE 解析
（`sse.ts` / `parseEvent.ts` / `ApiError`）。

**D2. 客户端工具 → 归一化为现有服务端工具块**
执行层把 `tool_use` 归一化为内部已有的 `server_tool_use` 块，
把 SearXNG 结果归一化为 `web_search_tool_result` 块：
- `view.ts` 的 `SearchStep / SourceRegistry / 引用角标 / 底部来源` 全部直接复用；
- `history/toArchive.ts`、`toLocal.ts` 已有这些块的归档映射，**归档格式不用改**；
- 已存在 `canContinueReply` 对 `tool_use` 的禁用逻辑，语义一致。

归一化映射表：

| OpenCode/Anthropic 回调 | 内部块 |
| --- | --- |
| `tool_use{name:"web_search",input:{query}}` | `server_tool_use{name:"deepseek_web_search",input:{action:"search",queries:[query]},kind:"search"}` |
| SearXNG JSON 结果 | `web_search_tool_result{kind:"search",content:[web_search_result…]}` |
| `tool_use{name:"read_url",input:{url}}` | `server_tool_use{name:"deepseek_read_url",input:{action:"read_link",url},kind:"read_link"}` |
| 正文提取结果 | `web_fetch_tool_result{kind:"read_link",content:web_fetch_result}` |

反向映射只用于**本轮后续请求**：把内部块还原成 Anthropic `tool_use` / `tool_result` 消息。

**D3. 工具循环只在单轮内**
```
messages = [system, ...历史文本轮次, user]
for round in 0..2:
  stream(/messages, tools=[web_search,(read_url)])
  merge into reply（thinking / text / tool_use）
  if stop_reason != tool_use: break
  for each tool_use: 执行 → 追加内部结果块到 reply
  messages += assistant(tool_use 块) + user(tool_result 块)
```
- 历史轮次仍只回传正文（与现有 OpenCode 纯文本历史一致），避免把旧工具往返塞进上下文；
- 本轮工具往返只存在于本次请求的消息数组，不落库为 MessageParam；
- 单轮最多 3 次工具循环，防止死循环与费用失控。

**D4. 搜索执行：SearXNG JSON API**
- `GET https://aecci.net/searx/search?q=<query>&format=json`（同源，无需 key）
- 取 `results[]` 的 `title/url/content(摘要)/publishedDate/engine`，最多 8 条回传模型；
- 展示层用现有 `Source` 结构（`page_age`/`snippet`/`site_name` 从域名推导）。

**D5. read_url（阶段 2）**
- 方案 A（推荐）：新增 `127.0.0.1:8889` 小型 Node 正文提取代理（零依赖，仅用 fetch + HTML→文本），
  nginx `location /read-api/` 反代；带 SSRF 防护（拒绝私网/环回/云 metadata，跟随重定向时复检）。
- 方案 B（备选，最快）：nginx `/read-api/` 直接反代 `https://r.jina.ai/`（外部依赖）。

**D6. 设置与 UI**
- `provider=opencode` 时启用「智能搜索」开关（当前 `opencodeSearchUnavailable` 文案与禁用逻辑移除）；
- 思考块：Anthropic 端点已返回 thinking（无需额外参数），沿用现有渲染；
- 模型列表继续用 OpenCode `/models`（OpenAI 格式，现有缓存保留）。

## 3. 分阶段实施计划

### P0：Transport 与解析（半天）
| 文件 | 改动 |
| --- | --- |
| `src/services/api/anthropic.ts`（新增） | `streamAnthropicMessage(opts)`：baseUrl、apiKey、sessionId、headers、body；复用 sse/parseEvent/ApiError |
| `src/services/api/types.ts` | 增加客户端工具请求类型（tools/input_schema）、`AnthropicToolUseBlock`、`input_json_delta` 已存在 |
| `src/services/api/parseEvent.ts` | `tool_use` 返回结构化块；`input_json_delta` 解析 |

验收：用 `deepseek-v4.1-flash` 手写脚本能拿到 tool_use 流事件；DeepSeek 官方路径回归不变。

### P1：工具定义与执行（1 天）
| 文件 | 改动 |
| --- | --- |
| `src/services/chat/tools.ts`（新增） | 工具定义（web_search / read_url）、SearXNG 调用与结果归一化、反向映射 |
| `src/services/chat/opencodeLoop.ts`（新增） | Anthropic 请求 + 工具循环 + 回复归并（复用 reply.ts 的 applyEvent/settleReply） |
| `src/services/chat/reply.ts` | 支持在 tool_use 流过程中缓冲 input，结束后落为内部 `server_tool_use`；工具结果块追加 |
| `src/services/chat/store.ts` | opencode 分支改为调用 opencodeLoop；标题/停止/错误处理复用 |

验收：mock SearXNG（或直接连线上）跑通 web_search 全链路；thinking/text/搜索步骤渲染正确。

### P2：read_url 正文代理（半天，可选/可与 P1 并行）
| 文件 | 改动 |
| --- | --- |
| `deploy` / 服务器 | `/opt/dsh/app` 之外的独立小服务 `chat-reader`（systemd，127.0.0.1:8889）+ nginx `/read-api/` |
| `src/services/chat/tools.ts` | read_url 调 `/read-api/?url=...`，结果归一化为 `web_fetch_tool_result` |

验收：读取普通文章返回标题+正文（截断 8k 字符）；拒绝 127.0.0.1/私网/169.254.169.254。

### P3：设置/UI/文案（2 小时）
| 文件 | 改动 |
| --- | --- |
| `src/components/settings/SettingsDialog.tsx` | OpenCode 下启用搜索开关；说明文案改为「使用本地 SearXNG」 |
| `src/i18n/zh.ts` / `en.ts` | 移除/替换 `opencodeSearchUnavailable`，补充搜索来源文案 |

### P4：构建、部署、回归（半天）
1. `pnpm build`（rspack）→ `dist/`
2. tar-over-ssh 部署到 `/home/wwwroot/chat-demo`，chown nginx:nginx
3. 回归清单：
   - DeepSeek 官方：搜索/阅读/思考/续写/标题不变；
   - OpenCode：纯对话、深度思考、智能搜索（中英文查询）、tool_result 后正常收尾、停止生成；
   - 归档导出/导入含搜索步骤正常（复用旧映射）；
   - 移动端布局、访客 IP 页脚不受影响。
4. 提交：chat-demo `aecci` 分支；文档更新 `docs/deployment.md`（新增 `/searx`、`/read-api` 说明）。

## 4. 风险与对策

| 风险 | 对策 |
| --- | --- |
| OpenCode 各模型 tool 支持不一致 | 已实测 3 个；请求失败时回退为纯文本回答（去掉 tools 重试一次） |
| SearXNG 结果字段缺失（snippet/page_age） | 归一化时补默认值（`encrypted_content: ''`、`page_age: null`） |
| 工具循环放大 token/费用 | 单轮 ≤3 轮、每次结果 ≤8 条、正文截断 8k |
| 归档格式兼容 | 不改 schema，复用现有 server_tool_use/结果块映射；旧归档不受影响 |
| read_url SSRF | 拒绝私网/环回/链路本地/云 metadata；重定向后复检；响应体上限 2MB |
| 停止/错误状态 | 复用 reply.ts settleReply 与 AbortController |

## 5. 验收标准（Definition of Done）

- OpenCode 模式下打开「智能搜索」，提问需要实时信息的问题，UI 出现搜索步骤与来源，且回答基于来源；
- 「智能搜索」关闭时只发纯文本请求；
- DeepSeek 官方模式全功能无回归；
- `pnpm typecheck` / `pnpm lint` / `pnpm build` 通过；
- 线上部署后登录/对话/搜索/归档导入导出回归通过。
```

---

## 6. 补充：搜索限额兜底与 web_fetch 工具（移植 Reasonix / DSH）

### 6.1 背景

SearXNG 下游引擎（Google/Bing/DDG 等）是共享池，机房 IP 会触发 CAPTCHA/429（当前实测 DuckDuckGo 已 CAPTCHA，
Google CSE 正常）。当限额触发、搜索结果为空或质量下降时，模型需要另一条路：**自己抓取网页并解析正文**，
不依赖搜索引引擎配额。

### 6.2 照搬的两个实现

| 来源 | 文件 | 可移植点 |
| --- | --- | --- |
| Reasonix `dev/wails` | `internal/tool/builtin/webfetch.go` | 15s 超时、1 MiB 上限、`x/net/html` 提取正文、**拨号时 SSRF 防护**（解析 IP 后拒绝私网/环回/链路本地/云 metadata，重定向/重绑定也拦截）、JSON/纯文本原样返回 |
| DSH | `packages/web/tool-web/src/fetch.ts` | turndown 风格 HTML→Markdown、嵌套深度上限（`MAX_CONVERSION_DEPTH`）、GitHub 风格表格、`parseFetchArgs` 参数校验 |

### 6.3 工具集（OpenCode 模式）

| 工具 | 实现 | 说明 |
| --- | --- | --- |
| `web_search` | 浏览器 → 同源 `GET /searx/search?q=…&format=json` | 主路径；返回 title/url/snippet 列表（≤8 条） |
| `web_fetch` | 浏览器 → 同源 `GET /read-api/?url=…` → 服务端 reader | **限额兜底**：读取任意公开网页（搜索来源、用户给的链接、已知文档站） |
| `read_url` | 语义同 `web_fetch`，作为工具名别名 | 与 DeepSeek 的 `deepseek_read_url` 对齐 |

### 6.4 搜索降级链

1. `web_search` 请求 SearXNG，若 `results=0` 或 `unresponsive_engines` 覆盖主要引擎：
   用 `&engines=bing,google cse,wikipedia,…` 做一次引擎子集重试；
2. 仍失败 → 返回工具错误（含原因），模型可改用 `web_fetch` 抓取已知 URL；
3. 可选（配置了 DeepSeek 官方 key 时）：按 Reasonix 的「独立搜索请求」模式，用官方服务端搜索
   作为二级兜底（单独一次 Messages 请求，只返回 sources，不污染主对话历史）。

### 6.5 服务端 reader（新增，127.0.0.1:8889）

- Go 单文件服务（移植 Reasonix `webfetch.go`，`golang.org/x/net/html`，静态二进制）：
  `GET /?url=…` → `{url,title,text,truncated}`；`GET /healthz`。
- 安全：仅 http/https、DNS 解析后拒绝私网/环回/链路本地/组播/未指定地址（含 169.254.169.254）；
  重定向 ≤3 次且每次重新校验；响应体 ≤1 MiB；15s 超时；不携带 cookie/凭据。
- 部署：systemd `chat-reader.service`（专用用户、只读根文件系统、无网络特权），nginx
  `location /read-api/` 反代；browser 同源调用，无需 CORS。

---

## 7. retrieve_info（DeepSeek Responses 深度研究检索，2026-11-26 补充）

移植自 Reasonix `internal/tool/builtin/retrieve.go` 的个人实现，用于「利用 DeepSeek 服务端能力搜索信息」：

- **接口**：`POST https://api.deepseek.com/responses`（浏览器 CORS 已允许 `https://aecci.net`，无需再开代理）
- **模型**：`deepseek-v4-pro`（服务端 `web_search` 仅该模型支持）
- **服务端搜索**：`tools: [{ type: "web_search" }]`
- **结构化输出**：`text.format = { type: "json_schema", name: "knowledge_extract", schema }`，
  schema 约定 `answer` / `facts` / `sources[{title,url}]`（`name` 必填，否则 DeepSeek 返回 400）
- **鉴权**：使用用户配置的「DeepSeek 官方 API Key」；未配置时**不暴露**该工具，自动降级到
  SearXNG `web_search` + `web_fetch`
- **缓存**：浏览器内存缓存（同一问题 24h 内命中直接返回，最多 30 条），避免重复付费与延迟
- **UI 复用**：结果归一化为 `server_tool_use(kind=deep_search)` +
  `web_search_tool_result(kind=deep_search)`，直接复用现有「边想边搜/来源」渲染与归档
- **触发条件**：智能搜索开关打开即提供；工具列表 = `web_search` + `web_fetch` + `retrieve_info`
- **双模式**：
  - 配置了 DeepSeek 官方 Key → `POST https://api.deepseek.com/responses`（服务端 `web_search` + `json_schema`）
  - 只有 OpenCode Key → **客户端回退**：SearXNG 搜索 → `web_fetch` 抓取前 3 个来源 → OpenCode
    `/oc-api/responses` 按 `knowledge_extract` schema 综合（OpenCode Responses 实测支持协议与 json_schema，
    但**不执行**服务端 web_search，因此回退版由本地工具提供检索素材）
  - 该回退版已验证：`/searx` ×2 → `/read-api` ×4 → `/oc-api/responses` ×1 → 带来源的最终回答

> 说明：Reasonix 原版还包含 decompose/多级检索/蒸馏记忆/concept index 等完整管道；chat-demo 版本是
> 单次 Responses 深度研究检索 + 结果缓存的精简移植，保持与浏览器端一致的成本模型。

### 7.1 修复记录（2026-11-26）：官方 Responses 解析 + 自动回退

- 线上曾报 `retrieve_info: response did not contain structured knowledge`：根因是
  Responses 输出里同时存在 `reasoning`（`reasoning_text`）与 `message`（`output_text`），
  旧解析把思考文本一并拼进 JSON 导致 parse 失败。
- 抽出 `src/services/chat/retrieveParse.ts`：只收集 `message` 条目的 `output_text/text`，
  跳过 reasoning；并容忍前后解释文字、Markdown 代码块（提取首个配平 JSON 对象）。
- 官方路径解析失败时，若配置了 OpenCode Key，**自动降级**到本地检索+综合路径。
- 验证：解析器 7 组 fixture 单测通过；E2E「无效官方 Key + 有效 OpenCode Key」得到
  `401 → searx×2 → read-api×7 → oc-api/responses×2 → 带来源回答`。

### 7.2 输出上限（2026-11-26）：不再人为限制

- OpenCode 请求不再使用固定的 `max_tokens: 4096`；改为从 `/oc-api/models` 的
  `limit.output` 取**模型自身最大输出**（deepseek-v4.1-flash/pro 384000、grok-4.7 500000、
  glm-5.3 131072、claude-haiku-5-5 128000…），元数据不可用时兜底 131072。
- retrieve_info 本地综合移除 `max_output_tokens: 3000`，使用服务端默认/最大值。
- 上下文：模型 `limit.context` 大多为 1M tokens，chat-demo 不截断历史文本轮次。
- 仍保留的工具侧限制（非输出上限）：web_fetch 正文 16000 字符、工具结果 clip 12000 字符、
  搜索 8 条、工具循环最多 3 轮（可按需调整）。
- 验证：E2E 捕获请求体 `max_tokens: 384000`（deepseek-v4.1-flash）。

### 7.3 retrieve_info 来源数量（2026-11-26）：解除聚合上限

- 移除固定聚合上限：`retrieve_info` 默认读取/聚合**全部搜索结果**（实测一次 19~22 个网页），
  不再限制 5/8 个来源。
- 工具 schema 新增可选 `max_pages`：由模型按问题自行决定读多少页；省略则读全部结果，
  工具描述明确「no fixed upper limit」。
- 抓取改为 4 并发 + 超时 240s，避免来源变多后串行过慢。
- `sources` 不再按 8 条截断，retrieve 的工具结果也不再走 12000 字符 clip。
- 注：`web_search` 仍是搜索列表工具（8 条），二者定位不同。
- 验证：E2E 捕获「深度研究：19 个来源」、read-api 22 次。

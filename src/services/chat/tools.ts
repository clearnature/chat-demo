import { API_ORIGIN } from '../api/client.js'
import type {
  ClientToolDef,
  ClientToolUseBlock,
  ServerToolUseBlock,
  WebFetchToolResultBlock,
  WebSearchResult,
  WebSearchToolResultBlock,
} from '../api/types.js'
import type { ReplyBlock } from './types.js'
import {
  KNOWLEDGE_SCHEMA,
  parseKnowledge,
  readResponsesText,
  type RetrieveKnowledge,
} from './retrieveParse.js'

/**
 * OpenCode Anthropic 路径的客户端工具：web_search（本地 SearXNG）与 web_fetch（服务端正文抓取）。
 *
 * 归一化策略：把工具调用/结果映射成内部已有的 `server_tool_use` +
 * `web_search_tool_result` / `web_fetch_tool_result` 块，从而直接复用
 * view.ts 的搜索步骤、来源卡片与 history/toArchive、toLocal 的归档映射。
 */

/** 搜索最多回传的条数（限定 token 用量） */
const MAX_SEARCH_RESULTS = 8
/** 回传给模型的工具结果字符上限 */
const MAX_TOOL_CONTENT = 12000
/** SearXNG 主查询失败时换用的引擎子集（避开容易被 CAPTCHA 的主引擎） */
const FALLBACK_ENGINES = 'bing,wikipedia,mojeek,qwant'

export type ToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolOutcome = {
  /** 追加到回复里的内部结果块 */
  block: ReplyBlock
  /** 回传给模型的 tool_result 文本 */
  content: string
  ok: boolean
}

export const webSearchTool: ClientToolDef = {
  name: 'web_search',
  description:
    'Search the web and return titles, URLs and short snippets. Use it for recent or factual information, then cite the sources. Prefer this over guessing.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query, natural language is fine' },
    },
    required: ['query'],
  },
}

export const webFetchTool: ClientToolDef = {
  name: 'web_fetch',
  description:
    'Fetch an absolute http(s) URL and return its readable text content (HTML is reduced to text). Use it to read a page found by web_search, a documentation page, or a link provided by the user. Direct page fetch does not consume search-engine quota.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL beginning with http:// or https://' },
    },
    required: ['url'],
  },
}

/** 当前启用的工具定义；search 关闭时只提供 web_fetch（与 DeepSeek 始终声明 read_url 对齐） */
export const clientTools = (search: boolean): ClientToolDef[] =>
  search ? [webSearchTool, webFetchTool, retrieveInfoTool] : [webFetchTool]

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const clip = (value: string, limit = MAX_TOOL_CONTENT): string =>
  value.length > limit ? `${value.slice(0, limit)}…(truncated)` : value

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const getJSON = async (url: string, signal: AbortSignal): Promise<unknown> => {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) {
    throw new Error(`request failed: ${response.status}`)
  }
  return response.json()
}

type SearxResult = {
  url?: unknown
  title?: unknown
  content?: unknown
  publishedDate?: unknown
  engine?: unknown
}
type SearxResponse = { results?: SearxResult[]; unresponsive_engines?: [string, string][] }

const readSearx = (payload: unknown): SearxResponse => {
  if (payload === null || typeof payload !== 'object') {
    return {}
  }
  const value = payload as SearxResponse
  return { results: Array.isArray(value.results) ? value.results : [], unresponsive_engines: value.unresponsive_engines }
}

const searxURL = (query: string, engines?: string): string => {
  const params = new URLSearchParams({ q: query, format: 'json' })
  if (engines) {
    params.set('engines', engines)
  }
  return `/searx/search?${params.toString()}`
}

/** 工具调用 → 内部 server_tool_use 块（供 UI/历史复用） */
export const toServerToolUseBlock = (call: ToolCall): ServerToolUseBlock => {
  if (call.name === 'retrieve_info') {
    const query = text(call.input.query)
    return {
      type: 'server_tool_use',
      id: call.id,
      name: 'deepseek_web_search',
      input: { action: 'search', queries: query ? [query] : [] },
      caller: { type: 'direct' },
      kind: 'deep_search',
      clientTool: 'retrieve_info',
    }
  }
  if (call.name === 'web_fetch') {
    return {
      type: 'server_tool_use',
      id: call.id,
      name: 'deepseek_read_url',
      input: { action: 'read_link', url: text(call.input.url) },
      caller: { type: 'direct' },
      kind: 'read_link',
    }
  }
  const query = text(call.input.query)
  return {
    type: 'server_tool_use',
    id: call.id,
    name: 'deepseek_web_search',
    input: { action: 'search', queries: query ? [query] : [] },
    caller: { type: 'direct' },
    kind: 'search',
  }
}

/** 内部 server_tool_use 块 → 回传模型用的 tool_use 块 */
export const toToolUseParam = (call: ToolCall): ClientToolUseBlock => ({
  type: 'tool_use',
  id: call.id,
  name: call.name,
  input: call.input,
})

const failedSearch = (id: string, reason: string): ToolOutcome => {
  const block: WebSearchToolResultBlock = {
    type: 'web_search_tool_result',
    tool_use_id: id,
    content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
    kind: 'search',
  }
  return { block, content: JSON.stringify({ error: reason }), ok: false }
}

const failedFetch = (id: string, reason: string): ToolOutcome => {
  const block: WebFetchToolResultBlock = {
    type: 'web_fetch_tool_result',
    tool_use_id: id,
    kind: 'read_link',
    content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
  }
  return { block, content: JSON.stringify({ error: reason }), ok: false }
}

const toSearchResult = (item: SearxResult): WebSearchResult | null => {
  const url = text(item.url)
  if (!/^https?:\/\//i.test(url)) {
    return null
  }
  return {
    type: 'web_search_result',
    title: text(item.title) || url,
    url,
    snippet: text(item.content),
    site_icon: null,
    site_name: hostOf(url) || null,
    encrypted_content: '',
    page_age: text(item.publishedDate) || null,
  }
}

const executeSearch = async (call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> => {
  const query = text(call.input.query).trim()
  if (!query) {
    return failedSearch(call.id, 'web_search: query is required')
  }
  try {
    let data = readSearx(await getJSON(searxURL(query), signal))
    // 主查询没有结果（常见于引擎限流/CAPTCHA）时换一组引擎重试一次
    if (!data.results?.length) {
      data = readSearx(await getJSON(searxURL(query, FALLBACK_ENGINES), signal))
    }
    const items = (data.results ?? [])
      .map(toSearchResult)
      .filter((item): item is WebSearchResult => item !== null)
      .slice(0, MAX_SEARCH_RESULTS)
    if (items.length === 0) {
      return failedSearch(call.id, 'web_search: no results (engines may be rate limited)')
    }
    const block: WebSearchToolResultBlock = {
      type: 'web_search_tool_result',
      tool_use_id: call.id,
      content: items,
      kind: 'search',
    }
    const summary = items.map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
    }))
    return { block, content: clip(JSON.stringify({ results: summary })), ok: true }
  } catch (error) {
    return failedSearch(call.id, `web_search failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const executeFetch = async (call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> => {
  const raw = text(call.input.url).trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return failedFetch(call.id, 'web_fetch: invalid url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return failedFetch(call.id, 'web_fetch: only http(s) urls are supported')
  }
  try {
    const payload = (await getJSON(`/read-api/?url=${encodeURIComponent(url.toString())}`, signal)) as {
      url?: unknown
      title?: unknown
      text?: unknown
      truncated?: unknown
      error?: unknown
    }
    if (typeof payload.error === 'string') {
      return failedFetch(call.id, `web_fetch: ${payload.error}`)
    }
    const body = text(payload.text)
    if (!body) {
      return failedFetch(call.id, 'web_fetch: empty page content')
    }
    const finalURL = text(payload.url) || url.toString()
    const title = text(payload.title) || null
    const block: WebFetchToolResultBlock = {
      type: 'web_fetch_tool_result',
      tool_use_id: call.id,
      kind: 'read_link',
      content: {
        type: 'web_fetch_result',
        url: finalURL,
        content: {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: body },
          title,
        },
        published_at: null,
      },
    }
    const content = clip(`URL: ${finalURL}\nTitle: ${title ?? ''}\n\n${body}`)
    return { block, content, ok: true }
  } catch (error) {
    return failedFetch(call.id, `web_fetch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 执行一次工具调用，返回内部结果块与回传给模型的 tool_result 文本 */
export const executeToolCall = async (call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> => {
  if (call.name === 'retrieve_info') {
    return executeRetrieve(call, signal)
  }
  return call.name === 'web_fetch' ? executeFetch(call, signal) : executeSearch(call, signal)
}

// ---------------- retrieve_info（DeepSeek Responses 深度研究检索） ----------------

/**
 * 移植自 Reasonix `internal/tool/builtin/retrieve.go` 的 retrieve_info：
 * 用 DeepSeek 官方 Responses API + 服务端 web_search 做一次深度研究检索，
 * 用 json_schema 约束模型返回结构化知识（答案 / 关键事实 / 来源），并在浏览器内缓存。
 * 这是「利用 DeepSeek 服务端能力搜索信息」的高层入口；没有官方 Key 时不暴露。
 */

const RETRIEVE_MODEL = 'deepseek-v4-pro'
const RETRIEVE_CACHE_TTL = 24 * 60 * 60 * 1000
const RETRIEVE_CACHE_LIMIT = 30
const RETRIEVE_TIMEOUT = 120 * 1000

const retrieveCache = new Map<string, { at: number; value: RetrieveKnowledge }>()

export const retrieveInfoTool: ClientToolDef = {
  name: 'retrieve_info',
  description:
    'Deep research retrieval: returns a synthesized answer, key facts and cited sources. Uses DeepSeek server-side web search when an official key is configured, otherwise searches locally and reads the top pages. Slower/costlier than web_search; prefer web_search for simple or very recent lookups, and web_fetch for reading one specific page.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Research question or topic to investigate' },
    },
    required: ['query'],
  },
}

const readRetrieveCache = (query: string): RetrieveKnowledge | null => {
  const hit = retrieveCache.get(query)
  if (!hit) {
    return null
  }
  if (Date.now() - hit.at > RETRIEVE_CACHE_TTL) {
    retrieveCache.delete(query)
    return null
  }
  return hit.value
}

const writeRetrieveCache = (query: string, value: RetrieveKnowledge): void => {
  retrieveCache.set(query, { at: Date.now(), value })
  while (retrieveCache.size > RETRIEVE_CACHE_LIMIT) {
    const oldest = retrieveCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    retrieveCache.delete(oldest)
  }
}

type RetrieveConfig = {
  /** DeepSeek 官方 Key：有则走服务端深度研究（Responses + web_search） */
  officialApiKey: string
  /** OpenCode Key：无官方 Key 时走客户端回退（SearXNG + web_fetch + 结构化综合） */
  opencodeApiKey: string
  /** 当前 OpenCode 模型 */
  model: string
  /** x-opencode-session */
  sessionId: string
}

let retrieveConfig: RetrieveConfig = {
  officialApiKey: '',
  opencodeApiKey: '',
  model: '',
  sessionId: '',
}

const toRetrieveBlock = (call: ToolCall, knowledge: RetrieveKnowledge): WebSearchToolResultBlock => ({
  type: 'web_search_tool_result',
  tool_use_id: call.id,
  kind: 'deep_search',
  content: knowledge.sources.slice(0, MAX_SEARCH_RESULTS).map((source) => ({
    type: 'web_search_result' as const,
    title: source.title,
    url: source.url,
    snippet: '',
    site_icon: null,
    site_name: hostOf(source.url) || null,
    encrypted_content: '',
    page_age: null,
  })),
})

const retrieveRequest = (query: string, apiKey: string): RequestInit => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: RETRIEVE_MODEL,
    input: [
      {
        role: 'user',
        content: `请使用联网搜索深入研究下面的问题，返回结构化知识（answer/facts/sources），sources 必须是真实可访问的网页链接：\n\n${query}`,
      },
    ],
    tools: [{ type: 'web_search' }],
    text: {
      format: { type: 'json_schema', name: 'knowledge_extract', schema: KNOWLEDGE_SCHEMA },
    },
  }),
})

const executeRetrieveOfficial = async (
  call: ToolCall,
  query: string,
  signal: AbortSignal
): Promise<ToolOutcome> => {
  try {
    const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(RETRIEVE_TIMEOUT) : signal
    const combined =
      typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(`${API_ORIGIN}/responses`, {
      ...retrieveRequest(query, retrieveConfig.officialApiKey),
      signal: combined,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return failedSearch(call.id, `retrieve_info: upstream ${response.status} ${body.slice(0, 200)}`)
    }
    const payload: unknown = await response.json()
    const raw = readResponsesText(payload)
    const knowledge = parseKnowledge(raw)
    if (!knowledge) {
      return failedSearch(
        call.id,
        `retrieve_info: response did not contain structured knowledge (raw: ${raw.slice(0, 160)})`
      )
    }
    writeRetrieveCache(query, knowledge)
    return {
      block: toRetrieveBlock(call, knowledge),
      content: clip(JSON.stringify({ ...knowledge, cached: false, mode: 'official' })),
      ok: true,
    }
  } catch (error) {
    return failedSearch(
      call.id,
      `retrieve_info failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

// ---------------- retrieve_info 的 OpenCode 客户端回退 ----------------

/** 回退版最多抓取的网页正文数量 */
const LOCAL_RETRIEVE_FETCH_LIMIT = 3
/** 每个网页回传给综合模型的字符上限 */
const LOCAL_RETRIEVE_PAGE_CHARS = 4000

type GatherSource = { title: string; url: string; snippet: string }

/** 用 SearXNG 收集来源（复用 web_search 的引擎回退策略） */
const gatherSources = async (query: string, signal: AbortSignal): Promise<GatherSource[]> => {
  const read = async (engines: string): Promise<SearxResponse> =>
    readSearx(await getJSON(searxURL(query, engines || undefined), signal))
  let data = await read('')
  if (!data.results?.length) {
    data = await read(FALLBACK_ENGINES)
  }
  return (data.results ?? [])
    .map((item) => {
      const url = text(item.url)
      if (!/^https?:\/\//i.test(url)) {
        return null
      }
      return {
        title: text(item.title) || url,
        url,
        snippet: text(item.content),
      }
    })
    .filter((item): item is GatherSource => item !== null)
    .slice(0, MAX_SEARCH_RESULTS)
}

/** 抓取若干来源的正文（失败/空内容跳过） */
const gatherPages = async (
  sources: GatherSource[],
  signal: AbortSignal
): Promise<{ url: string; title: string; text: string }[]> => {
  const pages: { url: string; title: string; text: string }[] = []
  for (const source of sources.slice(0, LOCAL_RETRIEVE_FETCH_LIMIT)) {
    try {
      const payload = (await getJSON(
        `/read-api/?url=${encodeURIComponent(source.url)}`,
        signal
      )) as { url?: unknown; title?: unknown; text?: unknown }
      const body = text(payload.text)
      if (!body) {
        continue
      }
      pages.push({
        url: text(payload.url) || source.url,
        title: text(payload.title) || source.title,
        text: body.slice(0, LOCAL_RETRIEVE_PAGE_CHARS),
      })
    } catch {
      // 单个来源抓取失败不影响整体
    }
  }
  return pages
}

/** 调 OpenCode Responses API 做结构化综合（不支持 json_schema 时退化为提示 JSON） */
const synthesizeKnowledge = async (
  query: string,
  sources: GatherSource[],
  pages: { url: string; title: string; text: string }[],
  signal: AbortSignal
): Promise<RetrieveKnowledge | null> => {
  const parts: string[] = [
    '你是深度研究助手。基于下面提供的搜索结果与网页正文，回答研究问题并只输出结构化知识。',
    'sources 只能使用下面出现过的 URL，不得编造。',
    `\n研究问题：${query}`,
    '\n搜索结果：',
    ...sources.map((source, index) => `${index + 1}. ${source.title} — ${source.url}\n   摘要：${source.snippet}`),
  ]
  if (pages.length > 0) {
    parts.push('\n网页正文：')
    for (const page of pages) {
      parts.push(`\n【${page.title}】 ${page.url}\n${page.text}`)
    }
  }
  parts.push('\n请输出 JSON：{"answer":"...","facts":["..."],"sources":[{"title":"...","url":"..."}]}')
  const prompt = parts.join('\n')

  const body = {
    model: retrieveConfig.model,
    input: [{ role: 'user', content: prompt }],
    max_output_tokens: 3000,
    text: {
      format: { type: 'json_schema', name: 'knowledge_extract', schema: KNOWLEDGE_SCHEMA },
    },
  }
  const timeout =
    typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(RETRIEVE_TIMEOUT) : signal
  const combined =
    typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${retrieveConfig.opencodeApiKey}`,
    'x-opencode-session': retrieveConfig.sessionId,
  }

  const requestOnce = async (payload: unknown): Promise<RetrieveKnowledge | null> => {
    const response = await fetch('/oc-api/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: combined,
    })
    if (!response.ok) {
      return null
    }
    const result: unknown = await response.json()
    return parseKnowledge(readResponsesText(result))
  }

  const structured = await requestOnce(body)
  if (structured) {
    return structured
  }
  // 部分模型不支持 json_schema：退化为“只输出 JSON”的提示
  return requestOnce({
    model: retrieveConfig.model,
    input: [{ role: 'user', content: `${prompt}\n\n只输出 JSON，不要任何解释或 Markdown 代码块。` }],
    max_output_tokens: 3000,
  })
}

/** 无官方 Key 时的客户端回退：SearXNG → web_fetch → OpenCode 结构化综合 */
const executeRetrieveLocal = async (
  call: ToolCall,
  query: string,
  signal: AbortSignal
): Promise<ToolOutcome> => {
  try {
    const sources = await gatherSources(query, signal)
    if (sources.length === 0) {
      return failedSearch(
        call.id,
        'retrieve_info: local search returned no results (engines may be rate limited); try web_fetch with a known URL'
      )
    }
    const pages = await gatherPages(sources, signal)
    const knowledge = await synthesizeKnowledge(query, sources, pages, signal)
    if (!knowledge) {
      return failedSearch(call.id, 'retrieve_info: synthesis failed (model unavailable or invalid JSON)')
    }
    const finalKnowledge: RetrieveKnowledge =
      knowledge.sources.length > 0
        ? knowledge
        : {
            ...knowledge,
            sources: sources
              .slice(0, LOCAL_RETRIEVE_FETCH_LIMIT)
              .map(({ title, url }) => ({ title, url })),
          }
    writeRetrieveCache(query, finalKnowledge)
    return {
      block: toRetrieveBlock(call, finalKnowledge),
      content: clip(JSON.stringify({ ...finalKnowledge, cached: false, mode: 'local' })),
      ok: true,
    }
  } catch (error) {
    return failedSearch(
      call.id,
      `retrieve_info (local) failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

const executeRetrieve = async (call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> => {
  const query = text(call.input.query).trim()
  if (!query) {
    return failedSearch(call.id, 'retrieve_info: query is required')
  }
  const cached = readRetrieveCache(query)
  if (cached) {
    return {
      block: toRetrieveBlock(call, cached),
      content: clip(JSON.stringify({ ...cached, cached: true })),
      ok: true,
    }
  }
  if (retrieveConfig.officialApiKey) {
    const official = await executeRetrieveOfficial(call, query, signal)
    if (official.ok) {
      return official
    }
    // 官方 Responses 未返回结构化知识时，自动降级到本地检索 + 综合
    if (retrieveConfig.opencodeApiKey) {
      return executeRetrieveLocal(call, query, signal)
    }
    return official
  }
  if (retrieveConfig.opencodeApiKey) {
    return executeRetrieveLocal(call, query, signal)
  }
  return failedSearch(call.id, 'retrieve_info: no API key configured; use web_search/web_fetch instead')
}

/** 注入 retrieve_info 的凭据与当前模型（由 opencodeLoop 在每次请求前调用） */
export const configureRetrieve = (config: Partial<RetrieveConfig>): void => {
  retrieveConfig = { ...retrieveConfig, ...config }
}

/** 是否有可用凭据（官方 Key 或 OpenCode Key） */
export const hasRetrieveCredentials = (): boolean =>
  retrieveConfig.officialApiKey.trim().length > 0 || retrieveConfig.opencodeApiKey.trim().length > 0

export const retrieveInfoAvailable = (): boolean => hasRetrieveCredentials()

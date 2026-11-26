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
export const clientTools = (search: boolean, officialApiKey = ''): ClientToolDef[] => {
  if (!search) {
    return [webFetchTool]
  }
  // retrieve_info 依赖 DeepSeek 官方 Responses API，没有官方 Key 时不暴露该工具
  return officialApiKey ? [webSearchTool, webFetchTool, retrieveInfoTool] : [webSearchTool, webFetchTool]
}

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

type RetrieveSource = { title: string; url: string }
type RetrieveKnowledge = {
  answer: string
  facts: string[]
  sources: RetrieveSource[]
}

const KNOWLEDGE_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: '综合答案（Markdown，包含关键结论）' },
    facts: { type: 'array', items: { type: 'string' }, description: '关键事实列表' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, url: { type: 'string' } },
        required: ['title', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['answer', 'facts', 'sources'],
  additionalProperties: false,
} as const

export const retrieveInfoTool: ClientToolDef = {
  name: 'retrieve_info',
  description:
    'Deep research retrieval backed by DeepSeek server-side web search. Use for research questions that need authoritative multi-source synthesis; returns a synthesized answer, key facts and cited sources. Slower/costlier than web_search; prefer web_search for simple or very recent lookups, and web_fetch for reading one specific page.',
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

/** 从 Responses API 输出里取 JSON 文本（output_text 或 message content） */
const readResponsesText = (payload: unknown): string => {
  if (payload === null || typeof payload !== 'object') {
    return ''
  }
  const value = payload as { output_text?: unknown; output?: unknown }
  if (typeof value.output_text === 'string') {
    return value.output_text
  }
  if (!Array.isArray(value.output)) {
    return ''
  }
  const parts: string[] = []
  for (const item of value.output) {
    if (item === null || typeof item !== 'object') {
      continue
    }
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      if (block !== null && typeof block === 'object') {
        const textValue = (block as { text?: unknown }).text
        if (typeof textValue === 'string') {
          parts.push(textValue)
        }
      }
    }
  }
  return parts.join('\n')
}

const parseKnowledge = (raw: string): RetrieveKnowledge | null => {
  const textValue = raw.trim()
  if (!textValue) {
    return null
  }
  // 模型可能包裹 Markdown 代码块
  const json = textValue.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const value: unknown = JSON.parse(json)
    if (value === null || typeof value !== 'object') {
      return null
    }
    const record = value as { answer?: unknown; facts?: unknown; sources?: unknown }
    const answer = text(record.answer)
    if (!answer) {
      return null
    }
    const facts = Array.isArray(record.facts) ? record.facts.map(text).filter(Boolean) : []
    const sources = Array.isArray(record.sources)
      ? record.sources
          .map((item) => {
            if (item === null || typeof item !== 'object') {
              return null
            }
            const source = item as { title?: unknown; url?: unknown }
            const url = text(source.url)
            if (!/^https?:\/\//i.test(url)) {
              return null
            }
            return { title: text(source.title) || url, url }
          })
          .filter((item): item is RetrieveSource => item !== null)
      : []
    return { answer, facts, sources }
  } catch {
    return null
  }
}

const retrieveRequest = (query: string): RequestInit => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${retrieveApiKey}`,
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

let retrieveApiKey = ''

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

const executeRetrieve = async (call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> => {
  const query = text(call.input.query).trim()
  if (!query) {
    return failedSearch(call.id, 'retrieve_info: query is required')
  }
  if (!retrieveApiKey) {
    return failedSearch(call.id, 'retrieve_info: DeepSeek official API key is not configured; use web_search/web_fetch instead')
  }
  const cached = readRetrieveCache(query)
  if (cached) {
    return {
      block: toRetrieveBlock(call, cached),
      content: clip(JSON.stringify({ ...cached, cached: true })),
      ok: true,
    }
  }
  try {
    const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(RETRIEVE_TIMEOUT) : signal
    const combined =
      typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(`${API_ORIGIN}/responses`, {
      ...retrieveRequest(query),
      signal: combined,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return failedSearch(call.id, `retrieve_info: upstream ${response.status} ${body.slice(0, 200)}`)
    }
    const payload: unknown = await response.json()
    const knowledge = parseKnowledge(readResponsesText(payload))
    if (!knowledge) {
      return failedSearch(call.id, 'retrieve_info: response did not contain structured knowledge')
    }
    writeRetrieveCache(query, knowledge)
    return {
      block: toRetrieveBlock(call, knowledge),
      content: clip(JSON.stringify({ ...knowledge, cached: false })),
      ok: true,
    }
  } catch (error) {
    return failedSearch(
      call.id,
      `retrieve_info failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * 设置 retrieve_info 使用的 DeepSeek 官方 Key（由 opencodeLoop 在每次请求前注入）。
 * 空字符串表示未配置，此时执行会返回 needs_grant 类错误，由模型降级到 web_search/web_fetch。
 */
export const configureRetrieve = (apiKey: string): void => {
  retrieveApiKey = apiKey
}

/** 供 opencodeLoop 判断是否暴露 retrieve_info */
export const hasOfficialKey = (apiKey: string): boolean => apiKey.trim().length > 0


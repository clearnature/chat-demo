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
export const clientTools = (search: boolean): ClientToolDef[] =>
  search ? [webSearchTool, webFetchTool] : [webFetchTool]

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
export const executeToolCall = async (call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> =>
  call.name === 'web_fetch' ? executeFetch(call, signal) : executeSearch(call, signal)

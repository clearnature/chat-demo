import { ApiError, readErrorResponse, request } from './client.js'
import { readServerSentEvents } from './sse.js'
import type { MessageUsage } from './types.js'

/**
 * OpenCode Go（OpenAI Chat Completions 兼容）客户端。
 *
 * opencode.ai 不支持浏览器跨域（预检 404），因此浏览器统一请求本站的
 * `/oc-api/` 同源反向代理（nginx → https://opencode.ai/zen/go/v1/）。
 * 流式为 `data: {...}` 的 OpenAI 分块，正文在 delta.content，思考在
 * delta.reasoning_content，以 `data: [DONE]` 结束。
 */

/** 同源反向代理前缀，见部署文档 */
export const OPENCODE_BASE_URL = '/oc-api'
/** OpenCode Go 上的 DeepSeek V4.1 Flash 模型 ID */
export const OPENCODE_DEFAULT_MODEL = 'deepseek-v4.1-flash'
/** Go 要求每个会话携带稳定的 x-opencode-session，用于路由与缓存 */
const SESSION_HEADER = 'x-opencode-session'

export type OpenCodeMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type OpenCodeUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export type OpenCodeChunk = {
  choices?: {
    index?: number
    delta?: { role?: string; content?: string | null; reasoning_content?: string | null }
    finish_reason?: string | null
  }[]
  usage?: OpenCodeUsage
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readUsage = (value: unknown): OpenCodeUsage | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const cached = value.prompt_tokens_details
  return {
    prompt_tokens: typeof value.prompt_tokens === 'number' ? value.prompt_tokens : undefined,
    completion_tokens: typeof value.completion_tokens === 'number' ? value.completion_tokens : undefined,
    prompt_tokens_details: isRecord(cached)
      ? { cached_tokens: typeof cached.cached_tokens === 'number' ? cached.cached_tokens : 0 }
      : undefined,
  }
}

const readChunk = (value: unknown): OpenCodeChunk | null => {
  if (!isRecord(value)) {
    return null
  }
  const usage = readUsage(value.usage)
  const choices = Array.isArray(value.choices)
    ? value.choices.flatMap((choice) => {
        if (!isRecord(choice)) {
          return []
        }
        const delta = isRecord(choice.delta)
          ? {
              role: typeof choice.delta.role === 'string' ? choice.delta.role : undefined,
              content: typeof choice.delta.content === 'string' ? choice.delta.content : null,
              reasoning_content:
                typeof choice.delta.reasoning_content === 'string'
                  ? choice.delta.reasoning_content
                  : null,
            }
          : undefined
        return [
          {
            index: typeof choice.index === 'number' ? choice.index : 0,
            delta,
            finish_reason:
              typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
          },
        ]
      })
    : undefined
  return { choices, usage }
}

/** 把 OpenAI 的 usage 映射成本地消息模型的用量字段 */
export const toMessageUsage = (usage: OpenCodeUsage | undefined): MessageUsage | undefined => {
  if (!usage) {
    return undefined
  }
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
  }
}

/** OpenCode Go 返回的模型条目（只取界面需要的字段） */
export type OpenCodeModel = {
  id: string
  /** 服务端展示名；缺省时界面回退为 id */
  name: string | null
}

/** 模型列表短时缓存，避免每次打开设置都请求 */
const MODEL_CACHE_MS = 5 * 60 * 1000
let modelCache: { apiKey: string; at: number; models: OpenCodeModel[] } | null = null

const readModels = (payload: unknown): OpenCodeModel[] => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ApiError('protocol', 'Invalid model list response')
  }
  const models: OpenCodeModel[] = []
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      continue
    }
    // 只保留可对话模型；没有 type 字段的服务端视为可用
    if (typeof item.type === 'string' && item.type !== 'chat') {
      continue
    }
    models.push({ id: item.id, name: typeof item.name === 'string' ? item.name : null })
  }
  return models
}

/** 获取 OpenCode Go 的可用模型列表；force 为 true 时跳过缓存 */
export const fetchOpenCodeModels = async (
  apiKey: string,
  { signal, force = false }: { signal?: AbortSignal; force?: boolean } = {}
): Promise<OpenCodeModel[]> => {
  if (!force && modelCache && modelCache.apiKey === apiKey && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return modelCache.models
  }
  const response = await request(`${OPENCODE_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  const models = readModels(await response.json())
  modelCache = { apiKey, at: Date.now(), models }
  return models
}

/** 用 GET /models 校验 Key（不产生生成费用），失败抛 ApiError */
export const verifyOpenCodeApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(`${OPENCODE_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

export type OpenCodeStreamOptions = {
  apiKey: string
  /** 会话 ID，作为 x-opencode-session 的稳定值 */
  sessionId: string
  model: string
  messages: OpenCodeMessage[]
  /** 开启深度思考时传 high，关闭时传 low */
  reasoningEffort?: 'low' | 'high'
  signal: AbortSignal
}

/**
 * POST /chat/completions（stream: true），逐个产出分块。
 * 非 2xx 抛 ApiError('http')，流内错误帧抛 ApiError('stream')，
 * 没收到 [DONE] 就断流抛 ApiError('interrupted')。
 */
export async function* streamOpenCodeMessage({
  apiKey,
  sessionId,
  model,
  messages,
  reasoningEffort,
  signal,
}: OpenCodeStreamOptions): AsyncGenerator<OpenCodeChunk> {
  const response = await request(`${OPENCODE_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      [SESSION_HEADER]: sessionId,
    },
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    const text = data.trim()
    if (text === '[DONE]') {
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      continue
    }
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
      throw new ApiError('stream', payload.error.message)
    }
    const chunk = readChunk(payload)
    if (chunk) {
      yield chunk
    }
  }
  // 没有 [DONE] 也没有错误帧：连接提前结束
  throw new ApiError('interrupted', '')
}

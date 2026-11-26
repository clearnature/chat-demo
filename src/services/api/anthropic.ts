import { ApiError, readErrorResponse, request } from './client.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  AnthropicMessage,
  ClientToolDef,
  MessageStreamEvent,
} from './types.js'

/**
 * 通用 Anthropic Messages API 流式客户端。
 *
 * DeepSeek 官方（`/anthropic/v1/messages`）与 OpenCode Go（`/oc-api/messages`）
 * 共用同一套 SSE 事件格式，差异只在 baseUrl 与鉴权/会话头：
 * - 鉴权：`x-api-key`（OpenCode Go 也接受）
 * - `anthropic-version: 2023-06-01`
 * - OpenCode Go 额外要求 `x-opencode-session`（缺失会返回 MissingSessionID）
 *
 * 事件解析复用 `parseEvent.ts`，错误处理复用 `client.ts`，不复制协议实现。
 */

export type AnthropicTransport = {
  /** 不带结尾斜杠的消息端点前缀，例如 `/oc-api` 或 `https://api.deepseek.com/anthropic/v1` */
  baseUrl: string
  apiKey: string
  /** OpenCode Go 的会话路由头；DeepSeek 官方不传 */
  sessionId?: string
  /** 额外的业务请求头 */
  headers?: Record<string, string>
}

export type AnthropicRequestBody = {
  model: string
  max_tokens: number
  system?: string
  messages: AnthropicMessage[]
  tools?: ClientToolDef[]
  thinking?: { type: 'enabled'; budget_tokens?: number } | { type: 'disabled' }
  temperature?: number
  /** 强制模型调用指定工具（Anthropic Messages 协议） */
  tool_choice?: { type: 'tool'; name: string } | { type: 'any' } | { type: 'auto' }
  [key: string]: unknown
}

const baseHeaders = (transport: AnthropicTransport): Record<string, string> => ({
  'x-api-key': transport.apiKey,
  'anthropic-version': '2023-06-01',
  'Content-Type': 'application/json',
  Accept: 'text/event-stream',
  ...(transport.sessionId ? { 'x-opencode-session': transport.sessionId } : {}),
  ...transport.headers,
})

/**
 * POST `{baseUrl}/messages`（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * 非 2xx 抛 `ApiError('http')`，流内错误帧抛 `ApiError('stream')`，
 * 没收到 message_stop 就断流抛 `ApiError('interrupted')`。
 */
export async function* streamAnthropicMessage(
  transport: AnthropicTransport,
  body: AnthropicRequestBody,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${transport.baseUrl}/messages`, {
    method: 'POST',
    headers: baseHeaders(transport),
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (
      payload !== null &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof (payload as { error?: { message?: unknown } }).error?.message === 'string'
    ) {
      throw new ApiError('stream', (payload as { error: { message: string } }).error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  throw new ApiError('interrupted', '')
}

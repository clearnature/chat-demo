import { streamAnthropicMessage } from '../api/anthropic.js'
import { outputLimitForModel } from '../api/opencode.js'
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  MessageStreamEvent,
  ToolResultParam,
} from '../api/types.js'
import { toOpenCodeMessages } from './opencode.js'
import { createId } from '../../utils/id.js'
import { applyEvent, settleReply } from './reply.js'
import {
  clientTools,
  configureRetrieve,
  executeToolCall,
  toServerToolUseBlock,
  toToolUseParam,
  type ToolCall,
  type ToolOutcome,
} from './tools.js'
import type { AssistantMessage, Message, UserMessage } from './types.js'

/**
 * OpenCode（Anthropic Messages 路径）的回复循环：
 *
 * 1. 用现有 OpenCode 文本历史构造 Anthropic messages（system 单独传）；
 * 2. 流式请求 `/oc-api/messages`，复用 reply.applyEvent 归并 thinking/text；
 * 3. `tool_use` 在流式过程中缓冲 input，结束后落为内部 `server_tool_use` 块；
 * 4. stop_reason=tool_use 时执行客户端工具（SearXNG 搜索 / 服务端正文抓取），
 *    把结果块追加到回复，并把 tool_use/tool_result 追加进本轮请求后继续；
 * 5. 最多 3 轮，正常结束（end_turn/max_tokens）或失败/停止时由调用方收尾。
 */

/** 单轮对话内最多执行几次工具往返 */
const MAX_TOOL_ROUNDS = 3
/** 模型元数据不可用时的输出上限兜底（不主动限制；元数据可用时按模型最大值） */
const FALLBACK_MAX_OUTPUT_TOKENS = 131072

export type OpenCodeLoopSettings = {
  apiKey: string
  model: string
  /** 稳定会话 ID，作为 x-opencode-session */
  sessionId: string
  /** 是否启用智能搜索（web_search）；web_fetch 始终可用 */
  search: boolean
  /** DeepSeek 官方 API Key（配置后额外提供 retrieve_info 深度研究检索） */
  officialApiKey: string
  /** 系统提示词 */
  system: string
}

export type OpenCodeLoopRequest = {
  initial: AssistantMessage
  history: Message[]
  question: UserMessage
  settings: OpenCodeLoopSettings
  signal: AbortSignal
  /** 每收到一个事件/完成一次工具执行后回调，由调用方节流刷新界面 */
  onUpdate: (reply: AssistantMessage) => void
}

type PendingTool = { index: number; id: string; name: string; args: string }

const parseArgs = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) {
    return {}
  }
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** 构造 Anthropic 请求消息：system 单独返回，历史与提问按文本轮次保留 */
const buildMessages = (request: OpenCodeLoopRequest): { system: string; messages: AnthropicMessage[] } => {
  const converted = toOpenCodeMessages(request.history, request.question, request.settings.system)
  const system = converted[0]?.role === 'system' ? converted[0].content : request.settings.system
  const messages: AnthropicMessage[] = converted.slice(1).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content,
  }))
  return { system, messages }
}

export const runOpenCodeReply = async (request: OpenCodeLoopRequest): Promise<AssistantMessage> => {
  const { settings, signal, onUpdate } = request
  configureRetrieve({
    officialApiKey: settings.officialApiKey,
    opencodeApiKey: settings.apiKey,
    model: settings.model,
    sessionId: settings.sessionId,
  })
  const transport = {
    baseUrl: '/oc-api',
    apiKey: settings.apiKey,
    sessionId: settings.sessionId,
  }
  const { system, messages } = buildMessages(request)
  // 不人为限制输出：按模型声明的最大输出 tokens；拿不到元数据时用高值兜底
  const maxOutputTokens =
    (await outputLimitForModel(settings.apiKey, settings.model, signal)) ?? FALLBACK_MAX_OUTPUT_TOKENS
  let reply = request.initial
  onUpdate(reply)

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const blockIndexes = new Map<number, number>()
    const pending = new Map<number, PendingTool>()
    const calls: ToolCall[] = []
    let roundText = ''

    const handleToolEvent = (event: MessageStreamEvent): boolean => {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        pending.set(event.index, {
          index: event.index,
          id: event.content_block.id,
          name: event.content_block.name,
          args: '',
        })
        return true
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        const current = pending.get(event.index)
        if (current) {
          current.args += event.delta.partial_json
        }
        return true
      }
      if (event.type === 'content_block_stop') {
        const current = pending.get(event.index)
        if (!current) {
          return false
        }
        pending.delete(event.index)
        const call: ToolCall = {
          id: current.id,
          name: current.name,
          input: parseArgs(current.args),
        }
        calls.push(call)
        reply = { ...reply, blocks: [...reply.blocks, toServerToolUseBlock(call)] }
        return true
      }
      return false
    }

    const events = streamAnthropicMessage(
      transport,
      {
        model: settings.model,
        max_tokens: maxOutputTokens,
        system,
        messages,
        tools: clientTools(settings.search),
      },
      signal
    )
    for await (const event of events) {
      if (signal.aborted) {
        return settleReply(reply, 'stopped', Date.now())
      }
      if (handleToolEvent(event)) {
        onUpdate(reply)
        continue
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        roundText += event.delta.text
      }
      reply = applyEvent(reply, event, Date.now(), blockIndexes)
      onUpdate(reply)
    }

    if (signal.aborted) {
      return settleReply(reply, 'stopped', Date.now())
    }
    // 没有工具调用（或模型选择直接回答）→ 正常结束
    if (reply.stopReason !== 'tool_use' || calls.length === 0) {
      return settleReply(reply, 'done', Date.now())
    }
    // 已经是最后一轮：保留工具调用结果，但不再回传，避免超出轮次预算
    if (round + 1 >= MAX_TOOL_ROUNDS) {
      return settleReply(reply, 'done', Date.now())
    }

    // 执行工具并把结果块追加到回复（UI 从 wip 变为 done/failed）
    const outcomes: ToolOutcome[] = []
    for (const call of calls) {
      const outcome = await executeToolCall(call, signal)
      outcomes.push(outcome)
      reply = { ...reply, blocks: [...reply.blocks, outcome.block] }
      onUpdate(reply)
      if (signal.aborted) {
        return settleReply(reply, 'stopped', Date.now())
      }
    }

    // 组装下一轮请求：assistant(tool_use) + user(tool_result)
    const assistantContent: AnthropicContentBlock[] = []
    if (roundText.trim()) {
      assistantContent.push({ type: 'text', text: roundText })
    }
    assistantContent.push(...calls.map(toToolUseParam))
    messages.push({ role: 'assistant', content: assistantContent })
    const results: ToolResultParam[] = calls.map((call, index) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: outcomes[index]?.content ?? '',
    }))
    messages.push({ role: 'user', content: results })
  }

  return settleReply(reply, 'done', Date.now())
}

/** 会话标题兜底：用首条提问（与原 OpenCode 分支一致） */
export const fallbackTitle = (question: UserMessage): string => question.content.trim().slice(0, 30)

export { createId }

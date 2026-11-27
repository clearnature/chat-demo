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
 * 5. 工具轮次上限 100 轮、总时长上限 30 分钟；到上限后进入总结轮输出分步答案。
 */

/** 单轮对话内最多执行几次工具往返 */
const MAX_TOOL_ROUNDS = 100
/** 模型元数据不可用时的输出上限兜底（不主动限制；元数据可用时按模型最大值） */
const FALLBACK_MAX_OUTPUT_TOKENS = 131072
/** 单次回复总时长上限（30 分钟）：到点后不再调用工具，直接进入总结轮 */
const MAX_WALL_TIME_MS = 30 * 60 * 1000
/** 在浏览器沙箱执行、不需要内部 server_tool_use 块的工具 */
const SANDBOX_TOOLS = new Set(['python_sandbox', 'render_frontend_artifact'])

/**
 * 从用户提问中识别「必须产出画布/沙箱结果」的意图。
 * 返回需要强制调用的工具名；普通问答返回 null，保持自动工具选择。
 */
const requiredCanvasTool = (question: string): 'render_frontend_artifact' | 'python_sandbox' | null => {
  const text = question.toLowerCase()
  if (text.includes('render_frontend_artifact')) {
    return 'render_frontend_artifact'
  }
  if (text.includes('python_sandbox') || text.includes('pyodide')) {
    return 'python_sandbox'
  }
  const action = /(用|写|做|生成|渲染|画|创建|实现|演示|跑|执行|计算|build|create|render|show|make|run|plot)/i
  const canvas = /(画布|canvas|3d|three\.?js|粒子|动画|可视化|前端产物|katex|mhchem|公式|页面|演示)/i
  const python = /(python|matplotlib|numpy|pandas|绘图|曲线|科学计算)/i
  if (python.test(text) && action.test(question)) {
    return 'python_sandbox'
  }
  if (canvas.test(text) && action.test(question)) {
    return 'render_frontend_artifact'
  }
  return null
}

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
  // 工作流：渲染类请求强制调用对应工具；若模型仍只回文字，追加一次重试提醒
  const forcedTool = requiredCanvasTool(request.question.content)
  let toolChoice: { type: 'tool'; name: string } | undefined = forcedTool
    ? { type: 'tool', name: forcedTool }
    : undefined
  let repaired = false
  const startedAt = Date.now()

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    // 总结轮：轮次用尽或超过 30 分钟时，不再提供工具，要求模型输出分步最终答案
    const timeUp = Date.now() - startedAt >= MAX_WALL_TIME_MS
    const summaryRound = round === MAX_TOOL_ROUNDS || timeUp
    if (summaryRound) {
      messages.push({
        role: 'user',
        content: '请基于以上工具执行结果，给出分步最终回答（1. 2. 3. …，每步给结论与依据），不要再调用工具。',
      })
    }
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
        if (SANDBOX_TOOLS.has(call.name)) {
          const input = call.input
          const code =
            call.name === 'python_sandbox'
              ? String(input.code ?? '')
              : String(input.html_js_code ?? '')
          const language =
            call.name === 'render_frontend_artifact'
              ? (() => {
                  const value = String(input.language ?? '').toLowerCase()
                  return value === 'typescript' || value === 'ts'
                    ? 'typescript'
                    : value === 'javascript' || value === 'js'
                      ? 'javascript'
                      : 'html'
                })()
              : undefined
          reply = {
            ...reply,
            blocks: [
              ...reply.blocks,
              {
                type: 'sandbox',
                id: call.id,
                kind: call.name === 'python_sandbox' ? 'python' : 'html',
                ...(call.name === 'render_frontend_artifact'
                  ? { title: String(input.title ?? '') || 'Frontend artifact', language }
                  : {}),
                code,
                status: 'running',
                createdAt: Date.now(),
              },
            ],
          }
        } else {
          reply = { ...reply, blocks: [...reply.blocks, toServerToolUseBlock(call)] }
        }
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
        tools: summaryRound ? [] : clientTools(settings.search),
        ...(!summaryRound && toolChoice ? { tool_choice: toolChoice } : {}),
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
      // 工作流兜底：本应产出画布，但模型只回了文字 → 追加一次明确的工具调用要求
      if (forcedTool && !repaired) {
        repaired = true
        if (roundText.trim()) {
          messages.push({ role: 'assistant', content: [{ type: 'text', text: roundText }] })
        }
        messages.push({
          role: 'user',
          content: `请调用 ${forcedTool} 工具完成渲染/执行，必须提供工具参数；不要只返回文字说明或声称已渲染。`,
        })
        continue
      }
      return settleReply(reply, 'done', Date.now())
    }
    // 工具调用已经发生，后续轮次恢复自动选择
    toolChoice = undefined
    // 执行工具并把结果块追加到回复（UI 从 wip 变为 done/failed）
    const outcomes: ToolOutcome[] = []
    for (const call of calls) {
      const outcome = await executeToolCall(call, signal)
      outcomes.push(outcome)
      const existing = reply.blocks.some(
        (block) => block.type === 'sandbox' && block.id === call.id
      )
      reply = {
        ...reply,
        blocks: existing
          ? reply.blocks.map((block) =>
              block.type === 'sandbox' && block.id === call.id ? outcome.block : block
            )
          : [...reply.blocks, outcome.block],
      }
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

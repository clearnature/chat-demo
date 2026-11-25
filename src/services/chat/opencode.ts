import { toMessageUsage, type OpenCodeChunk, type OpenCodeMessage } from '../api/opencode.js'
import type { AssistantMessage, Message, ReplyBlock, UserMessage } from './types.js'

/**
 * 本地消息模型 ↔ OpenAI Chat Completions 的转换。
 *
 * 与 DeepSeek Messages API 不同，OpenAI 兼容协议没有服务端工具、签名、
 * latest_reminder 与标题扩展，因此这里只保留纯文本轮次：历史里的思考、
 * 搜索/阅读链接块都不回传，附件也不进入请求（UI 在该模式下禁用附件）。
 */

/** 流式归并时记录当前打开的思考块与正文块在 blocks 中的下标 */
export type OpenCodeStreamState = {
  thinking: number | null
  text: number | null
}

export const createOpenCodeStreamState = (): OpenCodeStreamState => ({
  thinking: null,
  text: null,
})

const textOf = (message: AssistantMessage) =>
  message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

/** 历史轮次：提问只取正文，回答只取文本块；没有文本的回答（报错/空回复）跳过 */
export const toOpenCodeMessages = (
  history: Message[],
  question: UserMessage,
  system: string
): OpenCodeMessage[] => {
  const messages: OpenCodeMessage[] = [{ role: 'system', content: system }]
  for (const message of history) {
    if (message.role === 'user') {
      if (message.content.trim()) {
        messages.push({ role: 'user', content: message.content })
      }
      continue
    }
    const text = textOf(message)
    if (text.trim()) {
      messages.push({ role: 'assistant', content: text })
    }
  }
  messages.push({ role: 'user', content: question.content })
  return messages
}

const updateBlock = (blocks: ReplyBlock[], index: number, block: ReplyBlock): ReplyBlock[] => {
  const next = [...blocks]
  next[index] = block
  return next
}

/**
 * 把一个 OpenAI 分块合并进回复：思考增量建 thinking 块，正文增量建 text 块；
 * 正文开始时结束当前思考块，结束原因与用量随分块更新。
 */
export const applyOpenCodeChunk = (
  reply: AssistantMessage,
  chunk: OpenCodeChunk,
  now: number,
  state: OpenCodeStreamState
): AssistantMessage => {
  const choice = chunk.choices?.[0]
  const delta = choice?.delta
  let blocks = reply.blocks
  let usage = reply.usage
  let stopReason = reply.stopReason

  const reasoning = delta?.reasoning_content
  if (reasoning) {
    if (state.thinking === null) {
      state.thinking = blocks.length
      blocks = [...blocks, { type: 'thinking', thinking: '', startedAt: now }]
      state.text = null
    }
    const block = blocks[state.thinking]
    if (block?.type === 'thinking') {
      blocks = updateBlock(blocks, state.thinking, { ...block, thinking: block.thinking + reasoning })
    }
  }

  const content = delta?.content
  if (content) {
    if (state.thinking !== null) {
      const block = blocks[state.thinking]
      if (block?.type === 'thinking' && block.endedAt === undefined) {
        blocks = updateBlock(blocks, state.thinking, { ...block, endedAt: now })
      }
      state.thinking = null
    }
    if (state.text === null) {
      state.text = blocks.length
      blocks = [...blocks, { type: 'text', text: '' }]
    }
    const block = blocks[state.text]
    if (block?.type === 'text') {
      blocks = updateBlock(blocks, state.text, { ...block, text: block.text + content })
    }
  }

  const chunkUsage = toMessageUsage(chunk.usage)
  if (chunkUsage) {
    usage = chunkUsage
  }
  const finishReason = choice?.finish_reason
  if (finishReason) {
    stopReason = finishReason === 'length' ? 'max_tokens' : 'end_turn'
  }
  return {
    ...reply,
    blocks,
    usage,
    stopReason,
    status: reply.status === 'pending' ? 'streaming' : reply.status,
  }
}

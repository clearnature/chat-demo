/**
 * DeepSeek / OpenAI Responses API 输出的结构化知识解析。
 *
 * 单独成模块，便于离线测试；不依赖任何浏览器或构建期常量。
 * 注意：Responses 的 output 里可能同时有 reasoning（reasoning_text）和
 * message（output_text/ text）条目，只能收集 message 的正文，否则把思考内容
 * 拼进 JSON 会导致解析失败（线上 retrieve_info 曾因此报
 * "response did not contain structured knowledge"）。
 */

export type RetrieveSource = { title: string; url: string }

export type RetrieveKnowledge = {
  answer: string
  facts: string[]
  sources: RetrieveSource[]
}

/** 结构化知识输出的 JSON Schema（Responses text.format 使用） */
export const KNOWLEDGE_SCHEMA = {
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 从 Responses API 输出里取正文：
 * 1) 优先使用顶层 output_text；
 * 2) 否则只收集 type 为 message 的条目里 output_text/text 类型的内容块；
 * 3) 明确跳过 reasoning 条目与 reasoning_text 块。
 */
export const readResponsesText = (payload: unknown): string => {
  if (!isRecord(payload)) {
    return ''
  }
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text
  }
  if (!Array.isArray(payload.output)) {
    return ''
  }
  const parts: string[] = []
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== 'message') {
      continue
    }
    if (!Array.isArray(item.content)) {
      continue
    }
    for (const block of item.content) {
      if (!isRecord(block)) {
        continue
      }
      if (typeof block.text !== 'string') {
        continue
      }
      // 兼容 output_text 与 text；排除 reasoning_text / summary_text
      if (block.type === 'output_text' || block.type === 'text') {
        parts.push(block.text)
      }
    }
  }
  return parts.join('\n')
}

/** 从可能夹带解释文字的返回里提取第一个配平的 JSON 对象 */
export const extractJSONObject = (raw: string): string | null => {
  const start = raw.indexOf('{')
  if (start < 0) {
    return null
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return raw.slice(start, index + 1)
      }
    }
  }
  return null
}

/** 解析结构化知识；容忍 Markdown 代码块与前后解释文字 */
export const parseKnowledge = (raw: string): RetrieveKnowledge | null => {
  const text = raw.trim()
  if (!text) {
    return null
  }
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
    extractJSONObject(text) ?? '',
  ].filter(Boolean)
  for (const candidate of candidates) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!isRecord(value)) {
      continue
    }
    const answer = typeof value.answer === 'string' ? value.answer : ''
    if (!answer.trim()) {
      continue
    }
    const facts = Array.isArray(value.facts)
      ? value.facts.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
    const sources = Array.isArray(value.sources)
      ? value.sources
          .map((item): RetrieveSource | null => {
            if (!isRecord(item)) {
              return null
            }
            const url = typeof item.url === 'string' ? item.url : ''
            if (!/^https?:\/\//i.test(url)) {
              return null
            }
            const title = typeof item.title === 'string' && item.title ? item.title : url
            return { title, url }
          })
          .filter((item): item is RetrieveSource => item !== null)
      : []
    return { answer, facts, sources }
  }
  return null
}

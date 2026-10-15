import type { ModelMessage } from 'ai'

/** Match live parallel results to the call order used by persisted UI-message replay. */
export function stabilizeToolResultOrder(messages: ModelMessage[]): ModelMessage[] {
  let callOrder = new Map<string, number>()
  let out: ModelMessage[] | undefined
  messages.forEach((message, index) => {
    if (message.role !== 'tool') {
      callOrder = new Map()
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'tool-call') callOrder.set(part.toolCallId, callOrder.size)
        }
      }
      return
    }

    const results = message.content
      .filter((part) => part.type === 'tool-result')
      .filter((part) => callOrder.has(part.toolCallId))
    results.sort((a, b) => callOrder.get(a.toolCallId)! - callOrder.get(b.toolCallId)!)
    let cursor = 0
    const content = message.content.map((part) =>
      part.type === 'tool-result' && callOrder.has(part.toolCallId) ? results[cursor++] : part
    )
    if (content.every((part, i) => part === message.content[i])) return
    out ??= [...messages]
    out[index] = { ...message, content }
  })
  return out ?? messages
}

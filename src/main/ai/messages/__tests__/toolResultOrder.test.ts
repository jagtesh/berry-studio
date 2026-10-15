import type { ModelMessage, ToolResultPart } from 'ai'
import { describe, expect, it } from 'vitest'

import { stabilizeToolResultOrder } from '../toolResultOrder'

const result = (id: string): ToolResultPart => ({
  type: 'tool-result',
  toolCallId: id,
  toolName: 'lookup',
  output: { type: 'text', value: id }
})
const calls: ModelMessage = {
  role: 'assistant',
  content: ['a', 'b'].map((id) => ({ type: 'tool-call', toolCallId: id, toolName: 'lookup', input: {} }))
}

describe('stabilizeToolResultOrder', () => {
  it('keeps approvals and unmatched results in place without changing associations or inputs', () => {
    const a = result('a')
    const b = result('b')
    const unmatched = result('unknown')
    const approval = { type: 'tool-approval-response' as const, approvalId: 'approval', approved: true }
    const messages: ModelMessage[] = [calls, { role: 'tool', content: [b, approval, unmatched, a] }]
    const ordered = stabilizeToolResultOrder(messages)
    expect(ordered).toEqual([calls, { role: 'tool', content: [a, approval, unmatched, b] }])
    expect(messages[1]).toEqual({ role: 'tool', content: [b, approval, unmatched, a] })
    expect(stabilizeToolResultOrder(ordered)).toBe(ordered)
  })

  it('does not apply a previous step call order across a user or assistant turn', () => {
    const messages: ModelMessage[] = [
      calls,
      { role: 'user', content: 'next' },
      { role: 'tool', content: [result('b'), result('a')] }
    ]
    expect(stabilizeToolResultOrder(messages)).toBe(messages)
  })
})

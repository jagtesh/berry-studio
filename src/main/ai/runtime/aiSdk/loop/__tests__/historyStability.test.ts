import '@data/services/TopicService'
import { createHash } from 'node:crypto'

import { setupTestDatabase } from '@test-helpers/db'
import { isToolUIPart, tool, type ToolSet, type UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { topicTable } from '@data/db/schemas/topic'
import { messageService } from '@data/services/MessageService'
import { ALL_MEDIA } from '@main/ai/messages/messageCapabilities'
import { pipeStreamLoop } from '@main/ai/streamManager/pipeStreamLoop'
import { mcpResultToModelOutput } from '@main/ai/tools/adapters/aiSdk/mcp/utils'
import type { CherryUIMessage } from '@shared/data/types/message'

import { Agent } from '../../Agent'

interface WireMessage {
  role: string
  tool_call_id?: string
  content: unknown
}

function fingerprint(messages: WireMessage[]) {
  return messages.map((message, index) => ({
    index,
    role: message.role,
    toolCallId: message.tool_call_id,
    contentHash: createHash('sha256').update(JSON.stringify(message.content)).digest('hex'),
    messageHash: createHash('sha256').update(JSON.stringify(message)).digest('hex')
  }))
}

function sse(delta: unknown, finishReason: string | null = null) {
  return `data: ${JSON.stringify({ id: 'test', created: 0, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
}

// Catches completion-order wire history changing to call-order history after persistence/replay.
describe('parallel tool history on the OpenAI-compatible wire', () => {
  const dbh = setupTestDatabase()

  it.each(['a', 'b'] as const)(
    'preserves the prefix when tool %s completes first, including reload and retry',
    async (first) => {
      const bodies: Array<{ messages: WireMessage[] }> = []
      let releaseStarted!: () => void
      const started = new Promise<void>((resolve) => {
        releaseStarted = resolve
      })
      const releases = new Map<string, () => void>()
      let releaseFirstFinished!: () => void
      const firstFinished = new Promise<void>((resolve) => {
        releaseFirstFinished = resolve
      })
      const completionOrder: string[] = []
      const outputs = {
        a: {
          content: [
            { type: 'text' as const, text: 'result A'.repeat(100) },
            { type: 'image' as const, data: 'YQ==', mimeType: 'image/png' }
          ]
        },
        b: {
          content: [
            { type: 'text' as const, text: 'result B'.repeat(90) },
            { type: 'image' as const, data: 'Yg==', mimeType: 'image/png' }
          ]
        }
      }
      const tools: ToolSet = {
        lookup: tool({
          inputSchema: z.object({ key: z.enum(['a', 'b']) }),
          execute: async ({ key }) => {
            await new Promise<void>((resolve) => {
              releases.set(key, resolve)
              if (releases.size === 2) releaseStarted()
            })
            return outputs[key]
          },
          toModelOutput: ({ output }) => mcpResultToModelOutput(output as typeof outputs.a)
        })
      }
      let retry = false
      const agent = new Agent({
        providerId: 'openai-compatible',
        modelId: 'test-model',
        providerSettings: {
          name: 'history-test',
          baseURL: 'https://history.test/v1',
          fetch: async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)))
            if (retry) {
              retry = false
              return new Response('temporary failure', { status: 500 })
            }
            const response =
              bodies.length === 1
                ? sse({
                    tool_calls: ['a', 'b'].map((key, index) => ({
                      index,
                      id: `call-${key}`,
                      type: 'function',
                      function: { name: 'lookup', arguments: JSON.stringify({ key }) }
                    }))
                  }) + sse({}, 'tool_calls')
                : sse({ content: 'Done.' }) + sse({}, 'stop')
            return new Response(response + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
          }
        },
        tools,
        mediaCapabilities: ALL_MEDIA,
        toolResultMediaCapabilities: { image: false, audio: false, video: false },
        hookParts: [
          {
            onToolExecutionEnd: ({ callId }) => {
              completionOrder.push(callId)
              if (callId === `call-${first}`) releaseFirstFinished()
            }
          }
        ]
      })
      const initial: CherryUIMessage[] = [
        { id: 'question', role: 'user', parts: [{ type: 'text', text: 'Inspect both images.' }] }
      ]
      const run = pipeStreamLoop(agent.stream(initial, new AbortController().signal), new AbortController().signal, {
        onChunk: () => {}
      })
      await started
      releases.get(first)!()
      await firstFinished
      releases.get(first === 'a' ? 'b' : 'a')!()
      const result = await run
      expect(result.threw).toBeUndefined()
      expect(result.accumulationError).toBeUndefined()
      expect(completionOrder).toEqual([`call-${first}`, `call-${first === 'a' ? 'b' : 'a'}`])
      const assistant = result.finalMessage!
      expect(assistant.parts.filter(isToolUIPart).map((part) => part.toolCallId)).toEqual(['call-a', 'call-b'])
      const prior = bodies[1].messages
      expect(prior.at(-1)).toMatchObject({
        role: 'user',
        content: expect.arrayContaining([
          expect.objectContaining({
            type: 'image_url',
            image_url: expect.objectContaining({ url: 'data:image/png;base64,YQ==' })
          }),
          expect.objectContaining({
            type: 'image_url',
            image_url: expect.objectContaining({ url: 'data:image/png;base64,Yg==' })
          })
        ])
      })
      for (const key of ['a', 'b'] as const) {
        const wireResult = prior.find((message) => message.tool_call_id === `call-${key}`)!
        expect(JSON.stringify(wireResult.content)).toContain(outputs[key].content[0].text)
      }

      dbh.db.insert(topicTable).values({ id: 'topic', orderKey: 'a0' }).run()
      const rootId = messageService.createRootMessageTx(dbh.db, 'topic')
      const question = messageService.create('topic', {
        parentId: rootId,
        role: 'user',
        status: 'success',
        data: { parts: initial[0].parts }
      })
      const placeholder = messageService.create('topic', {
        parentId: question.id,
        role: 'assistant',
        status: 'pending',
        data: { parts: [] }
      })
      messageService.finalizeAssistantMessage(placeholder.id, { data: { parts: assistant.parts }, status: 'success' })
      const followup = messageService.create('topic', {
        parentId: placeholder.id,
        role: 'user',
        status: 'success',
        data: { parts: [{ type: 'text', text: 'Continue.' }] }
      })
      const reloaded: UIMessage[] = messageService
        .getPathToNode(followup.id)
        .map((row) => ({ id: row.id, role: row.role as UIMessage['role'], parts: row.data.parts ?? [] }))
      expect(reloaded[1].parts).toEqual(assistant.parts)

      retry = true
      const continuation = await pipeStreamLoop(
        agent.stream(reloaded, new AbortController().signal),
        new AbortController().signal,
        { onChunk: () => {} }
      )
      expect(continuation.threw).toBeUndefined()
      expect(bodies).toHaveLength(4)
      for (const body of bodies.slice(2)) {
        expect(fingerprint(body.messages.slice(0, prior.length))).toEqual(fingerprint(prior))
      }
      expect(fingerprint(bodies[2].messages)).toEqual(fingerprint(bodies[3].messages))
      expect(prior.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)).toEqual([
        'call-a',
        'call-b'
      ])
    }
  )
})

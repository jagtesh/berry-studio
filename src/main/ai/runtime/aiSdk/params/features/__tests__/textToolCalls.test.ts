import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { generateText, jsonSchema, streamText, tool, wrapLanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'

import { createAnchoredReasoningExtraction } from '../reasoningExtractionMiddleware'
import { createTextToolCallsMiddleware } from '../textToolCalls'
import { parseGemmaToolCalls, parseLfmToolCalls } from '../toolCallFormats'

const lfm = (body: string) => `<|tool_call_start|>${body}<|tool_call_end|>`
const gemma = (body: string) => `<|tool_call>${body}<tool_call|>`
const prompt: LanguageModelV3CallOptions['prompt'] = [{ role: 'user', content: [{ type: 'text', text: 'Draw Mars' }] }]
const options: LanguageModelV3CallOptions = {
  prompt,
  tools: [{ type: 'function', name: 'draw', inputSchema: { type: 'object' } }]
}
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
}

function model(
  format: 'lfm' | 'gemma',
  text: string,
  chunks = [text],
  extra: LanguageModelV3StreamPart[] = [],
  nativeAfter = false
): LanguageModelV3 {
  return wrapLanguageModel({
    model: new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: []
      }),
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            if (!nativeAfter) for (const part of extra) controller.enqueue(part)
            controller.enqueue({ type: 'text-start', id: 'text' })
            for (const delta of chunks) controller.enqueue({ type: 'text-delta', id: 'text', delta })
            controller.enqueue({ type: 'text-end', id: 'text' })
            if (nativeAfter) for (const part of extra) controller.enqueue(part)
            controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage })
            controller.close()
          }
        })
      })
    }),
    middleware: createTextToolCallsMiddleware(format)
  })
}

describe('distinct LFM and Gemma tool-call grammars', () => {
  it('parses LFM keyword arguments, escaped strings, nested literals and parallel calls', () => {
    expect(
      parseLfmToolCalls(
        String.raw`[draw(prompt='Mars, it\'s red (beautiful)', config={'enabled': True, 'items': [1, -2.5e2, None]}), draw(prompt="Moon")]`
      )
    ).toEqual([
      {
        toolName: 'draw',
        args: { prompt: "Mars, it's red (beautiful)", config: { enabled: true, items: [1, -250, null] } }
      },
      { toolName: 'draw', args: { prompt: 'Moon' } }
    ])
  })

  it('parses Gemma colon arguments and special string tokens without changing their content', () => {
    expect(
      parseGemmaToolCalls('call:draw{prompt:<|"|>Mars, "red" {rocks}<|"|>,config:{enabled:true,items:[1,null]}}')
    ).toEqual([
      { toolName: 'draw', args: { prompt: 'Mars, "red" {rocks}', config: { enabled: true, items: [1, null] } } }
    ])
  })

  it.each([
    '[draw(prompt=run())]',
    "[draw('Mars')]",
    "[draw(prompt='Mars', prompt='Moon')]",
    "[draw(prompt='Mars')]; run()",
    "[draw(config={'x': object.attribute})]",
    'call:draw{prompt:<|"|>Mars<|"|>}'
  ])('rejects non-LFM data or executable expressions: %s', (text) => {
    expect(() => parseLfmToolCalls(text)).toThrow()
  })

  it.each(["[draw(prompt='Mars')]", 'call:draw{enabled:True}', "call:draw{prompt:'Mars'}", 'call:draw{x:1,x:2}'])(
    'rejects other grammars in Gemma: %s',
    (text) => {
      expect(() => parseGemmaToolCalls(text)).toThrow()
    }
  )
})

describe('tool-call recovery', () => {
  it('recovers the supplied MCP name and long image prompt without truncating arguments', async () => {
    const toolName = 'mcp__comfyui__generateImage_25410d8b4cf44da04e84'
    const imagePrompt =
      'A breathtaking, cinematic sunrise on Mars: the red dusty Martian landscape bathed in the warm glow of a rising sun, dramatic sky with rich shades of orange, deep red, and purple, fine details of rocky terrain and distant mesas, soft atmospheric haze, highly realistic and beautiful, epic sci-fi landscape'
    const result = await model('lfm', lfm(`[${toolName}(prompt='${imagePrompt}', blueprint='kreation')]`)).doGenerate({
      ...options,
      tools: [{ type: 'function', name: toolName, inputSchema: { type: 'object' } }]
    })
    expect(result.content).toEqual([
      expect.objectContaining({
        type: 'tool-call',
        toolName,
        input: JSON.stringify({ prompt: imagePrompt, blueprint: 'kreation' })
      })
    ])
  })

  it.each([
    ['lfm', lfm("[draw(prompt='Mars', blueprint='kreation')]")],
    ['gemma', gemma('call:draw{prompt:<|"|>Mars<|"|>,blueprint:<|"|>kreation<|"|>}')]
  ] as const)('recovers %s through generate and every streaming boundary', async (format, text) => {
    const generated = await model(format, text).doGenerate(options)
    expect(generated.content).toEqual([
      expect.objectContaining({
        type: 'tool-call',
        toolName: 'draw',
        input: '{"prompt":"Mars","blueprint":"kreation"}'
      })
    ])
    expect(generated.finishReason.unified).toBe('tool-calls')
    for (let split = 1; split < text.length; split++) {
      const streamed = await model(format, text, [text.slice(0, split), text.slice(split)]).doStream(options)
      const parts = await Array.fromAsync(streamed.stream)
      expect(parts.filter((part) => part.type === 'tool-call')).toEqual([
        expect.objectContaining({ toolName: 'draw', input: '{"prompt":"Mars","blueprint":"kreation"}' })
      ])
      expect(parts.filter((part) => part.type === 'text-delta')).toEqual([])
      expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'tool-calls' } })
    }
  })

  it.each([
    lfm("[unknown(prompt='Mars')]"),
    lfm("[draw(prompt='Mars'), broken()]"),
    lfm('[draw(prompt=run())]'),
    '<|tool_call_start|>[draw(prompt=',
    '```python\n' + lfm("[draw(prompt='example')]") + '\n```',
    'An example: ' + lfm("[draw(prompt='example')]")
  ])('preserves unknown, malformed, incomplete and quoted calls: %s', async (text) => {
    const target = model('lfm', text, [...text])
    const generated = await target.doGenerate(options)
    expect(generated.content).toEqual([{ type: 'text', text }])
    const streamed = await target.doStream(options)
    const parts = await Array.fromAsync(streamed.stream)
    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([])
    expect(parts.flatMap((part) => (part.type === 'text-delta' ? [part.delta] : [])).join('')).toBe(text)
  })

  it('executes recovered calls through the SDK tool contract in both paths', async () => {
    const tools = {
      draw: tool({
        inputSchema: jsonSchema<{ prompt: string }>({
          type: 'object',
          properties: { prompt: { type: 'string' } },
          required: ['prompt']
        }),
        execute: ({ prompt }) => `Drawn: ${prompt}`
      })
    }
    const target = model('lfm', lfm("[draw(prompt='Mars')]"))
    const generated = await generateText({ model: target, prompt: 'Draw Mars', tools })
    expect(generated.toolResults[0].output).toBe('Drawn: Mars')
    const streamed = streamText({ model: target, prompt: 'Draw Mars', tools })
    expect((await streamed.toolResults)[0].output).toBe('Drawn: Mars')
  })

  it('retains approval requirements on recovered calls', async () => {
    const result = await generateText({
      model: model('lfm', lfm("[draw(prompt='Mars')]")),
      prompt: 'Draw Mars',
      tools: {
        draw: tool({
          inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object' }),
          needsApproval: true,
          execute: (): string => {
            throw new Error('Approval bypassed')
          }
        })
      }
    })
    expect(result.content.some((part) => part.type === 'tool-approval-request')).toBe(true)
    expect(result.toolResults).toEqual([])
  })

  it('keeps calls disabled when toolChoice is none', async () => {
    const text = lfm("[draw(prompt='Mars')]")
    const target = model('lfm', text)
    const params = { ...options, toolChoice: { type: 'none' as const } }
    expect((await target.doGenerate(params)).content).toEqual([{ type: 'text', text }])
    const parts = await Array.fromAsync((await target.doStream(params)).stream)
    expect(parts.some((part) => part.type === 'tool-call')).toBe(false)
  })

  it.each([false, true])('avoids duplicating native calls (native follows text: %s)', async (nativeAfter) => {
    const native: LanguageModelV3StreamPart = {
      type: 'tool-call',
      toolCallId: 'native',
      toolName: 'draw',
      input: '{"prompt":"Mars"}'
    }
    const parts = await Array.fromAsync(
      (await model('lfm', lfm("[draw(prompt='Mars')]"), undefined, [native], nativeAfter).doStream(options)).stream
    )
    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([native])
  })

  it('handles consecutive Gemma blocks and trailing prose', async () => {
    const text = gemma('call:draw{prompt:<|"|>Mars<|"|>}') + gemma('call:draw{prompt:<|"|>Moon<|"|>}') + 'Done.'
    const target = model('gemma', text, [...text])
    const generated = await target.doGenerate(options)
    expect(generated.content.filter((part) => part.type === 'tool-call').map((part) => part.input)).toEqual([
      '{"prompt":"Mars"}',
      '{"prompt":"Moon"}'
    ])
    const parts = await Array.fromAsync((await target.doStream(options)).stream)
    expect(parts.filter((part) => part.type === 'tool-call').map((part) => part.input)).toEqual([
      '{"prompt":"Mars"}',
      '{"prompt":"Moon"}'
    ])
    expect(parts.flatMap((part) => (part.type === 'text-delta' ? [part.delta] : [])).join('')).toBe('Done.')
  })

  it('recovers calls after inline reasoning is separated', async () => {
    const source = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '<think>Use draw.</think>' + lfm("[draw(prompt='Mars')]") }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: []
      })
    })
    const target = wrapLanguageModel({
      model: source,
      middleware: [createTextToolCallsMiddleware('lfm'), createAnchoredReasoningExtraction('think')]
    })
    const result = await target.doGenerate(options)
    expect(result.content).toEqual([
      { type: 'reasoning', text: 'Use draw.' },
      expect.objectContaining({ type: 'tool-call', toolName: 'draw', input: '{"prompt":"Mars"}' })
    ])
  })
})

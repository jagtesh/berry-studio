import type { LanguageModelV3CallOptions, LanguageModelV3Content, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { generateId, type LanguageModelMiddleware } from 'ai'

import { definePlugin } from '@cherrystudio/ai-core'
import { ENDPOINT_TYPE } from '@shared/data/types/model'
import { getRawModelId } from '@shared/utils/model'

import type { RequestFeature } from '../feature'
import { parseGemmaToolCalls, parseLfmToolCalls, type TextToolCall } from './toolCallFormats'

const FORMATS = {
  lfm: { open: '<|tool_call_start|>', close: '<|tool_call_end|>', parse: parseLfmToolCalls },
  gemma: { open: '<|tool_call>', close: '<tool_call|>', parse: parseGemmaToolCalls }
} as const
type Format = keyof typeof FORMATS
const BUFFER_LIMIT = 64 * 1024

function toolParts(calls: TextToolCall[]): LanguageModelV3Content[] {
  return calls.map((call) => ({
    type: 'tool-call',
    toolCallId: generateId(),
    toolName: call.toolName,
    input: JSON.stringify(call.args)
  }))
}

export function createTextToolCallsMiddleware(format: Format): LanguageModelMiddleware {
  const template = FORMATS[format]
  const extract = (text: string, names: Set<string>) => {
    const start = text.length - text.trimStart().length
    if (!text.startsWith(template.open, start)) return undefined
    let end = text.indexOf(template.close, start + template.open.length)
    while (end !== -1) {
      try {
        const calls = template.parse(text.slice(start + template.open.length, end))
        if (calls.length && calls.every((call) => names.has(call.toolName))) {
          return { parts: toolParts(calls), remainder: text.slice(end + template.close.length) }
        }
      } catch {
        // A close delimiter can also occur inside a string argument.
      }
      end = text.indexOf(template.close, end + template.close.length)
    }
    return undefined
  }
  const toolNames = (tools: LanguageModelV3CallOptions['tools']) =>
    new Set(tools?.filter((tool) => tool.type === 'function').map((tool) => tool.name))

  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate()
      if (params.toolChoice?.type === 'none' || result.content.some((part) => part.type === 'tool-call')) return result
      let extracted = false
      const content = result.content.flatMap((part): LanguageModelV3Content[] => {
        if (part.type !== 'text') return [part]
        let text = part.text
        const parts: LanguageModelV3Content[] = []
        let parsed = extract(text, toolNames(params.tools))
        while (parsed) {
          parts.push(...parsed.parts)
          text = parsed.remainder
          extracted = true
          parsed = extract(text, toolNames(params.tools))
        }
        if (!parts.length) return [part]
        if (text) parts.push({ ...part, text })
        return parts
      })
      return extracted
        ? {
            ...result,
            content,
            finishReason:
              result.finishReason.unified === 'stop'
                ? { ...result.finishReason, unified: 'tool-calls' }
                : result.finishReason
          }
        : result
    },
    wrapStream: async ({ doStream, params }) => {
      const result = await doStream()
      const names = params.toolChoice?.type === 'none' ? new Set<string>() : toolNames(params.tools)
      let pending = ''
      let textId = ''
      let passthrough = false
      let extracted = false
      let native = false
      const recovered: LanguageModelV3StreamPart[] = []
      const flush = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>) => {
        if (pending) controller.enqueue({ type: 'text-delta', id: textId, delta: pending })
        pending = ''
      }
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
            transform(chunk, controller) {
              if (chunk.type === 'tool-call' || chunk.type === 'tool-input-start') native = true
              if (chunk.type === 'text-start') {
                flush(controller)
                textId = chunk.id
                passthrough = native || !names.size
              }
              if (chunk.type === 'text-delta' && !passthrough) {
                textId = chunk.id
                pending += chunk.delta
                let parsed = extract(pending, names)
                while (parsed) {
                  for (const part of parsed.parts) {
                    if (part.type !== 'tool-call') continue
                    recovered.push(
                      { type: 'tool-input-start', id: part.toolCallId, toolName: part.toolName },
                      { type: 'tool-input-delta', id: part.toolCallId, delta: part.input },
                      { type: 'tool-input-end', id: part.toolCallId },
                      part
                    )
                  }
                  extracted = true
                  pending = parsed.remainder
                  parsed = extract(pending, names)
                }
                const candidate = pending.trimStart()
                if (
                  pending.length > BUFFER_LIMIT ||
                  !(template.open.startsWith(candidate) || candidate.startsWith(template.open))
                ) {
                  flush(controller)
                  passthrough = true
                }
                return
              }
              if (chunk.type === 'text-end' || chunk.type === 'finish' || native) flush(controller)
              // Some servers emit the same call as both text and a later native part.
              if (chunk.type === 'finish' && !native) {
                for (const part of recovered) controller.enqueue(part)
              }
              if (chunk.type === 'finish' && extracted && chunk.finishReason.unified === 'stop') {
                controller.enqueue({ ...chunk, finishReason: { ...chunk.finishReason, unified: 'tool-calls' } })
              } else controller.enqueue(chunk)
            },
            flush
          })
        )
      }
    }
  }
}

export const textToolCallsFeature: RequestFeature = {
  name: 'text-tool-calls',
  applies: (scope) =>
    (scope.endpointType === ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS ||
      scope.endpointType === ENDPOINT_TYPE.OLLAMA_CHAT) &&
    /gemma|(?:^|[/_-])lfm/i.test(getRawModelId(scope.model)),
  contributeModelAdapters: (scope) => [
    definePlugin({
      name: 'text-tool-calls',
      enforce: 'pre',
      configureContext: (context) => {
        context.middlewares ??= []
        context.middlewares.push(
          createTextToolCallsMiddleware(/gemma/i.test(getRawModelId(scope.model)) ? 'gemma' : 'lfm')
        )
      }
    })
  ]
}

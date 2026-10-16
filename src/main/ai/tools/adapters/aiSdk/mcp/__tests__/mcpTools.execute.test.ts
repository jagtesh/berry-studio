import type { CallToolResult } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createToolInvokeTool } from '@main/ai/tools/adapters/aiSdk/meta/toolInvoke'

import { createMcpJsonSchemaValidator } from '../../mcpSchema'
import { ToolRegistry } from '../../registry'

const listTools = vi.fn()
const list = vi.fn()
const getById = vi.fn()
const callTool = vi.fn<(req: unknown) => Promise<CallToolResult>>()
const fileRead = vi.fn()
const uploadFetch = vi.fn()

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({
    McpCatalogService: { listTools },
    McpRuntimeService: { callTool },
    FileManager: { read: fileRead }
  } as Record<string, unknown>)
})

vi.mock('@main/data/services/McpServerService', () => ({
  mcpServerService: { list, getById }
}))

// Import AFTER vi.mock so the mocks bind correctly.
const { syncMcpToolsToRegistry } = await import('../mcpTools')

function mcpTool(serverId: string, name: string, description = '') {
  return {
    id: `mcp__${serverId}__${name}`,
    serverId,
    serverName: serverId,
    name,
    description,
    inputSchema: { type: 'object', properties: {} }
  }
}

function activeServer(id: string, disabledAutoApproveTools: string[] = []) {
  return { id, name: id, isActive: true, disabledAutoApproveTools }
}

/** Register a single tool via the production sync path and return its SDK execute fn. */
async function registerToolExecute(reg: ToolRegistry) {
  list.mockReturnValue({ items: [activeServer('s1')] })
  listTools.mockReturnValue([mcpTool('s1', 't')])
  await syncMcpToolsToRegistry(reg)
  const entry = reg.getByName('mcp__s1__t')
  if (!entry) throw new Error('expected mcp__s1__t to be registered')
  const execute = entry.tool.execute
  if (!execute) throw new Error('expected the registered tool to have an execute fn')
  return execute
}

describe('mcpTools execute wrapper', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('honors declared schema dialects and rejects unsupported dialects', () => {
    const schema = { type: 'array' as const, items: [{ type: 'string' as const }], additionalItems: false }
    const validate = createMcpJsonSchemaValidator({ ...schema, $schema: 'http://json-schema.org/draft-07/schema#' })
    expect(validate(['ok']).success).toBe(true)
    expect(validate([42]).success).toBe(false)
    expect(validate(['ok', 'extra']).success).toBe(false)
    expect(() => createMcpJsonSchemaValidator({ $schema: 'https://example.org/unknown-schema' })).toThrow(
      /unsupported dialect/
    )
  })

  beforeEach(() => {
    listTools.mockReset()
    list.mockReset()
    getById.mockReset()
    callTool.mockReset()
    fileRead.mockReset()
    uploadFetch.mockReset()
  })

  it('rejects when the server is no longer active or registered', async () => {
    const reg = new ToolRegistry()
    const execute = await registerToolExecute(reg)

    // resolveActiveServerById → mcpServerService.getById resolves an inactive server,
    // so resolveActiveServerById returns undefined and execute throws.
    getById.mockReturnValue({ id: 's1', name: 's1', isActive: false })

    await expect(execute({}, { toolCallId: 'call-1' } as any)).rejects.toThrow(
      'MCP server s1 is not active or no longer registered'
    )
    // Never reaches the runtime when the server is inactive.
    expect(callTool).not.toHaveBeenCalled()
  })

  it('rejects with the result summary when callTool returns isError', async () => {
    const reg = new ToolRegistry()
    const execute = await registerToolExecute(reg)

    getById.mockReturnValue(activeServer('s1'))
    callTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'boom from server' }]
    })

    await expect(execute({ q: 'x' }, { toolCallId: 'call-2' } as any)).rejects.toThrow('boom from server')
  })

  it('returns the runtime result plus mcp metadata on success', async () => {
    const reg = new ToolRegistry()
    const execute = await registerToolExecute(reg)

    getById.mockReturnValue(activeServer('s1'))
    const runtimeResult: CallToolResult = {
      isError: false,
      content: [{ type: 'text', text: 'ok' }]
    }
    callTool.mockResolvedValue(runtimeResult)
    const abortSignal = new AbortController().signal

    const out = (await execute({ q: 'x' }, { toolCallId: 'call-3', abortSignal } as any)) as CallToolResult & {
      metadata: { description: string; name: string; serverId: string; serverName: string; type: string }
    }

    expect(callTool).toHaveBeenCalledWith({
      serverId: 's1',
      name: 't',
      args: { q: 'x' },
      callId: 'call-3',
      scope: undefined,
      signal: abortSignal,
      interactionContext: undefined
    })
    expect(out.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(out.metadata).toEqual({ description: '', name: 't', serverName: 's1', serverId: 's1', type: 'mcp' })
  })

  it('uploads only a conversation image to ComfyUI without a shell or local path', async () => {
    const reg = new ToolRegistry()
    list.mockReturnValue({ items: [activeServer('comfy')] })
    listTools.mockReturnValue([{ ...mcpTool('comfy', 'upload_image'), serverName: 'comfyui' }])
    await syncMcpToolsToRegistry(reg)
    const execute = reg.getByName('mcp__comfy__upload_image')!.tool.execute!
    getById.mockReturnValue({ ...activeServer('comfy'), name: 'comfyui', baseUrl: 'http://comfy.test/mcp' })
    callTool.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            upload_url: 'http://comfy.test/upload/ticket',
            accepted_types: ['image/png'],
            max_bytes: 100
          })
        }
      ]
    })
    fileRead.mockResolvedValue({ content: 'QUJD', mime: 'image/png' })
    uploadFetch.mockResolvedValue({ ok: true, text: async () => '{"image":"uploaded.png"}' })
    vi.stubGlobal('fetch', uploadFetch)

    const result = (await execute({ image_filename: 'photo.png' }, {
      toolCallId: 'call-upload',
      abortSignal: new AbortController().signal,
      experimental_context: {
        requestId: 'request-1',
        fileAttachments: [{ fileEntryId: 'entry-photo', handle: 'photo.png', displayName: 'photo.png' }]
      }
    } as any)) as CallToolResult

    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'comfy', name: 'upload_image', args: {} })
    )
    expect(fileRead).toHaveBeenCalledWith('entry-photo', { encoding: 'base64' })
    expect(uploadFetch).toHaveBeenCalledWith(
      new URL('http://comfy.test/upload/ticket'),
      expect.objectContaining({ method: 'PUT', body: Buffer.from('ABC'), redirect: 'error' })
    )
    expect(result.content).toEqual([{ type: 'text', text: '{"image":"uploaded.png"}' }])
  })

  it('rejects an unattached ComfyUI filename before requesting an upload ticket', async () => {
    const reg = new ToolRegistry()
    list.mockReturnValue({ items: [activeServer('comfy')] })
    listTools.mockReturnValue([{ ...mcpTool('comfy', 'upload_image'), serverName: 'comfyui' }])
    await syncMcpToolsToRegistry(reg)
    getById.mockReturnValue({ ...activeServer('comfy'), name: 'comfyui', baseUrl: 'http://comfy.test/mcp' })

    await expect(
      reg.getByName('mcp__comfy__upload_image')!.tool.execute!({ image_filename: '/tmp/secret.png' }, {
        toolCallId: 'call-upload',
        abortSignal: new AbortController().signal
      } as any)
    ).rejects.toThrow('No image attached')
    expect(callTool).not.toHaveBeenCalled()
    expect(fileRead).not.toHaveBeenCalled()
  })

  it('rejects a ComfyUI upload ticket pointing at another server', async () => {
    const reg = new ToolRegistry()
    list.mockReturnValue({ items: [activeServer('comfy')] })
    listTools.mockReturnValue([{ ...mcpTool('comfy', 'upload_image'), serverName: 'comfyui' }])
    await syncMcpToolsToRegistry(reg)
    getById.mockReturnValue({ ...activeServer('comfy'), name: 'comfyui', baseUrl: 'http://comfy.test/mcp' })
    callTool.mockResolvedValue({
      content: [{ type: 'text', text: '{"upload_url":"http://other.test/upload"}' }]
    })

    await expect(
      reg.getByName('mcp__comfy__upload_image')!.tool.execute!({ image_filename: 'photo.png' }, {
        toolCallId: 'call-upload',
        abortSignal: new AbortController().signal,
        experimental_context: {
          requestId: 'request-1',
          fileAttachments: [{ fileEntryId: 'entry-photo', handle: 'photo.png', displayName: 'photo.png' }]
        }
      } as any)
    ).rejects.toThrow('outside its configured server')
    expect(fileRead).not.toHaveBeenCalled()
  })

  it('rejects Draft 2020-12-invalid deferred arguments before calling the MCP runtime', async () => {
    const reg = new ToolRegistry()
    const tool = {
      ...mcpTool('s1', 't'),
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        unevaluatedProperties: false
      }
    }
    list.mockReturnValue({ items: [activeServer('s1')] })
    listTools.mockReturnValue([tool])
    getById.mockReturnValue(activeServer('s1'))
    callTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'should not run' }]
    })
    await syncMcpToolsToRegistry(reg)

    const invoke = createToolInvokeTool(reg, new Set([tool.id]), new Set([tool.id]))
    const execute = invoke.execute
    if (!execute) throw new Error('expected tool_invoke to have an execute fn')

    await expect(
      execute(
        { name: tool.id, params: { query: 'hello', unexpected: true } },
        {
          toolCallId: 'outer-1',
          messages: []
        }
      )
    ).rejects.toThrow(/Invalid params/)
    expect(callTool).not.toHaveBeenCalled()
  })

  it('executes the explicitly selected server when display names normalize alike', async () => {
    const reg = new ToolRegistry()
    const reimbursement = {
      ...mcpTool('server-a', 'executeSql'),
      id: 'mcp__mysql__executeSql_a',
      serverName: 'mysql_报销'
    }
    const elevator = {
      ...mcpTool('server-b', 'executeSql'),
      id: 'mcp__mysql__executeSql_b',
      serverName: 'mysql_电梯'
    }
    list.mockReturnValue({
      items: [
        { ...activeServer('server-b'), name: 'mysql_电梯', sortOrder: 2 },
        { ...activeServer('server-a'), name: 'mysql_报销', sortOrder: 1 }
      ]
    })
    listTools.mockImplementation((serverId: string) => (serverId === 'server-a' ? [reimbursement] : [elevator]))
    getById.mockReturnValue({ id: 'server-a', name: 'mysql_报销', isActive: true })
    callTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'ok' }]
    })

    await syncMcpToolsToRegistry(reg, { selectedToolIds: new Set([reimbursement.id]) })
    const execute = reg.getByName(reimbursement.id)?.tool.execute
    if (!execute) throw new Error('expected selected reimbursement tool')
    await execute({ sql: 'select 1' }, { toolCallId: 'call-reimbursement' } as any)

    expect(callTool).toHaveBeenCalledExactlyOnceWith({
      serverId: 'server-a',
      name: 'executeSql',
      args: { sql: 'select 1' },
      callId: 'call-reimbursement'
    })
  })
})

import type { CallToolResult } from '@modelcontextprotocol/client'
import { type JSONSchema7, type Tool } from 'ai'

import { application } from '@application'
import { loggerService } from '@logger'
import type { McpInteractionContext } from '@main/ai/mcp/connections/McpConnection'
import type { FileAttachmentRef } from '@main/ai/messages/attachmentTypes'
import { registerMcpToolResources } from '@main/ai/messages/mcpToolResources'
import { mcpServerService } from '@main/data/services/McpServerService'
import { isMcpToolForcePromptBySource } from '@shared/ai/tools/mcpSourcePolicy'
import type { McpServer } from '@shared/data/types/mcpServer'
import type { McpTool } from '@shared/types/mcp'

import { getRequestContext } from '../context'
import { createMcpInputSchema } from '../mcpSchema'
import { registry, type ToolRegistry } from '../registry'
import type { ToolEntry } from '../types'
import { mcpResultToModelOutput, mcpResultToTextSummary } from './utils'

const logger = loggerService.withContext('mcpTools')

const namespaceForServer = (serverId: string) => `mcp:${serverId}`
const COMFYUI_UPLOAD_DESCRIPTION =
  'Upload an image attached to this conversation to ComfyUI by its shown attachment name. Returns the ComfyUI filename for edit_image. No shell or file path is needed.'

function isComfyuiUploadTool(tool: McpTool): boolean {
  return tool.name === 'upload_image' && tool.serverName.toLowerCase().startsWith('comfyui')
}

async function uploadComfyuiAttachment(
  server: McpServer,
  filename: string,
  attachments: ReadonlyArray<FileAttachmentRef>,
  signal: AbortSignal | undefined,
  callId: string
): Promise<CallToolResult> {
  const attachment = attachments.find((entry) => entry.handle === filename)
  if (!attachment) throw new Error(`No image attached to this conversation is named ${JSON.stringify(filename)}.`)
  if (!server.baseUrl) throw new Error('ComfyUI MCP server has no upload endpoint.')

  const ticket = await application.get('McpRuntimeService').callTool({
    serverId: server.id,
    name: 'upload_image',
    args: {},
    callId,
    signal
  })
  if (ticket.isError) throw new Error(mcpResultToTextSummary(ticket) || 'ComfyUI upload ticket failed')
  const ticketText = ticket.content.find((part) => part.type === 'text')?.text
  const upload = JSON.parse(ticketText ?? '{}') as {
    upload_url?: string
    max_bytes?: number
    accepted_types?: string[]
  }
  const uploadUrl = new URL(upload.upload_url ?? '')
  const serverUrl = new URL(server.baseUrl)
  if (uploadUrl.origin !== serverUrl.origin || !['http:', 'https:'].includes(uploadUrl.protocol)) {
    throw new Error('ComfyUI returned an upload URL outside its configured server.')
  }

  const { content, mime } = await application.get('FileManager').read(attachment.fileEntryId, { encoding: 'base64' })
  if (!mime.startsWith('image/') || (upload.accepted_types && !upload.accepted_types.includes(mime))) {
    throw new Error('The attached image type is not accepted by ComfyUI.')
  }
  const bytes = Buffer.from(content, 'base64')
  if (upload.max_bytes && bytes.length > upload.max_bytes)
    throw new Error('The attached image exceeds the ComfyUI upload limit.')

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mime },
    body: bytes,
    redirect: 'error',
    signal
  })
  if (!response.ok) throw new Error(`ComfyUI image upload failed (HTTP ${response.status}).`)
  return { content: [{ type: 'text', text: await response.text() }] }
}

function resolveActiveServerById(serverId: string): McpServer | undefined {
  // Direct point lookup instead of listing every active server on each tool call.
  let server: McpServer | undefined
  try {
    server = mcpServerService.getById(serverId)
  } catch {
    server = undefined
  }
  return server?.isActive ? server : undefined
}

function interactionContext(options: Parameters<NonNullable<Tool['execute']>>[1]): McpInteractionContext | undefined {
  const request = getRequestContext(options)
  if (!request?.windowId || !request.topicId) return undefined

  return {
    windowId: request.windowId,
    topicId: request.topicId,
    model: request.model,
    roots: request.roots
  }
}

/** Build the AI SDK Tool wrapper around a single McpTool. */
function createMcpTool(mcpTool: McpTool, forcePrompt: boolean): Tool {
  const comfyuiUpload = isComfyuiUploadTool(mcpTool)
  const description = comfyuiUpload ? COMFYUI_UPLOAD_DESCRIPTION : mcpTool.description || mcpTool.name
  const metadata = {
    description: comfyuiUpload ? COMFYUI_UPLOAD_DESCRIPTION : mcpTool.description,
    name: mcpTool.name,
    serverId: mcpTool.serverId,
    serverName: mcpTool.serverName,
    type: 'mcp' as const
  }
  return {
    type: 'function',
    description,
    metadata: { cherry: { tool: metadata } },
    inputSchema: createMcpInputSchema(
      comfyuiUpload
        ? {
            type: 'object',
            properties: { image_filename: { type: 'string' } },
            required: ['image_filename'],
            additionalProperties: false
          }
        : (mcpTool.inputSchema as JSONSchema7)
    ),
    needsApproval: async () => forcePrompt,
    execute: async (args: Record<string, unknown>, options) => {
      const { toolCallId, abortSignal } = options
      const server = resolveActiveServerById(mcpTool.serverId)
      if (!server) {
        throw new Error(`MCP server ${mcpTool.serverId} is not active or no longer registered`)
      }
      const result: CallToolResult = comfyuiUpload
        ? await uploadComfyuiAttachment(
            server,
            String(args.image_filename),
            getRequestContext(options)?.fileAttachments ?? [],
            abortSignal,
            toolCallId
          )
        : await application.get('McpRuntimeService').callTool({
            serverId: server.id,
            name: mcpTool.name,
            args,
            callId: toolCallId,
            // Isolation scope for abort-by-id: provider call ids (e.g. "call_0") can collide
            // across topics, and the renderer's abort presents the same topicId.
            scope: getRequestContext(options)?.topicId,
            signal: abortSignal,
            interactionContext: interactionContext(options)
          })

      if (result.isError) {
        throw new Error(mcpResultToTextSummary(result) || 'MCP tool call failed')
      }

      const resources = getRequestContext(options)?.mcpToolResources
      if (resources) registerMcpToolResources(resources, result, metadata)

      // Full CallToolResult for the renderer's ToolUIPart (multimodal
      // parts intact); `toModelOutput` below produces the model's view.
      return {
        ...result,
        metadata
      }
    },
    toModelOutput({ output }) {
      // Model and wire capabilities are applied by the request's media routing.
      return mcpResultToModelOutput(output as CallToolResult, mcpTool.serverId)
    }
  }
}

function toEntry(mcpTool: McpTool, server: McpServer): ToolEntry {
  // A force-prompt (approval-gated) tool must never defer: deferring removes it from the SDK
  // tool-set, so the SDK's native `needsApproval` gate never fires and it becomes reachable only
  // via `tool_invoke` — which would run it with no approval card. Keep it inline. Reading
  // `forcePrompt` once keeps `defer` and `needsApproval` in lock-step (they must always agree).
  const forcePrompt = isMcpToolForcePromptBySource(server, mcpTool)
  return {
    name: mcpTool.id,
    namespace: namespaceForServer(server.id),
    namespaceLabel: `mcp:${server.name}`,
    description: isComfyuiUploadTool(mcpTool) ? COMFYUI_UPLOAD_DESCRIPTION : mcpTool.description || mcpTool.name,
    defer: forcePrompt ? 'never' : 'auto',
    tool: createMcpTool(mcpTool, forcePrompt),
    applies: (scope) => scope.mcpToolIds.has(mcpTool.id)
  }
}

export interface SyncMcpToolsToRegistryOptions {
  /**
   * Restrict registration to exact selected tool ids. Ownership is resolved
   * from each active server's cache-only catalog; stale-server cleanup still
   * runs globally. Omit for full reconcile (bootstrap / admin).
   */
  readonly selectedToolIds?: ReadonlySet<string>
}

/**
 * Reconcile the registry against the live server snapshot. Adds new
 * tools, replaces existing (so schema changes take effect), drops
 * deactivated — covers server uninstall and `tools/list_changed`
 * without subscribing to events.
 */
export async function syncMcpToolsToRegistry(
  reg: ToolRegistry = registry,
  opts: SyncMcpToolsToRegistryOptions = {}
): Promise<void> {
  const { items: activeServers } = mcpServerService.list({ isActive: true })
  const selectedToolIds = opts.selectedToolIds
  const targetNamespaces = new Set<string>()
  const activeNamespaces = new Set(activeServers.map((server) => namespaceForServer(server.id)))
  // Only namespaces whose `listTools` actually succeeded. A transient connection drop
  // must NOT evict a still-active server's previously-registered tools — without this
  // guard the eviction loop below sees every prior tool as `missing` and deregisters them.
  const refreshedNamespaces = new Set<string>()
  const freshNames = new Set<string>()

  if (selectedToolIds) {
    for (const entry of reg.getAll()) {
      if (selectedToolIds.has(entry.name) && entry.namespace.startsWith('mcp:')) {
        targetNamespaces.add(entry.namespace)
      }
    }
  }

  for (const server of activeServers) {
    // Every selection is accounted for, so no later server can own one — skip the
    // remaining catalog reads (and leave their namespaces out of the eviction scope).
    if (selectedToolIds && freshNames.size === selectedToolIds.size) break
    const namespace = namespaceForServer(server.id)
    try {
      const enabledTools = application.get('McpCatalogService').listTools(server.id, { includeDisabled: false })
      const scopedTools = selectedToolIds ? enabledTools.filter((tool) => selectedToolIds.has(tool.id)) : enabledTools
      if (!selectedToolIds || scopedTools.length > 0) targetNamespaces.add(namespace)
      const freshEntries: ToolEntry[] = []
      const freshServerNames = new Set<string>()
      for (const mcpTool of scopedTools) {
        // A wire id encodes serverId + protocol tool name, so a repeat can only be the
        // same identity listed twice by one server. First wins.
        if (freshNames.has(mcpTool.id) || freshServerNames.has(mcpTool.id)) continue
        freshEntries.push(toEntry(mcpTool, server))
        freshServerNames.add(mcpTool.id)
      }
      for (const entry of freshEntries) {
        reg.register(entry)
        freshNames.add(entry.name)
      }
      refreshedNamespaces.add(namespace)
    } catch (error) {
      logger.error('Failed to list MCP tools for server', {
        serverId: server.id,
        serverName: server.name,
        error
      })
    }
  }

  for (const entry of reg.getAll()) {
    if (!entry.namespace.startsWith('mcp:')) continue
    const serverDeactivated = !activeNamespaces.has(entry.namespace)
    // Gate the in-scope eviction on a successful refresh, so a failed `listTools` leaves
    // the prior snapshot intact. A truly deactivated server is still evicted regardless.
    const inSyncScope = targetNamespaces.has(entry.namespace) && refreshedNamespaces.has(entry.namespace)
    const missing = !freshNames.has(entry.name)
    const missingFromSelectedSync = selectedToolIds ? selectedToolIds.has(entry.name) : true
    if (serverDeactivated || (inSyncScope && missing && missingFromSelectedSync)) {
      reg.deregister(entry.name)
    }
  }
}

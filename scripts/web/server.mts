import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'

import { createOpenAI } from '@ai-sdk/openai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from 'ai'
import Database from 'better-sqlite3'
import { createServer as createViteServer } from 'vite'

import * as apiFormat from '../../src/shared/utils/api/format'

const formatApiHost =
  (apiFormat as unknown as { default?: typeof apiFormat }).default?.formatApiHost ?? apiFormat.formatApiHost

const password = process.env.BERRY_WEB_PASSWORD
if (!password) throw new Error('Set BERRY_WEB_PASSWORD')
type ProviderConfig = { id: string; name: string; url: string; key: string; model: string }

function savedProviders(path: string): ProviderConfig[] {
  const profile = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const rows = profile
      .prepare(
        `SELECT p.provider_id, p.name, p.endpoint_configs, p.api_keys, m.model_id
         FROM user_provider p JOIN user_model m ON m.provider_id = p.provider_id
         WHERE p.is_enabled = 1 AND m.is_enabled = 1 AND p.preset_provider_id IS NULL
           AND p.default_chat_endpoint = 'openai-chat-completions'`
      )
      .all() as Array<{
      provider_id: string
      name: string
      endpoint_configs: string | null
      api_keys: string | null
      model_id: string
    }>
    return rows.flatMap((row) => {
      const endpoint = JSON.parse(row.endpoint_configs || '{}')['openai-chat-completions']
      const key = (JSON.parse(row.api_keys || '[]') as Array<{ key: string; isEnabled: boolean }>).find(
        (item) => item.isEnabled && item.key
      )?.key
      if (!endpoint?.baseUrl || !key) return []
      return [
        {
          id: `${row.provider_id}::${row.model_id}`,
          name: row.name,
          url: formatApiHost(endpoint.baseUrl),
          key,
          model: row.model_id
        }
      ]
    })
  } finally {
    profile.close()
  }
}

function savedMcp(path: string, name?: string): { url: string; headers: Record<string, string> } | null {
  const profile = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const row = profile
      .prepare(
        `SELECT base_url, headers FROM mcp_server
         WHERE is_active = 1 AND type = 'streamableHttp' AND base_url IS NOT NULL
           AND (${name ? 'name = ?' : 'is_trusted = 1'})
         ORDER BY sort_order LIMIT 1`
      )
      .get(...(name ? [name] : [])) as { base_url: string; headers: string | null } | undefined
    if (name && !row) throw new Error(`Active Streamable HTTP MCP server ${name} was not found`)
    return row ? { url: row.base_url, headers: JSON.parse(row.headers || '{}') } : null
  } finally {
    profile.close()
  }
}

const providerConfigs: ProviderConfig[] = process.env.BERRY_WEB_PROVIDERS
  ? JSON.parse(process.env.BERRY_WEB_PROVIDERS)
  : process.env.BERRY_WEB_PROVIDER_DB
    ? savedProviders(process.env.BERRY_WEB_PROVIDER_DB)
    : [
        {
          id: 'default',
          name: 'Cloud model',
          url: process.env.BERRY_WEB_PROVIDER_URL || 'https://api.openai.com/v1',
          key: process.env.BERRY_WEB_PROVIDER_KEY,
          model: process.env.BERRY_WEB_MODEL
        }
      ]
if (
  !Array.isArray(providerConfigs) ||
  !providerConfigs.length ||
  providerConfigs.some((item) => !item.id || !item.name || !item.url || !item.key || !item.model)
)
  throw new Error('Configure BERRY_WEB_PROVIDER_DB, BERRY_WEB_PROVIDERS, or BERRY_WEB_PROVIDER_KEY and BERRY_WEB_MODEL')
const providers = new Map(
  providerConfigs.map((item) => [item.id, { ...item, sdk: createOpenAI({ apiKey: item.key, baseURL: item.url }) }])
)
const mcpConfig = process.env.BERRY_WEB_MCP_URL
  ? { url: process.env.BERRY_WEB_MCP_URL, headers: {} }
  : process.env.BERRY_WEB_PROVIDER_DB
    ? savedMcp(process.env.BERRY_WEB_PROVIDER_DB, process.env.BERRY_WEB_MCP_NAME)
    : null

const port = Number(process.env.BERRY_WEB_PORT || 4174)
const host = process.env.BERRY_WEB_HOST || '127.0.0.1'
const db = new Database(process.env.BERRY_WEB_DATABASE || resolve('berry-web.sqlite'))
db.pragma('journal_mode = WAL')
db.exec(
  'CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, media_type TEXT NOT NULL, bytes BLOB NOT NULL)'
)
if (!(db.pragma('table_info(messages)') as Array<{ name: string }>).some((column) => column.name === 'image_id'))
  db.exec('ALTER TABLE messages ADD COLUMN image_id TEXT')

function saveImage(mediaType: string, bytes: Buffer) {
  const id = randomBytes(16).toString('hex')
  db.prepare('INSERT INTO images VALUES (?, ?, ?)').run(id, mediaType, bytes)
  return id
}

function modelMessages(chatId: string): ModelMessage[] {
  const rows = db
    .prepare('SELECT role, content, image_id FROM messages WHERE chat_id = ? ORDER BY created_at, rowid')
    .all(chatId) as Array<{ role: 'user' | 'assistant'; content: string; image_id: string | null }>
  return rows.map((row) => {
    if (!row.image_id) return { role: row.role, content: row.content }
    const image = db.prepare('SELECT media_type, bytes FROM images WHERE id = ?').get(row.image_id) as {
      media_type: string
      bytes: Buffer
    }
    return {
      role: 'user',
      content: [
        { type: 'text', text: row.content },
        { type: 'image', image: image.bytes, mediaType: image.media_type }
      ]
    }
  })
}

const sessions = new Set<string>()
const pending = new Map<
  string,
  {
    chatId: string
    providerId: string
    messages: ModelMessage[]
    approvalId: string
    client: Client
    transport: StreamableHTTPClientTransport
    tools: ToolSet
  }
>()
const vite = await createViteServer({ configFile: resolve('web.vite.config.mts'), server: { middlewareMode: true } })

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function body(req: IncomingMessage): Promise<any> {
  let value = ''
  for await (const chunk of req) {
    value += chunk
    if (value.length > 14_000_000) throw new Error('Request too large')
  }
  return JSON.parse(value || '{}')
}

function authenticated(req: IncomingMessage) {
  const token = /(?:^|; )berry_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]
  return token !== undefined && sessions.has(token)
}

function writeEvent(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function mcpTools() {
  if (!mcpConfig) return null
  const client = new Client({ name: 'berry-web', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), {
    requestInit: { headers: mcpConfig.headers }
  })
  await client.connect(transport)
  const catalog = await client.listTools()
  const tools: ToolSet = {}
  for (const item of catalog.tools) {
    tools[item.name] = tool({
      description: item.description,
      inputSchema: jsonSchema(item.inputSchema as any),
      needsApproval: true,
      execute: async (input) => client.callTool({ name: item.name, arguments: input as Record<string, unknown> })
    })
  }
  return { client, transport, tools }
}

async function stream(
  res: ServerResponse,
  chatId: string,
  providerId: string,
  messages: ModelMessage[],
  mcp: Awaited<ReturnType<typeof mcpTools>>
) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  })
  const result = streamText({
    model: providers.get(providerId)!.sdk.chat(providers.get(providerId)!.model),
    messages,
    tools: mcp?.tools,
    maxOutputTokens: 2048,
    stopWhen: stepCountIs(4),
    providerOptions: { openai: { parallelToolCalls: false } }
  })
  let answer = ''
  let waiting = false
  const approvals: Array<{ approvalId: string; name: string; input: unknown }> = []
  try {
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        answer += part.text
        writeEvent(res, 'delta', { text: part.text })
      } else if (part.type === 'tool-result') {
        const output = part.output as {
          content?: Array<{ type: string; data?: string; mimeType?: string; url?: string }>
        }
        for (const item of output.content || []) {
          let url = item.url
          if (item.type === 'image' && item.data && item.mimeType?.startsWith('image/')) {
            const id = saveImage(item.mimeType, Buffer.from(item.data, 'base64'))
            url = `/api/images/${id}`
          }
          if (url && /^https?:\/\/|^\/api\/images\//.test(url)) {
            const markdown = `\n![Tool image](${url})\n`
            answer += markdown
            writeEvent(res, 'delta', { text: markdown })
          }
        }
      } else if (part.type === 'tool-approval-request' && mcp) {
        waiting = true
        approvals.push({ approvalId: part.approvalId, name: part.toolCall.toolName, input: part.toolCall.input })
      } else if (part.type === 'error') {
        throw part.error
      }
    }
    if (approvals.length > 1) throw new Error('Only one MCP tool call can be approved at a time')
    if (approvals.length) {
      const responseMessages = (await result.response).messages
      for (const approval of approvals) {
        const id = randomBytes(16).toString('hex')
        pending.set(id, {
          chatId,
          providerId,
          messages: [...messages, ...responseMessages],
          approvalId: approval.approvalId,
          ...mcp!
        })
        writeEvent(res, 'approval', { id, name: approval.name, input: approval.input })
      }
    }
    if (answer)
      db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
        randomBytes(16).toString('hex'),
        chatId,
        'assistant',
        answer,
        Date.now()
      )
    writeEvent(res, 'done', { waiting })
  } catch (error) {
    waiting = false
    writeEvent(res, 'error', { message: error instanceof Error ? error.message : 'Model request failed' })
  } finally {
    res.end()
    if (!waiting && mcp) await mcp.client.close()
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`)
  try {
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const input = await body(req)
      const supplied = Buffer.from(String(input.password || ''))
      const expected = Buffer.from(password)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return sendJson(res, 401, { error: 'Incorrect password' })
      const token = randomBytes(32).toString('hex')
      sessions.add(token)
      res.setHeader('Set-Cookie', `berry_session=${token}; HttpOnly; SameSite=Strict; Path=/`)
      return sendJson(res, 200, { ok: true })
    }
    if (url.pathname.startsWith('/api/')) {
      if (!authenticated(req)) return sendJson(res, 401, { error: 'Sign in required' })
      if (url.pathname === '/api/config')
        return sendJson(res, 200, {
          providers: providerConfigs.map(({ id, name, model }) => ({ id, name, model })),
          mcp: !!mcpConfig
        })
      const imageId = /^\/api\/images\/([a-f0-9]{32})$/.exec(url.pathname)?.[1]
      if (imageId && req.method === 'GET') {
        const image = db.prepare('SELECT media_type, bytes FROM images WHERE id = ?').get(imageId) as
          | { media_type: string; bytes: Buffer }
          | undefined
        if (!image) return sendJson(res, 404, { error: 'Image not found' })
        res.writeHead(200, {
          'Content-Type': image.media_type,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff'
        })
        return res.end(image.bytes)
      }
      if (url.pathname === '/api/chats' && req.method === 'GET')
        return sendJson(res, 200, db.prepare('SELECT * FROM chats ORDER BY created_at DESC').all())
      if (url.pathname === '/api/chats' && req.method === 'POST') {
        const id = randomBytes(16).toString('hex')
        db.prepare('INSERT INTO chats VALUES (?, ?, ?)').run(id, 'New chat', Date.now())
        return sendJson(res, 201, { id })
      }
      const chatId = /^\/api\/chats\/([a-f0-9]{32})$/.exec(url.pathname)?.[1]
      if (chatId && req.method === 'GET')
        return sendJson(
          res,
          200,
          db
            .prepare('SELECT role, content, image_id FROM messages WHERE chat_id = ? ORDER BY created_at, rowid')
            .all(chatId)
        )
      if (url.pathname === '/api/upload' && req.method === 'POST') {
        const input = await body(req)
        const mediaType = String(input.mediaType || '')
        const data = String(input.data || '')
        if (!/^image\/(png|jpeg|webp|gif)$/.test(mediaType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
          return sendJson(res, 400, { error: 'Invalid image' })
        const bytes = Buffer.from(data, 'base64')
        if (bytes.length > 10_000_000) return sendJson(res, 413, { error: 'Image too large' })
        return sendJson(res, 201, { id: saveImage(mediaType, bytes) })
      }
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const input = await body(req)
        if (!providers.has(input.providerId)) return sendJson(res, 400, { error: 'Unknown provider' })
        if (
          typeof input.chatId !== 'string' ||
          typeof input.text !== 'string' ||
          (!input.text.trim() && !input.imageId) ||
          input.text.length > 20_000
        )
          return sendJson(res, 400, { error: 'Invalid message' })
        if (input.imageId && !db.prepare('SELECT id FROM images WHERE id = ?').get(input.imageId))
          return sendJson(res, 400, { error: 'Invalid image' })
        if (!db.prepare('SELECT id FROM chats WHERE id = ?').get(input.chatId))
          return sendJson(res, 404, { error: 'Chat not found' })
        db.prepare(
          'INSERT INTO messages (id, chat_id, role, content, created_at, image_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(randomBytes(16).toString('hex'), input.chatId, 'user', input.text, Date.now(), input.imageId || null)
        db.prepare('UPDATE chats SET title = ? WHERE id = ? AND title = ?').run(
          input.text.slice(0, 60),
          input.chatId,
          'New chat'
        )
        return await stream(res, input.chatId, input.providerId, modelMessages(input.chatId), await mcpTools())
      }
      if (url.pathname === '/api/approve' && req.method === 'POST') {
        const input = await body(req)
        const item = pending.get(input.id)
        if (!item) return sendJson(res, 404, { error: 'Approval expired' })
        pending.delete(input.id)
        const approval: ModelMessage = {
          role: 'tool',
          content: [{ type: 'tool-approval-response', approvalId: item.approvalId, approved: input.approved === true }]
        }
        return await stream(res, item.chatId, item.providerId, [...item.messages, approval], item)
      }
      return sendJson(res, 404, { error: 'Not found' })
    }
    vite.middlewares(req, res, () => {
      res.writeHead(404)
      res.end()
    })
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : 'Server error' })
  }
})
server.listen(port, host)

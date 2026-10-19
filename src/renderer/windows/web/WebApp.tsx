import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input, Markdown } from '@cherrystudio/ui'

type Message = { role: 'user' | 'assistant'; content: string; image_id?: string | null }
type Chat = { id: string; title: string }
type Approval = { id: string; name: string; input: unknown }
type Provider = { id: string; name: string; model: string }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers }
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'Request failed')
  return value as T
}

async function readStream(response: Response, onEvent: (name: string, data: any) => void) {
  if (!response.ok || !response.body) throw new Error((await response.json()).error || 'Request failed')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let end = buffer.indexOf('\n\n')
    while (end >= 0) {
      const event = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const name = /^event: (.+)$/m.exec(event)?.[1]
      const data = /^data: (.+)$/m.exec(event)?.[1]
      if (name && data) onEvent(name, JSON.parse(data))
      end = buffer.indexOf('\n\n')
    }
  }
}

function WebApp() {
  const { t } = useTranslation()
  const [signedIn, setSignedIn] = useState(false)
  const [password, setPassword] = useState('')
  const [chats, setChats] = useState<Chat[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [image, setImage] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [error, setError] = useState('')
  const [providers, setProviders] = useState<Provider[]>([])
  const [providerId, setProviderId] = useState('')

  useEffect(() => {
    request('/api/chats')
      .then((items: any) => {
        setSignedIn(true)
        setChats(items)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (signedIn)
      request<{ providers: Provider[] }>('/api/config')
        .then((config) => {
          setProviders(config.providers)
          setProviderId((current) => current || config.providers[0]?.id || '')
        })
        .catch(() => {})
  }, [signedIn])

  async function signIn() {
    try {
      await request('/api/login', { method: 'POST', body: JSON.stringify({ password }) })
      setPassword('')
      setSignedIn(true)
      setChats(await request('/api/chats'))
      setError('')
    } catch (cause) {
      setError(String(cause))
    }
  }

  async function openChat(id: string) {
    setChatId(id)
    setMessages(await request(`/api/chats/${id}`))
    setApproval(null)
  }

  async function newChat() {
    const chat = await request<{ id: string }>('/api/chats', { method: 'POST' })
    setChats(await request('/api/chats'))
    await openChat(chat.id)
  }

  async function consume(response: Response) {
    await readStream(response, (name, data) => {
      if (name === 'delta')
        setMessages((old) => {
          const last = old.at(-1)
          return last?.role === 'assistant'
            ? [...old.slice(0, -1), { ...last, content: last.content + data.text }]
            : [...old, { role: 'assistant', content: data.text }]
        })
      if (name === 'approval') setApproval(data)
      if (name === 'error') setError(data.message)
    })
  }

  async function send() {
    if (!chatId || !providerId || (!draft.trim() && !image) || busy) return
    const text = draft.trim()
    setDraft('')
    setMessages((old) => [...old, { role: 'user', content: text, image_id: image?.id }])
    const imageId = image?.id
    setImage(null)
    setBusy(true)
    setError('')
    try {
      await consume(
        await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, providerId, text, imageId })
        })
      )
      setChats(await request('/api/chats'))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function upload(file: File) {
    if (file.size > 10_000_000) return setError(t('message.error.avatar_image_too_large', { limit: '10 MB' }))
    setError('')
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const result = await request<{ id: string }>('/api/upload', {
        method: 'POST',
        body: JSON.stringify({ mediaType: file.type, data })
      })
      setImage({ id: result.id, name: file.name })
    } catch (cause) {
      setError(String(cause))
    }
  }

  async function decide(approved: boolean) {
    if (!approval) return
    const id = approval.id
    setApproval(null)
    setBusy(true)
    try {
      await consume(
        await fetch('/api/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, approved })
        })
      )
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!signedIn)
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-semibold">{t('web.title')}</h1>
        <Input
          type="password"
          aria-label={t('web.password')}
          placeholder={t('web.password')}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && signIn()}
        />
        <Button onClick={signIn}>{t('web.signIn')}</Button>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </main>
    )

  return (
    <main className="mx-auto flex h-dvh max-w-5xl flex-col md:flex-row">
      <aside className="flex shrink-0 gap-2 overflow-x-auto border-b border-border p-3 md:w-60 md:flex-col md:border-b-0 md:border-r">
        <Button variant="outline" onClick={newChat}>
          {t('web.newChat')}
        </Button>
        {chats.map((chat) => (
          <Button
            key={chat.id}
            variant={chat.id === chatId ? 'secondary' : 'ghost'}
            className="max-w-44 justify-start truncate md:max-w-none"
            onClick={() => openChat(chat.id)}>
            {chat.title}
          </Button>
        ))}
      </aside>
      <section className="flex min-h-0 flex-1 flex-col">
        <header className="border-b border-border px-4 py-3 font-medium">{t('web.cloudChat')}</header>
        <div className="flex gap-2 overflow-x-auto border-b border-border p-2">
          {providers.map((item) => (
            <Button
              key={item.id}
              variant={item.id === providerId ? 'secondary' : 'ghost'}
              onClick={() => setProviderId(item.id)}
              disabled={busy || !!approval}>
              {item.name} · {item.model}
            </Button>
          ))}
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
          {messages.map((message, index) => (
            <article
              key={index}
              className={`max-w-[90%] rounded-xl p-3 ${message.role === 'user' ? 'ml-auto bg-secondary' : 'bg-card'}`}>
              <Markdown id={`${chatId}-${index}`}>{message.content}</Markdown>
              {message.image_id && (
                <img src={`/api/images/${message.image_id}`} alt="" className="mt-2 max-h-80 max-w-full rounded-lg" />
              )}
            </article>
          ))}
          {approval && (
            <div className="rounded-lg border border-warning p-3">
              <p className="font-medium">{t('web.allowTool', { name: approval.name })}</p>
              <pre className="my-2 overflow-auto text-xs">{JSON.stringify(approval.input, null, 2)}</pre>
              <div className="flex gap-2">
                <Button onClick={() => decide(true)}>{t('web.allow')}</Button>
                <Button variant="outline" onClick={() => decide(false)}>
                  {t('web.deny')}
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <form
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}>
          <Input
            className="col-span-2"
            aria-label={t('web.message')}
            placeholder={chatId ? t('web.message') : t('web.createChat')}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!chatId || busy || !!approval}
          />
          <label className="relative inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm focus-within:ring-2 focus-within:ring-ring">
            {t('chat.input.upload.attachment')}
            {image && <span className="truncate text-xs">{image.name}</span>}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              disabled={!chatId || busy || !!approval}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void upload(file)
              }}
            />
          </label>
          <Button type="submit" disabled={!chatId || (!draft.trim() && !image) || busy || !!approval}>
            {t('chat.input.send')}
          </Button>
        </form>
      </section>
    </main>
  )
}

export default WebApp

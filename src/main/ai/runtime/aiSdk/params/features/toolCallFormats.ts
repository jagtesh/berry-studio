export interface TextToolCall {
  toolName: string
  args: Record<string, unknown>
}

// These grammars consume data literals only; model output is never evaluated as code.
class LiteralReader {
  private cursor = 0

  constructor(
    private readonly source: string,
    private readonly dialect: 'python' | 'gemma'
  ) {}

  take(token: string): boolean {
    this.space()
    if (!this.source.startsWith(token, this.cursor)) return false
    this.cursor += token.length
    return true
  }

  expect(token: string): void {
    if (!this.take(token)) throw new SyntaxError('Unexpected tool-call token')
  }

  name(): string {
    this.space()
    const match = /^[A-Za-z_][A-Za-z_0-9]*/.exec(this.source.slice(this.cursor))
    if (!match) throw new SyntaxError('Expected a tool-call identifier')
    this.cursor += match[0].length
    return match[0]
  }

  end(): void {
    this.space()
    if (this.cursor !== this.source.length) throw new SyntaxError('Trailing tool-call content')
  }

  entries(close: string, separator: string, depth = 0): Record<string, unknown> {
    const entries: Array<[string, unknown]> = []
    while (!this.take(close)) {
      const key = separator === '=' || this.dialect === 'gemma' ? this.name() : this.string()
      this.expect(separator)
      if (entries.some(([name]) => name === key)) throw new SyntaxError('Duplicate tool argument')
      entries.push([key, this.value(depth + 1)])
      if (!this.take(',')) {
        this.expect(close)
        break
      }
    }
    return Object.fromEntries(entries)
  }

  value(depth = 0): unknown {
    if (depth > 64) throw new SyntaxError('Tool-call nesting limit exceeded')
    this.space()
    const quote = this.dialect === 'gemma' ? '<|"|>' : this.source[this.cursor]
    if (this.source.startsWith(quote, this.cursor) && (quote === '<|"|>' || quote === "'" || quote === '"')) {
      return this.string()
    }
    if (this.take('{')) return this.entries('}', ':', depth)
    if (this.take('[')) {
      const values: unknown[] = []
      while (!this.take(']')) {
        values.push(this.value(depth + 1))
        if (!this.take(',')) {
          this.expect(']')
          break
        }
      }
      return values
    }
    const literals =
      this.dialect === 'python' ? { True: true, False: false, None: null } : { true: true, false: false, null: null }
    for (const [token, value] of Object.entries(literals)) {
      if (this.take(token)) return value
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.cursor))
    if (!number || !Number.isFinite(Number(number[0]))) throw new SyntaxError('Expected a data literal')
    this.cursor += number[0].length
    return Number(number[0])
  }

  private string(): string {
    this.space()
    const quote = this.dialect === 'gemma' ? '<|"|>' : this.source[this.cursor]
    if (quote !== '<|"|>' && quote !== "'" && quote !== '"') throw new SyntaxError('Expected a string')
    this.expect(quote)
    let result = ''
    while (this.cursor < this.source.length) {
      if (this.source.startsWith(quote, this.cursor)) {
        this.cursor += quote.length
        return result
      }
      const char = this.source[this.cursor++]
      if (char !== '\\' || this.dialect === 'gemma') {
        result += char
        continue
      }
      const escape = this.source[this.cursor++]
      if (escape === "'") result += "'"
      else if (escape === 'x') {
        const hex = this.source.slice(this.cursor, this.cursor + 2)
        if (!/^[\da-fA-F]{2}$/.test(hex)) throw new SyntaxError('Invalid string escape')
        result += String.fromCharCode(Number.parseInt(hex, 16))
        this.cursor += 2
      } else {
        const length = escape === 'u' ? 4 : 0
        result += JSON.parse(`"\\${escape}${this.source.slice(this.cursor, this.cursor + length)}"`)
        this.cursor += length
      }
    }
    throw new SyntaxError('Unclosed tool-call string')
  }

  private space(): void {
    while (/\s/.test(this.source[this.cursor] ?? '') && this.cursor < this.source.length) this.cursor++
  }
}

export function parseLfmToolCalls(source: string): TextToolCall[] {
  const reader = new LiteralReader(source, 'python')
  const calls: TextToolCall[] = []
  reader.expect('[')
  while (!reader.take(']')) {
    const toolName = reader.name()
    reader.expect('(')
    calls.push({ toolName, args: reader.entries(')', '=') })
    if (!reader.take(',')) {
      reader.expect(']')
      break
    }
  }
  reader.end()
  return calls
}

export function parseGemmaToolCalls(source: string): TextToolCall[] {
  const reader = new LiteralReader(source, 'gemma')
  reader.expect('call:')
  const toolName = reader.name()
  reader.expect('{')
  const args = reader.entries('}', ':')
  reader.end()
  return [{ toolName, args }]
}

/**
 * Incremental server-sent-events parser (ported from atomcode2dsh/sse.ts,
 * itself a port of freegw's util/sse.ts).
 *
 * Feeds raw text chunks, emits complete `data:` payloads. Comment lines
 * (`: keep-alive`) are ignored; the `data:` value is the join of all data
 * lines of one event, per the SSE spec. A `data: [DONE]` payload is the
 * upstream's close signal — callers compare the trimmed value.
 */

export interface SseEvent {
  data: string
}

export class SseParser {
  #buffer = ''
  #dataLines: string[] = []

  /** Push one text chunk; returns the events completed by it. */
  push(chunk: string): SseEvent[] {
    this.#buffer += chunk
    const events: SseEvent[] = []
    let index: number
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '')
      this.#buffer = this.#buffer.slice(index + 1)
      if (line === '') {
        if (this.#dataLines.length > 0) {
          events.push({ data: this.#dataLines.join('\n') })
          this.#dataLines = []
        }
        continue
      }
      if (line.startsWith(':')) continue // comment / keep-alive
      if (line.startsWith('data:')) {
        this.#dataLines.push(line.slice(5).replace(/^ /, ''))
      }
      // event:/id:/retry: are irrelevant for chat passthrough.
    }
    return events
  }

  /**
   * Flush a trailing event that arrived without a terminating blank line: the
   * unterminated buffer line is consumed as a final `data:` line.
   */
  flush(): SseEvent[] {
    if (this.#buffer.length > 0) {
      const line = this.#buffer.replace(/\r$/, '')
      this.#buffer = ''
      if (line.startsWith('data:')) this.#dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (this.#dataLines.length === 0) return []
    const events = [{ data: this.#dataLines.join('\n') }]
    this.#dataLines = []
    return events
  }
}

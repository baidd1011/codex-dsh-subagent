import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Terminal or live status returned by the MCP tools. */
export type TaskStatus = 'running' | 'completed' | 'max-tokens' | 'error' | 'aborted' | 'incomplete'

/** Token totals exposed by task results. */
export interface TaskUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Result facts reconstructed from one task-owned event interval. */
export interface EventSummary {
  readonly status: TaskStatus
  readonly result?: string
  readonly reason?: string
  readonly usage?: TaskUsage
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Bound text to complete UTF-8 code points within a byte limit.
 * @param text - text to return.
 * @param maxBytes - maximum encoded byte length.
 * @returns the complete prefix that fits.
 */
export function trimUtf8(text: string, maxBytes: number): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text
  const bytes = encoder.encode(text)
  for (let end = maxBytes; end > 0; end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end))
    } catch (_error: unknown) {
      // A UTF-8 code point spans at most four bytes, so only the truncated
      // suffix can fail before the next shorter prefix decodes cleanly.
    }
  }
  return ''
}

function toTaskUsage(usage: TokenUsage): TaskUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens },
    ...usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens },
    ...usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens },
  }
}

/**
 * Add one model response's token usage to an optional running total.
 * @param total - accumulated usage, when any response has been counted.
 * @param next - usage from the next response.
 * @returns the accumulated token totals.
 */
export function addUsage(total: TaskUsage | undefined, next: TokenUsage): TaskUsage {
  if (total === undefined) return toTaskUsage(next)
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...total.cacheReadTokens === undefined && next.cacheReadTokens === undefined ? {} : {
      cacheReadTokens: (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    },
    ...total.cacheWriteTokens === undefined && next.cacheWriteTokens === undefined ? {} : {
      cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    },
    ...total.reasoningTokens === undefined && next.reasoningTokens === undefined ? {} : {
      reasoningTokens: (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
    },
  }
}

/**
 * Accumulate assistant-message usage from a durable event interval.
 * @param events - task or descendant events to inspect.
 * @returns token totals, or undefined when no response recorded usage.
 */
export function usageFromEvents(events: readonly SessionEvent[]): TaskUsage | undefined {
  let usage: TaskUsage | undefined
  for (const event of events) {
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      usage = addUsage(usage, event.data.usage)
    }
  }
  return usage
}

function messageText(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

function reasonText(reason: { kind: string; error?: unknown }): string {
  if (reason.kind === 'error') {
    const error = reason.error
    if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message)
    return String(error)
  }
  return reason.kind
}

function reasonStatus(reason: { kind: string }): TaskStatus {
  switch (reason.kind) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    case 'interrupted': return 'incomplete'
    case 'blocked':
    case 'error': return 'error'
    default: return 'error'
  }
}

/**
 * Reconstruct one task result from its selected durable events.
 * @param events - task-owned session events.
 * @param maxResultBytes - maximum UTF-8 bytes returned for result text.
 * @returns terminal or incomplete result facts and accumulated usage.
 */
export function summarizeEvents(events: readonly SessionEvent[], maxResultBytes: number): EventSummary {
  let result: string | undefined
  let reason: { kind: string; error?: unknown } | undefined
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const text = messageText(event.data.message)
      if (text.length > 0) result = text
    } else if (event.type === 'turn/end') {
      reason = event.data.reason
    }
  }
  const usage = usageFromEvents(events)
  let openTurn = false
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = true
    else if (event.type === 'turn/end') openTurn = false
  }
  if (reason === undefined || openTurn) {
    return {
      status: 'incomplete',
      ...result === undefined ? {} : { result: trimUtf8(result, maxResultBytes) },
      ...usage === undefined ? {} : { usage },
      reason: openTurn ? 'session has an unfinished turn' : 'session has no completed turn',
    }
  }
  return {
    status: reasonStatus(reason),
    ...result === undefined ? {} : { result: trimUtf8(result, maxResultBytes) },
    reason: reasonText(reason),
    ...usage === undefined ? {} : { usage },
  }
}

/**
 * Select the durable event interval owned by one MCP task.
 * @param events - the session log in sequence order.
 * @param startSeq - sequence of the task-started marker.
 * @param messageId - durable user message submitted for this task.
 * @param turn - claimed turn, when the Agent reached the inbox boundary.
 * @param endedSeq - task-ended marker sequence, when one was persisted.
 * @returns the task-owned event interval.
 */
export function taskEventSlice(
  events: readonly SessionEvent[],
  startSeq: number,
  messageId: string | undefined,
  turn: number | undefined,
  endedSeq?: number,
): readonly SessionEvent[] {
  const startIndex = events.findIndex(event => event.seq >= startSeq)
  if (startIndex < 0) return []
  const endIndexFromSeq = endedSeq === undefined
    ? undefined
    : events.findIndex(event => event.seq === endedSeq)
  if (endIndexFromSeq !== undefined && endIndexFromSeq >= startIndex) {
    return events.slice(startIndex, endIndexFromSeq + 1)
  }
  const messageIndex = messageId === undefined ? -1 : events.findIndex(event =>
    event.type === 'user/message' && event.data.id === messageId && event.seq >= startSeq)
  const turnStartIndex = turn === undefined
    ? messageIndex < 0 ? -1 : events.findLastIndex((event, index) =>
      index >= startIndex && index <= messageIndex && event.type === 'turn/start')
    : events.findIndex(event => event.seq >= startSeq && event.type === 'turn/start' && event.data.turn === turn)
  if (turnStartIndex < 0) {
    return events.slice(startIndex, Math.max(startIndex, messageIndex) + 1)
  }
  const turnStart = events[turnStartIndex]
  const selectedTurn = turnStart?.type === 'turn/start'
    ? turnStart.data.turn
    : turn
  const turnEndIndex = selectedTurn === undefined ? -1 : events.findIndex((event, index) =>
    index >= turnStartIndex && event.type === 'turn/end' && event.data.turn === selectedTurn)
  if (turnEndIndex >= turnStartIndex) return events.slice(startIndex, turnEndIndex + 1)
  const nextTurnIndex = events.findIndex((event, index) =>
    index > turnStartIndex && event.type === 'turn/start')
  return events.slice(startIndex, nextTurnIndex < 0 ? events.length : nextTurnIndex)
}

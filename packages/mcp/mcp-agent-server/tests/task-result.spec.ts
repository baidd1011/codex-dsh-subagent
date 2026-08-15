import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { summarizeEvents, taskEventSlice, trimUtf8 } from '../src/task-result.ts'

function event(type: string, seq: number, data: object): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent
}

describe('MCP task result reconstruction', () => {
  it('keeps exact UTF-8 limits and removes incomplete multibyte code points', () => {
    expect(trimUtf8('tiny', 8)).toBe('tiny')
    expect(trimUtf8('exact', 5)).toBe('exact')
    expect(trimUtf8('oversized', 4)).toBe('over')
    expect(trimUtf8('你a', 3)).toBe('你')
    expect(trimUtf8('你a', 2)).toBe('')
    expect(trimUtf8('😀a', 4)).toBe('😀')
    expect(trimUtf8('😀a', 3)).toBe('')
  })

  it('stops a task that claimed no turn at its own durable message', () => {
    const events = [
      event('mcp-agent/task-started', 0, { taskId: 'task', messageId: 'task-message' }),
      event('user/message', 1, { id: 'task-message', content: [], source: { kind: 'user' } }),
      event('user/message', 2, { id: 'page-message', content: [], source: { kind: 'user' } }),
    ]
    expect(taskEventSlice(events, 0, 'task-message', undefined).map(item => item.seq)).toEqual([0, 1])
  })

  it('stops an unfinished task before a later page turn', () => {
    const events = [
      event('mcp-agent/task-started', 0, { taskId: 'task', messageId: 'task-message' }),
      event('turn/start', 1, { turn: 4 }),
      event('user/message', 2, { id: 'task-message', content: [], source: { kind: 'user' } }),
      event('assistant/message', 3, {
        message: { content: [{ type: 'text', text: 'partial' }] },
        usage: { inputTokens: 2, outputTokens: 1 },
      }),
      event('turn/start', 4, { turn: 5 }),
      event('user/message', 5, { id: 'page-message', content: [], source: { kind: 'user' } }),
    ]
    const selected = taskEventSlice(events, 0, 'task-message', 4)
    expect(selected.map(item => item.seq)).toEqual([0, 1, 2, 3])
    expect(summarizeEvents(selected, 7)).toEqual({
      status: 'incomplete',
      result: 'partial',
      reason: 'session has an unfinished turn',
      usage: { inputTokens: 2, outputTokens: 1 },
    })
  })

  it('uses the exact persisted end marker and the final non-empty assistant result', () => {
    const events = [
      event('mcp-agent/task-started', 10, { taskId: 'task', messageId: 'task-message' }),
      event('turn/start', 11, { turn: 2 }),
      event('assistant/message', 12, {
        message: { content: [{ type: 'text', text: 'old' }] },
        usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 },
      }),
      event('assistant/message', 13, {
        message: { content: [{ type: 'text', text: '最终答案' }] },
        usage: { inputTokens: 4, outputTokens: 3, reasoningTokens: 2 },
      }),
      event('turn/end', 14, { turn: 2, reason: { kind: 'completed' } }),
      event('mcp-agent/task-ended', 15, { taskId: 'task', messageId: 'task-message', turn: 2, status: 'completed' }),
      event('user/message', 16, { id: 'later', content: [], source: { kind: 'user' } }),
    ]
    const selected = taskEventSlice(events, 10, 'task-message', 2, 15)
    expect(selected.map(item => item.seq)).toEqual([10, 11, 12, 13, 14, 15])
    expect(summarizeEvents(selected, 6)).toEqual({
      status: 'completed',
      result: '最终',
      reason: 'completed',
      usage: {
        inputTokens: 7,
        outputTokens: 5,
        cacheReadTokens: 1,
        reasoningTokens: 2,
      },
    })
  })
})

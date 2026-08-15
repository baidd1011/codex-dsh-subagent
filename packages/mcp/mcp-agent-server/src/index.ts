/**
 * MCP server that automates ordinary DSH sessions for an external caller such
 * as Codex. Each delegated session owns its selected DSH preset, prompt,
 * tools, loop, persistence and compaction; the MCP caller supplies task text
 * and the user's explicit preset choice only.
 *
 * @module @deepseek-ai/dsh-mcp-agent-server
 */

import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z as mcpZ } from 'zod'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AgentOptions, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JobOutcome, JobId } from '@deepseek-ai/dsh-jobs'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// These imports merge the service and session-event declarations into this host face.
import type {} from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { CUSTOM_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-host-apiproxy'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable correlation marker for one Codex-dispatched task. */
    'mcp-agent/task-started': { taskId: string; messageId: string }
    /** Durable terminal marker for one Codex-dispatched task. */
    'mcp-agent/task-ended': { taskId: string; messageId: string; turn: number; status: TaskStatus }
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'mcp-agent': 'mcp-agent'
  }
}

/** Process-local opaque handle returned by `delegate_task`. */
export type RunId = Branded<'McpAgentRunId'>

/**
 * Brand a process-local MCP run id.
 * @param value - opaque run id returned by the process-local registry.
 * @returns the branded run id.
 */
export function RunId(value: string): RunId {
  return value as RunId
}

/** Native DSH permission-preset id accepted by the delegation surface. */
export type PermissionPreset = string

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

/** Structured result shared by the MCP task tools. */
export interface TaskResult {
  runId: string
  sessionId: string
  status: TaskStatus
  result?: string
  reason?: string
  usage?: TaskUsage
}

/** Server configuration shared by stdio and Web transports. */
export interface Config {
  /** Existing absolute directories that may be delegated. */
  allowedRoots: string[]
  /** Native permission presets that a new session may request. */
  allowedPermissionPresets?: PermissionPreset[]
  /** Permission preset used when a delegate request omits `permissionPreset`. */
  defaultPermissionPreset?: PermissionPreset
  /** Maximum bounded wait accepted by `get_task`. */
  maxWaitMs?: number
  /** Maximum UTF-8 bytes returned in the final `result` field. */
  maxResultBytes?: number
}

const PERMISSION_PRESET_SCHEMA = z.string()
const MAX_TIMER_MS = 2_147_483_647

function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && value.trim().length > 0
}

/** Schemastery schema for the MCP server configuration. */
export const Config: z<Config> = z.object({
  allowedRoots: z.array(z.string()).required(),
  allowedPermissionPresets: z.array(PERMISSION_PRESET_SCHEMA).default(['read-only']),
  defaultPermissionPreset: PERMISSION_PRESET_SCHEMA.default('read-only'),
  maxWaitMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(30_000),
  maxResultBytes: z.number().step(1).min(1).default(65_536),
})

interface ResolvedConfig {
  readonly allowedRoots: readonly string[]
  readonly allowedPermissionPresets: readonly PermissionPreset[]
  readonly defaultPermissionPreset: PermissionPreset
  readonly maxWaitMs: number
  readonly maxResultBytes: number
}

interface RunRecord {
  readonly runId: RunId
  readonly sessionId: SessionId
  readonly cwd: string
  readonly workspaceKey: string
  readonly workspaceWriter: boolean
  readonly permissionPreset: PermissionPreset
  readonly agentPreset: string
  readonly resume: boolean
  readonly task: string
  readonly taskId: string
  messageId?: string
  turn?: number
  readonly cancel: AbortController
  readonly startedAt: number
  jobId?: JobId
  handle?: AgentHandle
  agent?: Agent
  startSeq: number
  cancelRequested: boolean
  shutdownRequested: boolean
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: unknown) => void
  readySettled: boolean
  response?: TaskResult
  completion?: Promise<TaskResult>
}

function taskReadyState(): Pick<RunRecord, 'ready' | 'resolveReady' | 'rejectReady' | 'readySettled'> {
  const ready = Promise.withResolvers<void>()
  return {
    ready: ready.promise,
    resolveReady: ready.resolve,
    rejectReady: ready.reject,
    readySettled: false,
  }
}

interface EventSummary {
  readonly status: TaskStatus
  readonly result?: string
  readonly reason?: string
  readonly usage?: TaskUsage
}

const TASK_STATUSES = ['running', 'completed', 'max-tokens', 'error', 'aborted', 'incomplete'] as const
const TASK_OUTPUT_SCHEMA = {
  runId: mcpZ.string(),
  sessionId: mcpZ.string(),
  status: mcpZ.enum(TASK_STATUSES),
  result: mcpZ.string().optional(),
  reason: mcpZ.string().optional(),
  usage: mcpZ.object({
    inputTokens: mcpZ.number(),
    outputTokens: mcpZ.number(),
    cacheReadTokens: mcpZ.number().optional(),
    cacheWriteTokens: mcpZ.number().optional(),
    reasoningTokens: mcpZ.number().optional(),
  }).optional(),
} as const

const DELEGATE_INPUT_SCHEMA = mcpZ.object({
  task: mcpZ.string().min(1),
  cwd: mcpZ.string().min(1),
  agentPreset: mcpZ.string().min(1),
  permissionPreset: mcpZ.string().min(1).optional(),
}).strict()
type DelegateTaskInput = mcpZ.infer<typeof DELEGATE_INPUT_SCHEMA>

const GET_INPUT_SCHEMA = mcpZ.object({
  runId: mcpZ.string().min(1).optional(),
  sessionId: mcpZ.string().min(1).optional(),
  waitMs: mcpZ.number().int().min(0).optional(),
}).strict()
type GetTaskInput = mcpZ.infer<typeof GET_INPUT_SCHEMA>

const CONTINUE_INPUT_SCHEMA = mcpZ.object({
  sessionId: mcpZ.string().min(1),
  task: mcpZ.string().min(1),
}).strict()
type ContinueTaskInput = mcpZ.infer<typeof CONTINUE_INPUT_SCHEMA>

const CANCEL_INPUT_SCHEMA = mcpZ.object({
  runId: mcpZ.string().min(1),
}).strict()
type CancelTaskInput = mcpZ.infer<typeof CANCEL_INPUT_SCHEMA>

const PRESET_LIST_OUTPUT_SCHEMA = {
  presets: mcpZ.array(mcpZ.object({
    id: mcpZ.string(),
    name: mcpZ.string(),
    description: mcpZ.string().optional(),
    order: mcpZ.number().optional(),
    isDefault: mcpZ.boolean(),
  })),
  defaultPreset: mcpZ.string(),
} as const

const encoder = new TextEncoder()

/**
 * Validate deployment-level options that Schemastery cannot express fully.
 * @param config - raw plugin configuration.
 */
export function validateConfig(config: Config): void {
  if (!Array.isArray(config.allowedRoots) || config.allowedRoots.length === 0) {
    throw new Error('mcp-agent-server: allowedRoots must contain at least one directory')
  }
  const presets = config.allowedPermissionPresets ?? ['read-only']
  if (presets.length === 0 || presets.some(preset => !isPermissionPreset(preset))) {
    throw new Error('mcp-agent-server: allowedPermissionPresets must contain native permission presets')
  }
  const defaultPreset = config.defaultPermissionPreset ?? 'read-only'
  if (!presets.includes(defaultPreset)) {
    throw new Error(`mcp-agent-server: defaultPermissionPreset ${JSON.stringify(defaultPreset)} is not in allowedPermissionPresets`)
  }
  if (config.maxWaitMs !== undefined
    && (!Number.isSafeInteger(config.maxWaitMs) || config.maxWaitMs < 1 || config.maxWaitMs > MAX_TIMER_MS)) {
    throw new Error(`mcp-agent-server: maxWaitMs must be a positive integer no greater than ${MAX_TIMER_MS}`)
  }
  if (config.maxResultBytes !== undefined && (!Number.isSafeInteger(config.maxResultBytes) || config.maxResultBytes < 1)) {
    throw new Error('mcp-agent-server: maxResultBytes must be a positive safe integer')
  }
  for (const root of config.allowedRoots) {
    if (!isAbsolute(root)) throw new Error(`mcp-agent-server: allowed root must be absolute: ${root}`)
  }
}

/**
 * Check lexical containment after both paths have been canonicalized.
 * @param root - canonical allowed root.
 * @param candidate - canonical candidate path.
 * @returns whether candidate is root or a descendant of root.
 */
export function isWithinAllowedRoot(root: string, candidate: string): boolean {
  const rest = relative(root, candidate)
  return rest === '' || !(rest === '..' || rest.startsWith(`..${sep}`) || rest.startsWith('../') || isAbsolute(rest))
}

function workspaceKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`mcp-agent-server: ${label} must be absolute: ${path}`)
  try {
    const canonical = await realpath(path)
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory')
    return canonical
  } catch (error) {
    throw new Error(`mcp-agent-server: ${label} must be an existing directory: ${path}`, { cause: error })
  }
}

function trimUtf8(text: string, maxBytes: number): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text
  let trimmed = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  while (encoder.encode(trimmed).byteLength > maxBytes) trimmed = trimmed.slice(0, -1)
  return trimmed
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

function addUsage(total: TaskUsage | undefined, next: TokenUsage): TaskUsage {
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

function usageFromEvents(events: readonly SessionEvent[]): TaskUsage | undefined {
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

function summarizeEvents(events: readonly SessionEvent[], maxResultBytes: number): EventSummary {
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
 * Select the durable event interval owned by one MCP task. A later page
 * message must not extend an incomplete interval when the task never claimed
 * a turn, so the no-turn fallback stops at the task message (or its marker).
 * @param events - the session log in sequence order.
 * @param startSeq - sequence of the task-started marker.
 * @param messageId - durable user message submitted for this task.
 * @param turn - claimed turn, when the Agent reached the inbox boundary.
 * @param endedSeq - task-ended marker sequence, when one was persisted.
 * @returns the task-owned event interval.
 */
function taskEventSlice(
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

function taskResponse(record: RunRecord, summary: EventSummary): TaskResult {
  return {
    runId: String(record.runId),
    sessionId: String(record.sessionId),
    status: summary.status,
    ...summary.result === undefined ? {} : { result: summary.result },
    ...summary.reason === undefined ? {} : { reason: summary.reason },
    ...summary.usage === undefined ? {} : { usage: summary.usage },
  }
}

function asMcpResult(value: TaskResult): { content: [{ type: 'text'; text: string }]; structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as unknown as Record<string, unknown>,
  }
}

function taskJobOutcome(response: TaskResult): JobOutcome {
  const outcome = (status: JobOutcome['status'], detail: string | undefined): JobOutcome => ({
    status,
    ...detail === undefined ? {} : { detail },
    ...response.result === undefined ? {} : { output: response.result },
  })
  if (response.status === 'aborted') return outcome('killed', response.reason)
  if (response.status === 'error') return outcome('failed', response.reason)
  return outcome('completed', response.status)
}

function isTerminal(response: TaskResult | undefined): response is TaskResult {
  return response !== undefined && response.status !== 'running'
}

/** Hooks used by transport adapters to attach an ordinary DSH session before its turn starts. */
export interface RuntimeOptions {
  /** Attach a newly created or resumed session to the host's presentation surface. */
  readonly onSessionReady?: (session: Session) => Promise<void> | void
}

/** Shared task registry used by stdio and Web MCP transports. */
export interface McpAgentRuntime {
  /** Register the preset-discovery and MCP task tools on one MCP server instance. */
  registerTools(server: McpServer): void
  /** Stop admission and wait for every task to become quiescent. */
  shutdown(): Promise<void>
}

/**
 * Create one MCP server instance for a shared task runtime.
 * @returns an unconnected MCP server ready for tool registration.
 */
export function createMcpServer(): McpServer {
  return new McpServer(
    { name: 'dsh-mcp-agent', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
}

/** MCP server plugin name. */
export const name = 'mcp-agent-server'
/** Services used by task creation, jobs, persistence and preset reconstruction. */
export const inject = [
  'agents', 'jobs', 'sessionPersistence', 'agentPresets', 'agentDefaultModel', 'permissionPresets',
]

/**
 * Mount the stdio MCP server and the DSH task lifecycle.
 * @param ctx - host context carrying the DSH runtime services.
 * @param rawConfig - delegation roots, native permission policy and result bounds.
 * @param options - transport hooks that publish a ready session.
 * @returns the shared task registry and its asynchronous shutdown operation.
 */
export async function createRuntime(
  ctx: Context,
  rawConfig: Config,
  options: RuntimeOptions = {},
): Promise<McpAgentRuntime> {
  validateConfig(rawConfig)
  const config: ResolvedConfig = {
    allowedRoots: await Promise.all(rawConfig.allowedRoots.map(root => canonicalDirectory(root, 'allowed root'))),
    allowedPermissionPresets: rawConfig.allowedPermissionPresets ?? ['read-only'],
    defaultPermissionPreset: rawConfig.defaultPermissionPreset ?? 'read-only',
    maxWaitMs: rawConfig.maxWaitMs ?? 30_000,
    maxResultBytes: rawConfig.maxResultBytes ?? 65_536,
  }
  const runs = new Map<RunId, RunRecord>()
  const latestBySession = new Map<SessionId, RunRecord>()
  let closed = false
  let shutting: Promise<void> | undefined

  const ensureOpen = (): void => {
    if (closed) throw new Error('mcp-agent-server: transport is closed')
  }

  const validatePermissionPreset = (preset: PermissionPreset): void => {
    if (!config.allowedPermissionPresets.includes(preset)) {
      throw new Error(`mcp-agent-server: permission preset ${JSON.stringify(preset)} is not allowed`)
    }
    // The MCP config is an admission allow-list; the native service remains
    // authoritative for user-defined preset names and their sandbox bundle.
    ctx.permissionPresets.resolve(preset)
  }

  const permissionWritesWorkspace = (preset: PermissionPreset): boolean =>
    ctx.permissionPresets.resolve(preset).sandbox !== 'read-only'

  const resolveCwd = async (cwd: string): Promise<string> => {
    const candidate = await canonicalDirectory(cwd, 'cwd')
    if (!config.allowedRoots.some(root => isWithinAllowedRoot(root, candidate))) {
      throw new Error(`mcp-agent-server: cwd is outside allowedRoots: ${candidate}`)
    }
    return candidate
  }

  const assertWorkspaceAdmission = (sessionId: SessionId, cwd: string, workspaceWriter: boolean): void => {
    const existing = latestBySession.get(sessionId)
    if (existing !== undefined && !isTerminal(existing.response)) {
      throw new Error(`mcp-agent-server: session ${sessionId} already has an active run`)
    }
    if (!workspaceWriter) return
    const key = workspaceKey(cwd)
    for (const run of runs.values()) {
      if (!isTerminal(run.response)
        && run.workspaceWriter
        && run.workspaceKey === key) {
        throw new Error(`mcp-agent-server: workspace-write run already active for ${cwd}`)
      }
    }
  }

  const installModelSelectionFor = (agentCtx: Context, current: ModelSelectionRef['current']): void => {
    // The Web Host's API proxy installs the same native selection ref when it
    // is present. Headless stdio assemblies have no browser proxy, so the MCP
    // runtime supplies the DSH selection directly.
    if (ctx.get('apiProxy') !== undefined) return
    const selection: ModelSelectionRef = {
      current,
      assembled: undefined,
    }
    installModelSelection(agentCtx, selection)
  }

  const installDefaultModelSelection = (agentCtx: Context): void => {
    installModelSelectionFor(agentCtx, ctx.agentDefaultModel.currentSelection())
  }

  const setupAgent = async (
    agentCtx: Context,
    agentPreset: string,
    permissionPreset: PermissionPreset,
    source?: 'codex',
  ): Promise<void> => {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('mcp-agent-server: agent setup has no agent identity')
    await ctx.agentPresets.mount(agentCtx, agentPreset)
    installDefaultModelSelection(agentCtx)
    ctx.permissionPresets.set(agent.session, permissionPreset)
    // Append the source marker before `agent/created` is observed by the Web
    // Host. The host's session-added frame can therefore carry the badge in
    // the same publication event that makes the ordinary session visible.
    if (source === 'codex') agent.session.append('session/source', { source })
  }

  const setupResume = async (
    agentCtx: Context,
    agentPreset: string,
    selection: ModelSelectionRef['current'],
  ): Promise<void> => {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('mcp-agent-server: resume setup has no agent identity')
    await ctx.agentPresets.mount(agentCtx, agentPreset)
    installModelSelectionFor(agentCtx, selection)
  }

  const addDescendantUsage = async (
    sessionId: SessionId,
    current: TaskUsage | undefined,
    startTime: number,
    endTime: number,
  ): Promise<TaskUsage | undefined> => {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return current
    let descendants
    try {
      descendants = await subagents.listDescendants(sessionId)
    } catch (error) {
      ctx.logger.warn(`mcp-agent-server: descendant usage unavailable for ${sessionId}: ${String(error)}`)
      return current
    }
    let usage = current
    for (const descendant of descendants) {
      if (descendant.kind !== 'child') continue
      try {
        const inspection = await ctx.sessionPersistence.inspect(descendant.id)
        const events = inspection.events.filter(event => event.time >= startTime && event.time <= endTime)
        const childUsage = usageFromEvents(events)
        if (childUsage !== undefined) usage = addUsage(usage, childUsage)
      } catch (error) {
        ctx.logger.warn(`mcp-agent-server: descendant usage read failed for ${descendant.id}: ${String(error)}`)
      }
    }
    return usage
  }

  const summarizeRun = async (
    sessionId: SessionId,
    events: readonly SessionEvent[],
    startedAt: number,
  ): Promise<EventSummary> => {
    const summary = summarizeEvents(events, config.maxResultBytes)
    if (events.length === 0) return summary
    const receipt = events.find(event => event.type === 'user/message')
    const startTime = receipt?.time ?? startedAt
    // The range already ends at this MCP task's turn/end. Do not use the
    // current wall clock: a page message or a later child turn can otherwise
    // leak into this task's usage window.
    const endTime = events.at(-1)?.time ?? startTime
    const usage = await addDescendantUsage(sessionId, summary.usage, startTime, endTime)
    return usage === summary.usage ? summary : {
      ...summary,
      ...usage === undefined ? {} : { usage },
    }
  }

  const inspectCodexSession = async (sessionId: SessionId): Promise<{
    cwd: string
    agentPreset: string
    permissionPreset: PermissionPreset
    workspaceWriter: boolean
    events: readonly SessionEvent[]
  }> => {
    const live = ctx.agents.get(sessionId)
    const inspected = live === undefined ? await ctx.sessionPersistence.inspect(sessionId) : undefined
    const meta = live?.session.header ?? inspected?.meta
    const events = live?.session.events ?? inspected?.events
    if (meta === undefined || events === undefined) {
      throw new Error(`mcp-agent-server: session ${sessionId} was not found`)
    }
    const source = events.findLast(event => event.type === 'session/source')
    if (meta.id !== sessionId || source?.data.source !== 'codex' || meta.origin !== undefined
      || meta.parentSession !== undefined
      || meta.delegationDepth !== undefined && meta.delegationDepth !== 0) {
      throw new Error(`mcp-agent-server: session ${sessionId} is not a Codex-created ordinary DSH session`)
    }
    const agentPreset = resolveSessionPreset({ header: meta, events })
    if (agentPreset === undefined) throw new Error(`mcp-agent-server: session ${sessionId} has no durable agent preset`)
    await ctx.agentPresets.resolve(agentPreset)
    if (meta.cwd === undefined) throw new Error(`mcp-agent-server: session ${sessionId} has no workspace cwd`)
    const cwd = await resolveCwd(meta.cwd)
    const permissionPreset = ctx.permissionPresets.current(events)
    // Continuation inherits the session's durable permission state. The MCP
    // admission allow-list applies only to a new delegation; a page may have
    // switched this ordinary session to another native preset or to the
    // service's derived `custom` combination in the meantime.
    const workspaceWriter = permissionPreset === CUSTOM_PRESET
      ? effectiveSandboxMode(events) !== 'read-only'
      : permissionWritesWorkspace(permissionPreset)
    return { cwd, agentPreset, permissionPreset, workspaceWriter, events }
  }

  const runTask = async (record: RunRecord): Promise<TaskResult> => {
    let handle: AgentHandle | undefined
    let events: readonly SessionEvent[] = []
    let response = taskResponse(record, { status: 'error', reason: 'task did not produce a result' })
    const flushSession = async (agent: Agent): Promise<void> => {
      const sessions = ctx.get('sessions')
      if (sessions === undefined) throw new Error('mcp-agent-server: session store is required to flush task results')
      await sessions.flush(agent.session)
    }
    const waitForTaskTurn = async (agent: Agent, message: UserMessage): Promise<number> => {
      const claimed = Promise.withResolvers<number>()
      const received = Promise.withResolvers<void>()
      const ended = Promise.withResolvers<SessionEvent<'turn/end'>>()
      const cancelled = Promise.withResolvers<never>()
      const onAbort = (): void => {
        cancelled.reject(record.cancel.signal.reason ?? new Error('task cancelled'))
      }
      if (record.cancel.signal.aborted) onAbort()
      else record.cancel.signal.addEventListener('abort', onAbort, { once: true })
      const disposeClaim = agent.ctx.on('agent/inbox/claimed', ({ message: claimedMessage, turn }) => {
        if (claimedMessage.id !== message.id) return
        record.turn = turn
        claimed.resolve(turn)
      })
      const disposeEnd = ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        if (event.type === 'user/message' && event.data.id === message.id) received.resolve()
        if (event.type === 'turn/end' && record.turn !== undefined && event.data.turn === record.turn) ended.resolve(event)
      })
      try {
        agent.followup(message)
        const turn = await Promise.race([claimed.promise, cancelled.promise])
        // The message is appended after the inbox claim. Wait for the session
        // event and flush it before delegate_task reports a visible session.
        await Promise.race([received.promise, cancelled.promise])
        await flushSession(agent)
        if (!record.readySettled) {
          record.readySettled = true
          record.resolveReady()
        }
        await Promise.race([ended.promise, cancelled.promise])
        return turn
      } finally {
        record.cancel.signal.removeEventListener('abort', onAbort)
        disposeClaim()
        disposeEnd()
      }
    }
    const waitForTurnEnd = async (agent: Agent, turn: number): Promise<void> => {
      if (agent.session.events.some(event => event.type === 'turn/end' && event.data.turn === turn)) return
      const ended = Promise.withResolvers<void>()
      const dispose = ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'turn/end' && event.data.turn === turn) ended.resolve()
      })
      try {
        // Cancellation aborts the current phase, but the loop still commits
        // its terminal turn/end in a finally block. The exact event wins; the
        // idle fallback covers a setup/model failure that never opened it.
        await Promise.race([ended.promise, agent.whenIdle()])
      } finally {
        dispose()
      }
    }
    try {
      const identity = record.resume ? await inspectCodexSession(record.sessionId) : undefined
      const model = identity === undefined
        ? ctx.agentDefaultModel.currentSelection()
        : (() => {
          const header = identity.events.findLast(event => event.type === 'request/header')
          return header?.type === 'request/header'
            ? {
              provider: header.data.header.config.provider,
              model: header.data.header.config.model,
              ...header.data.header.config.reasoningEffort === undefined
                ? {} : { reasoningEffort: header.data.header.config.reasoningEffort },
            }
            : ctx.agentDefaultModel.currentSelection()
        })()
      let agent: Agent
      if (record.resume) {
        const live = ctx.agents.get(record.sessionId)
        if (live !== undefined) {
          agent = live
        } else {
          handle = await ctx.agents.resume({
            resumeSessionId: record.sessionId,
            agentOptions: { provider: model.provider, model: model.model } satisfies AgentOptions,
            signal: record.cancel.signal,
            setup: agentCtx => setupResume(agentCtx, record.agentPreset, model),
          })
          agent = handle.agent
        }
      } else {
        handle = await ctx.agents.create({
          sessionId: record.sessionId,
          meta: {
            cwd: record.cwd,
            agentPreset: record.agentPreset,
          },
          agentOptions: { provider: model.provider, model: model.model } satisfies AgentOptions,
          signal: record.cancel.signal,
          setup: agentCtx => setupAgent(agentCtx, record.agentPreset, record.permissionPreset, 'codex'),
        })
        agent = handle.agent
      }
      record.agent = agent
      if (handle !== undefined) record.handle = handle
      await options.onSessionReady?.(agent.session)
      // Publication and workspace attachment are part of the ready boundary;
      // persist the source marker and native permission facts before exposing
      // the run id to the MCP caller. The source marker is appended during
      // fresh-agent setup so the Host's session-added event already carries it.
      await flushSession(agent)
      const message: UserMessage = createUserMessage({ content: [{ type: 'text', text: record.task }], source: { kind: 'user' } })
      record.messageId = String(message.id)
      const started = agent.session.append('mcp-agent/task-started', {
        taskId: record.taskId,
        messageId: String(message.id),
      })
      record.startSeq = started.seq
      const turn = await waitForTaskTurn(agent, message)
      events = taskEventSlice(agent.session.events, record.startSeq, record.messageId, record.turn)
      const summary = await summarizeRun(record.sessionId, events, record.startedAt)
      response = taskResponse(record, summary)
      agent.session.append('mcp-agent/task-ended', {
        taskId: record.taskId,
        messageId: String(message.id),
        turn,
        status: response.status,
      })
      await flushSession(agent)
    } catch (error) {
      const unpublished = !record.readySettled
      if (!record.readySettled) {
        record.readySettled = true
        record.rejectReady(error)
      }
      const aborted = record.cancelRequested || record.cancel.signal.aborted
      let reason = aborted ? 'cancelled' : String(error)
      if (record.agent !== undefined) {
        if (record.turn !== undefined) await waitForTurnEnd(record.agent, record.turn)
        events = taskEventSlice(record.agent.session.events, record.startSeq, record.messageId, record.turn)
        try {
          await flushSession(record.agent)
        } catch (flushError) {
          reason = `${reason}; session flush failed: ${String(flushError)}`
        }
      }
      const partial = events.length === 0 ? undefined : await summarizeRun(record.sessionId, events, record.startedAt)
      // A cancellation can race with the final turn boundary or persistence
      // flush. Once the exact turn already has a terminal reason, preserve it
      // instead of reporting a later cancellation as if it won the race.
      const terminalStatus = partial?.status !== undefined && partial.status !== 'incomplete'
        ? partial.status
        : undefined
      const terminalReason = terminalStatus === undefined ? reason : partial?.reason
      response = taskResponse(record, {
        ...partial,
        status: terminalStatus ?? (aborted ? 'aborted' : 'error'),
        ...terminalReason === undefined ? {} : { reason: terminalReason },
      })
      if (record.agent !== undefined && record.messageId !== undefined && record.turn !== undefined && record.startSeq >= 0) {
        try {
          record.agent.session.append('mcp-agent/task-ended', {
            taskId: record.taskId,
            messageId: record.messageId,
            turn: record.turn,
            status: response.status,
          })
          await flushSession(record.agent)
        } catch (markerError) {
          reason = `${reason}; task marker flush failed: ${String(markerError)}`
          response = taskResponse(record, { ...response, reason })
        }
      }
      // A failure before the durable task receipt was published is a creation
      // failure, not a failed ordinary session. Roll back the unpublished
      // Agent so a workspace or persistence error cannot leave an orphan.
      if (unpublished && handle !== undefined) {
        try {
          await handle.dispose()
        } catch (disposeError) {
          reason = `${reason}; agent dispose failed: ${String(disposeError)}`
        }
      }
    } finally {
      // Ordinary DSH sessions remain live after the MCP run so the browser
      // can continue, steer, rename, change permissions, or fork them.
    }
    record.response = response
    return response
  }

  const requestCancel = (record: RunRecord, reason: string | undefined, shutdown: boolean): void => {
    if (isTerminal(record.response)) return
    record.cancelRequested = true
    record.shutdownRequested = shutdown
    record.cancel.abort(new Error(reason ?? (shutdown ? 'transport closed' : 'cancelled')))
    record.agent?.cancel(shutdown ? { kind: 'disposed' } : { kind: 'user' })
  }

  const createRun = async (input: {
    sessionId?: SessionId
    task: string
    cwd?: string
    permissionPreset?: PermissionPreset
    agentPreset?: string
    resume: boolean
  }): Promise<RunRecord> => {
    ensureOpen()
    if (input.task.trim().length === 0) throw new Error('mcp-agent-server: task must be non-empty')
    const sessionId = input.sessionId ?? makeSessionId(randomUUID())
    let permissionPreset: PermissionPreset
    let agentPreset: string
    let cwd: string
    let workspaceWriter: boolean
    if (input.resume) {
      const identity = await inspectCodexSession(sessionId)
      if (input.permissionPreset !== undefined && input.permissionPreset !== identity.permissionPreset) {
        throw new Error(`mcp-agent-server: continuation cannot choose permission preset ${input.permissionPreset}`)
      }
      permissionPreset = identity.permissionPreset
      agentPreset = identity.agentPreset
      cwd = input.cwd ?? identity.cwd
      workspaceWriter = identity.workspaceWriter
    } else {
      if (input.cwd === undefined) throw new Error('mcp-agent-server: cwd is required for a new task')
      if (input.agentPreset === undefined || input.agentPreset.trim().length === 0) {
        throw new Error('mcp-agent-server: agentPreset is required for a new task')
      }
      agentPreset = (await ctx.agentPresets.resolve(input.agentPreset)).id
      permissionPreset = input.permissionPreset ?? config.defaultPermissionPreset
      validatePermissionPreset(permissionPreset)
      cwd = await resolveCwd(input.cwd)
      workspaceWriter = permissionWritesWorkspace(permissionPreset)
    }
    assertWorkspaceAdmission(sessionId, cwd, workspaceWriter)
    const record: RunRecord = {
      runId: RunId(`mcp-run-${randomUUID()}`),
      sessionId,
      cwd,
      workspaceKey: workspaceKey(cwd),
      workspaceWriter,
      permissionPreset,
      agentPreset,
      resume: input.resume,
      task: input.task,
      taskId: randomUUID(),
      cancel: new AbortController(),
      startedAt: Date.now(),
      startSeq: 0,
      cancelRequested: false,
      shutdownRequested: false,
      ...taskReadyState(),
    }
    const jobId = ctx.jobs.start({
      kind: 'mcp-agent',
      label: input.task,
      outputLimitBytes: config.maxResultBytes,
      run: () => {
        const done = Promise.resolve().then(() => runTask(record)).then(taskJobOutcome)
        record.completion = done.then(() => record.response as TaskResult)
        return {
          cancel: (reason?: string) => { requestCancel(record, reason, false) },
          done,
        }
      },
    })
    record.jobId = jobId
    runs.set(record.runId, record)
    latestBySession.set(record.sessionId, record)
    return record
  }

  const currentResult = (record: RunRecord): TaskResult => record.response ?? {
    runId: String(record.runId),
    sessionId: String(record.sessionId),
    status: 'running',
  }

  const waitForRun = async (record: RunRecord, waitMs: number | undefined): Promise<void> => {
    if (isTerminal(record.response) || waitMs === undefined || waitMs <= 0) return
    const bounded = Math.min(waitMs, config.maxWaitMs)
    await Promise.race([
      record.completion ?? Promise.resolve(),
      new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, bounded)
        timer.unref()
      }),
    ])
  }

  const resultForSession = async (sessionId: SessionId): Promise<TaskResult> => {
    const live = latestBySession.get(sessionId)
    if (live !== undefined) return currentResult(live)
    const inspection = await ctx.sessionPersistence.inspect(sessionId)
    const identity = await inspectCodexSession(sessionId)
    const started = inspection.events.findLast(event => event.type === 'mcp-agent/task-started')
    if (started === undefined) throw new Error(`mcp-agent-server: session ${sessionId} has no MCP task record`)
    const ended = inspection.events.findLast(event => event.type === 'mcp-agent/task-ended'
      && event.data.taskId === started.data.taskId)
    const startedIndex = inspection.events.findIndex(event => event.seq === started.seq)
    const messageIndex = inspection.events.findIndex(event => event.type === 'user/message'
      && event.data.id === started.data.messageId && event.seq >= started.seq)
    const turnStart = startedIndex < 0 || messageIndex < startedIndex ? undefined : inspection.events
      .slice(startedIndex, messageIndex + 1)
      .findLast(event => event.type === 'turn/start')
    const turn = turnStart?.type === 'turn/start' ? turnStart.data.turn : undefined
    const summary = await summarizeRun(
      sessionId,
      taskEventSlice(inspection.events, started.seq, started.data.messageId, turn, ended?.seq),
      inspection.meta.createdAt,
    )
    return taskResponse({
      runId: RunId(`cold-${sessionId}`),
      sessionId,
      cwd: identity.cwd,
      workspaceKey: workspaceKey(identity.cwd),
      workspaceWriter: identity.workspaceWriter,
      permissionPreset: identity.permissionPreset,
      agentPreset: identity.agentPreset,
      resume: true,
      task: '',
      taskId: started.data.taskId,
      messageId: started.data.messageId,
      cancel: new AbortController(),
      startedAt: inspection.meta.createdAt,
      startSeq: 0,
      cancelRequested: false,
      shutdownRequested: false,
      ...taskReadyState(),
    }, summary)
  }

  const registerTools = (server: McpServer): void => {
    server.registerTool('list_agent_presets', {
      title: 'List DSH Agent presets',
      description: 'List the currently mountable DSH Agent presets. Codex must ask the user to choose one before delegating a new task.',
      inputSchema: {},
      outputSchema: PRESET_LIST_OUTPUT_SCHEMA,
    }, async () => {
      const presets = (await ctx.agentPresets.list())
        .filter(preset => preset.broken === undefined)
        .sort((left, right) => (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY)
          || left.id.localeCompare(right.id))
      const result = {
        presets: presets.map(preset => ({
          id: preset.id,
          name: preset.name ?? preset.id,
          ...preset.description === undefined ? {} : { description: preset.description },
          ...preset.order === undefined ? {} : { order: preset.order },
          isDefault: preset.id === ctx.agentPresets.defaultId,
        })),
        defaultPreset: ctx.agentPresets.defaultId,
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      }
    })

    server.registerTool('delegate_task', {
      title: 'Delegate DSH task',
      description: 'Start an independent DeepSeek Harness task. The task runs in the background and returns a process-local run id plus a durable session id.',
      inputSchema: DELEGATE_INPUT_SCHEMA,
      outputSchema: TASK_OUTPUT_SCHEMA,
    }, async (args: DelegateTaskInput) => {
      const record = await createRun({
        task: args.task,
        cwd: args.cwd,
        agentPreset: args.agentPreset,
        ...args.permissionPreset === undefined ? {} : { permissionPreset: args.permissionPreset },
        resume: false,
      })
      await record.ready
      return asMcpResult({ runId: String(record.runId), sessionId: String(record.sessionId), status: 'running' })
    })

    server.registerTool('get_task', {
      title: 'Get DSH task',
      description: 'Read a running or persisted DSH task by exactly one run id or session id. waitMs bounds a wait and never cancels the task.',
      inputSchema: GET_INPUT_SCHEMA,
      outputSchema: TASK_OUTPUT_SCHEMA,
    }, async (args: GetTaskInput) => {
      if ((args.runId === undefined) === (args.sessionId === undefined)) throw new Error('mcp-agent-server: provide exactly one of runId or sessionId')
      if (args.runId !== undefined) {
        const record = runs.get(RunId(args.runId))
        if (record === undefined) throw new Error(`mcp-agent-server: unknown runId ${args.runId}`)
        await waitForRun(record, args.waitMs)
        return asMcpResult(currentResult(record))
      }
      const sessionId = makeSessionId(args.sessionId as string)
      const live = latestBySession.get(sessionId)
      if (live !== undefined) await waitForRun(live, args.waitMs)
      return asMcpResult(live === undefined ? await resultForSession(sessionId) : currentResult(live))
    })

    server.registerTool('continue_task', {
      title: 'Continue DSH task',
      description: 'Resume a persisted ordinary DSH session with a new task. Its workspace, Agent preset, model and native permissions are retained.',
      inputSchema: CONTINUE_INPUT_SCHEMA,
      outputSchema: TASK_OUTPUT_SCHEMA,
    }, async (args: ContinueTaskInput) => {
      const identity = await inspectCodexSession(makeSessionId(args.sessionId))
      const record = await createRun({
        sessionId: makeSessionId(args.sessionId),
        task: args.task,
        cwd: identity.cwd,
        resume: true,
      })
      await record.ready
      return asMcpResult({ runId: String(record.runId), sessionId: String(record.sessionId), status: 'running' })
    })

    server.registerTool('cancel_task', {
      title: 'Cancel DSH task',
      description: 'Cancel one active DSH task and wait for its Agent, persistence flush and job to become quiescent. A completed race returns the real final result.',
      inputSchema: CANCEL_INPUT_SCHEMA,
      outputSchema: TASK_OUTPUT_SCHEMA,
    }, async (args: CancelTaskInput) => {
      const record = runs.get(RunId(args.runId))
      if (record === undefined) throw new Error(`mcp-agent-server: unknown runId ${args.runId}`)
      requestCancel(record, 'cancelled by MCP client', false)
      await record.completion
      return asMcpResult(currentResult(record))
    })
  }

  const shutdown = async (): Promise<void> => {
    if (shutting !== undefined) return shutting
    closed = true
    shutting = (async () => {
      const live = [...runs.values()].filter(record => !isTerminal(record.response))
      for (const record of live) requestCancel(record, 'transport closed', true)
      await Promise.all(live.map(record => record.completion ?? Promise.resolve()))
    })()
    return shutting
  }

  ctx.jobs.attachController('mcp-agent-server')
  return { registerTools, shutdown }
}

/** Mount the stdio MCP transport over the shared DSH task runtime. */
export async function apply(ctx: Context, rawConfig: Config): Promise<void> {
  const runtime = await createRuntime(ctx, rawConfig)
  const server = createMcpServer()
  runtime.registerTools(server)
  const transport = new StdioServerTransport()
  const shutdown = async (): Promise<void> => {
    await runtime.shutdown()
    if (server.isConnected()) {
      try { await server.close() } catch (error) { ctx.logger.warn(`mcp-agent-server: MCP close failed: ${String(error)}`) }
    }
  }
  server.server.onclose = () => { void runtime.shutdown() }
  ctx.effect(() => () => shutdown(), 'mcp-agent-server.lifecycle')
  await server.connect(transport)
}

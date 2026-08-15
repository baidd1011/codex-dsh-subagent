import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const binScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../../../../examples/mcp-agent/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

let client: Client | undefined
let transport: StdioClientTransport | undefined
let stderr = ''
let fixtureDir: string | undefined

afterEach(async () => {
  await client?.close().catch(() => undefined)
  await transport?.close().catch(() => undefined)
  client = undefined
  transport = undefined
  if (fixtureDir !== undefined) await rm(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  fixtureDir = undefined
  stderr = ''
})

async function connect(config: string): Promise<Client> {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', binScript, '--config', config],
    cwd: repoRoot,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: repoTsconfig,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'keyless-mcp-agent-boot',
      DSH_HOME: `${repoRoot}/.dsh-mcp-agent-test`,
      DSH_AGENTS_HOME: `${repoRoot}/.agents-mcp-agent-test`,
    },
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const connected = new Client({ name: 'mcp-agent-load-test', version: '0.1.0' })
  client = connected
  try {
    await connected.connect(transport)
  } catch (error) {
    throw new Error(`MCP child closed during connect: ${String(error)}${stderr.length === 0 ? '' : `\nstderr:\n${stderr}`}`)
  }
  return connected
}

async function createFixture(): Promise<string> {
  fixtureDir = await mkdtemp(join(repoRoot, '.mcp-agent-e2e-'))
  return fixtureDir
}

async function writeTestConfig(
  directory: string,
  adapterSource: readonly string[],
  extraRows: readonly string[] = [],
): Promise<string> {
  const adapterPath = join(directory, 'mock-llm.mjs')
  await writeFile(adapterPath, adapterSource.join('\n'))
  const source = await readFile(configPath, 'utf8')
  const sessionRoot = join(directory, 'sessions').replaceAll('\\', '/')
  const presetRoot = join(repoRoot, 'apps/cli/config/agent-presets').replaceAll('\\', '/')
  const rewritten = source
    .replace('provider: deepseek-official', 'provider: mcp-test')
    .replace('model: deepseek-v4-pro', 'model: mcp-test')
    .replace('path: ./apps/cli/config/agent-presets', `path: '${presetRoot}'`)
    .replace('root: ./.sessions', `root: '${sessionRoot}'`)
  if (rewritten.includes('path: ./apps/cli/config/agent-presets')) {
    throw new Error('test config did not replace the source-relative system preset path')
  }
  const generatedConfig = join(directory, 'cordis.yml')
  await writeFile(generatedConfig, [
    ...extraRows,
    `- id: mock-llm\n  name: '${pathToFileURL(adapterPath).href}'`,
    rewritten,
  ].join('\n'))
  return generatedConfig
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await delay(10)
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

describe('dsh-mcp-agent real composition load path', () => {
  it('boots the actual stdio bin and advertises the preset and task MCP tools', async () => {
    const activeClient = await connect(configPath)

    const listing = await activeClient.listTools()
    expect(listing.tools.map(tool => tool.name).sort()).toEqual([
      'cancel_task',
      'continue_task',
      'delegate_task',
      'get_task',
      'list_agent_presets',
    ])
    for (const tool of listing.tools) expect(tool.inputSchema).toBeDefined()

    const presets = await activeClient.callTool({ name: 'list_agent_presets', arguments: {} })
    const content = presets.structuredContent
    if (typeof content !== 'object' || content === null) throw new Error('expected structured preset content')
    expect('defaultPreset' in content ? content.defaultPreset : undefined).toBe('standard')
    const listedPresets = 'presets' in content ? content.presets : undefined
    expect(Array.isArray(listedPresets)).toBe(true)
    if (!Array.isArray(listedPresets)) throw new Error('expected a structured preset list')
    const presetEntries: unknown[] = listedPresets
    expect(presetEntries.some((preset) => {
      if (typeof preset !== 'object' || preset === null) return false
      return 'id' in preset && preset.id === 'standard'
        && 'isDefault' in preset && preset.isDefault === true
    })).toBe(true)
  }, 60_000)

  it('runs a keyless scripted DSH turn through delegate_task and get_task', async () => {
    const directory = await createFixture()
    const generatedConfig = await writeTestConfig(directory, [
      "import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'",
      'class Mock extends LlmAdapter {',
      "  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('max'), name: 'Max' }], defaultEffort: ReasoningEffortId('max') } }) }",
      '  async * stream(options) {',
      "    if (String(options.reasoningEffort) !== 'max') throw new Error('expected max reasoning effort')",
      "    yield { type: 'block-start', index: 0, blockType: 'text' }",
      "    yield { type: 'text-delta', index: 0, text: 'DSH SCRIPTED OK' }",
      "    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DSH SCRIPTED OK' } }",
      "    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }",
      "    yield { type: 'finish', reason: { kind: 'stop' } }",
      '  }',
      '}',
      "export const name = 'mcp-agent-scripted-llm'",
      "export const inject = ['llm']",
      "export function apply(ctx) { ctx.llm.registerAdapter(['mcp-test'], new Mock()) }",
      '',
    ])

    const activeClient = await connect(generatedConfig)
    const delegated = await activeClient.callTool({
      name: 'delegate_task',
      arguments: { task: 'Return the deterministic test response.', cwd: repoRoot, agentPreset: 'standard' },
    })
    if (delegated.structuredContent === undefined) {
      throw new Error(`delegate_task returned no structured result: ${JSON.stringify(delegated)}\nstderr:\n${stderr}`)
    }
    const started = delegated.structuredContent as { runId: string; sessionId: string; status: string }
    expect(started.status).toBe('running')
    expect(started.runId).toMatch(/^mcp-run-/)
    expect(started.sessionId).toBeTruthy()

    const completed = await activeClient.callTool({
      name: 'get_task',
      arguments: { runId: started.runId, waitMs: 10_000 },
    })
    const result = completed.structuredContent as {
      status: string
      result?: string
      reason?: string
      usage?: { inputTokens: number; outputTokens: number }
    }
    if (result.status !== 'completed') throw new Error(`scripted DSH task failed: ${JSON.stringify(result)}\nstderr:\n${stderr}`)
    expect(result).toMatchObject({ status: 'completed', result: 'DSH SCRIPTED OK', usage: { inputTokens: 7, outputTokens: 3 } })
    const continued = await activeClient.callTool({
      name: 'continue_task',
      arguments: { sessionId: started.sessionId, task: 'Continue with the deterministic test response.' },
    })
    const continuedStart = continued.structuredContent as { runId: string; sessionId: string; status: string }
    expect(continuedStart).toMatchObject({ sessionId: started.sessionId, status: 'running' })
    const continuedResult = await activeClient.callTool({
      name: 'get_task',
      arguments: { runId: continuedStart.runId, waitMs: 10_000 },
    })
    expect(continuedResult.structuredContent).toMatchObject({ status: 'completed', result: 'DSH SCRIPTED OK' })

    const writable = await activeClient.callTool({
      name: 'delegate_task',
      arguments: {
        task: 'Check the explicit writable permission preset.',
        cwd: repoRoot,
        agentPreset: 'standard',
        permissionPreset: 'workspace-write',
      },
    })
    const writableStart = writable.structuredContent as { runId: string; sessionId: string; status: string }
    const writableResult = await activeClient.callTool({
      name: 'get_task',
      arguments: { runId: writableStart.runId, waitMs: 10_000 },
    })
    expect(writableResult.structuredContent).toMatchObject({ status: 'completed', result: 'DSH SCRIPTED OK' })
    const writableContinuation = await activeClient.callTool({
      name: 'continue_task',
      arguments: { sessionId: writableStart.sessionId, task: 'Continue the writable-mode check.' },
    })
    const writableContinuationStart = writableContinuation.structuredContent as { runId: string }
    const writableContinuationResult = await activeClient.callTool({
      name: 'get_task',
      arguments: { runId: writableContinuationStart.runId, waitMs: 10_000 },
    })
    expect(writableContinuationResult.structuredContent).toMatchObject({ status: 'completed', result: 'DSH SCRIPTED OK' })
    expect((await readdir(join(directory, 'sessions'), { recursive: true })).length).toBeGreaterThan(0)

    await activeClient.close().catch(() => undefined)
    const activeTransport = transport
    if (activeTransport !== undefined) await activeTransport.close().catch(() => undefined)
    client = undefined
    transport = undefined
    stderr = ''
    const coldClient = await connect(generatedConfig)
    const cold = await coldClient.callTool({
      name: 'get_task',
      arguments: { sessionId: started.sessionId },
    })
    if (cold.structuredContent === undefined) {
      throw new Error(`cold get_task failed: ${JSON.stringify(cold.content)}`)
    }
    expect(cold.structuredContent).toMatchObject({ sessionId: started.sessionId, status: 'completed', result: 'DSH SCRIPTED OK' })
    expect(stderr).not.toContain('without inject')
  }, 60_000)

  it('runs the foreground subagent exposed by the standard preset', async () => {
    const directory = await createFixture()
    const generatedConfig = await writeTestConfig(directory, [
      "import { CallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'",
      'function text(value) { return [',
      "  { type: 'block-start', index: 0, blockType: 'text' },",
      "  { type: 'text-delta', index: 0, text: value },",
      "  { type: 'block-end', index: 0, block: { type: 'text', text: value } },",
      "  { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },",
      "  { type: 'finish', reason: { kind: 'stop' } },",
      '] }',
      'class Mock extends LlmAdapter {',
      "  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('max'), name: 'Max' }], defaultEffort: ReasoningEffortId('max') } }) }",
      '  async * stream(options) {',
      '    const messages = JSON.stringify(options.messages)',
      "    if (messages.includes('\"type\":\"tool-result\"')) {",
      "      const result = messages.includes('DSH NESTED CHILD OK') ? 'DSH NESTED PARENT OK' : 'DSH NESTED CHILD FAILED'",
      '      for (const chunk of text(result)) yield chunk',
      '      return',
      '    }',
      "    if (messages.includes('DSH_NESTED_CHILD_PROMPT')) { for (const chunk of text('DSH NESTED CHILD OK')) yield chunk; return }",
      "    const argumentsJson = JSON.stringify({ description: 'Check nested worker', prompt: 'DSH_NESTED_CHILD_PROMPT', run_in_background: false })",
      "    yield { type: 'block-start', index: 0, blockType: 'tool-call' }",
      "    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('nested-call'), name: 'subagent', arguments: argumentsJson } }",
      "    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }",
      "    yield { type: 'finish', reason: { kind: 'tool-calls' } }",
      '  }',
      '}',
      "export const name = 'mcp-agent-nested-scripted-llm'",
      "export const inject = ['llm']",
      "export function apply(ctx) { ctx.llm.registerAdapter(['mcp-test'], new Mock()) }",
      '',
    ])
    const activeClient = await connect(generatedConfig)
    const delegated = await activeClient.callTool({
      name: 'delegate_task',
      arguments: {
        task: 'Use the foreground subagent once, then report its result.',
        cwd: repoRoot,
        agentPreset: 'standard',
      },
    })
    if (delegated.structuredContent === undefined) {
      throw new Error(`nested delegate_task returned no structured result: ${JSON.stringify(delegated)}\nstderr:\n${stderr}`)
    }
    const started = delegated.structuredContent as { runId: string }
    const completed = await activeClient.callTool({
      name: 'get_task',
      arguments: { runId: started.runId, waitMs: 10_000 },
    })
    expect(completed.structuredContent).toMatchObject({ status: 'completed', result: 'DSH NESTED PARENT OK' })
  }, 60_000)

  it('keeps a completed turn completed when cancel_task arrives during its final flush', async () => {
    const directory = await createFixture()
    const flushEntered = join(directory, 'flush-entered')
    const flushRelease = join(directory, 'flush-release')
    const cancelObserved = join(directory, 'cancel-observed')
    const barrierPath = join(directory, 'flush-barrier.mjs')
    await writeFile(barrierPath, [
      "import { accessSync, writeFileSync } from 'node:fs'",
      "import { setTimeout as delay } from 'node:timers/promises'",
      `const entered = ${JSON.stringify(flushEntered)}`,
      `const release = ${JSON.stringify(flushRelease)}`,
      `const cancelled = ${JSON.stringify(cancelObserved)}`,
      'let blocked = false',
      "export const name = 'mcp-agent-flush-barrier'",
      "export const inject = ['sessions']",
      'export function apply(ctx) {',
      "  ctx.on('agent/created', ({ agent }) => {",
      '    const cancel = agent.cancel.bind(agent)',
      "    agent.cancel = reason => { writeFileSync(cancelled, 'cancelled'); cancel(reason) }",
      '  })',
      "  ctx.on('session/flush', async session => {",
      "    if (blocked || !session.events.some(event => event.type === 'turn/end')) return",
      '    blocked = true',
      "    writeFileSync(entered, 'entered')",
      '    while (true) {',
      '      try { accessSync(release); return } catch { await delay(10) }',
      '    }',
      '  })',
      '}',
      '',
    ].join('\n'))
    const generatedConfig = await writeTestConfig(directory, [
      "import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'",
      'class Mock extends LlmAdapter {',
      "  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('max'), name: 'Max' }], defaultEffort: ReasoningEffortId('max') } }) }",
      '  async * stream() {',
      "    yield { type: 'block-start', index: 0, blockType: 'text' }",
      "    yield { type: 'text-delta', index: 0, text: 'DSH COMPLETION RACE OK' }",
      "    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DSH COMPLETION RACE OK' } }",
      "    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }",
      "    yield { type: 'finish', reason: { kind: 'stop' } }",
      '  }',
      '}',
      "export const name = 'mcp-agent-race-scripted-llm'",
      "export const inject = ['llm']",
      "export function apply(ctx) { ctx.llm.registerAdapter(['mcp-test'], new Mock()) }",
      '',
    ], [`- id: flush-barrier\n  name: '${pathToFileURL(barrierPath).href}'`])
    const activeClient = await connect(generatedConfig)
    const delegated = await activeClient.callTool({
      name: 'delegate_task',
      arguments: {
        task: 'Return the deterministic completion-race response.',
        cwd: repoRoot,
        agentPreset: 'standard',
      },
    })
    if (delegated.structuredContent === undefined) {
      throw new Error(`race delegate_task returned no structured result: ${JSON.stringify(delegated)}\nstderr:\n${stderr}`)
    }
    const started = delegated.structuredContent as { runId: string }
    await waitForFile(flushEntered)
    const cancelling = activeClient.callTool({ name: 'cancel_task', arguments: { runId: started.runId } })
    await waitForFile(cancelObserved)
    await writeFile(flushRelease, 'release')
    const completed = await cancelling
    expect(completed.structuredContent).toMatchObject({
      status: 'completed',
      result: 'DSH COMPLETION RACE OK',
      reason: 'completed',
    })
  }, 60_000)
})

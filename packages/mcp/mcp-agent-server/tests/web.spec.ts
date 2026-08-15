import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runtimeShutdown = vi.fn(async () => {})
const runtimeRegisterTools = vi.fn((server: {
  registerTool: (name: string, config: Record<string, unknown>, handler: () => Promise<unknown>) => void
}) => {
  server.registerTool('web_probe', {
    title: 'Web probe',
    description: 'Test-only MCP tool',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: 'WEB_PROBE_OK' }],
  }))
})

vi.mock('../src/index.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/index.ts')>('../src/index.ts')
  return {
    ...actual,
    createRuntime: vi.fn(async () => ({
      registerTools: runtimeRegisterTools,
      shutdown: runtimeShutdown,
    })),
  }
})

import { apply } from '../src/web.ts'

interface Route {
  handler: ((request: IncomingMessage, response: ServerResponse) => void | Promise<void>) | undefined
  dispose: (() => void) | undefined
}

let httpServer: ReturnType<typeof createServer> | undefined
let cleanup: (() => unknown) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  if (httpServer !== undefined) {
    httpServer.close()
    await once(httpServer, 'close')
    httpServer = undefined
  }
  runtimeShutdown.mockClear()
  runtimeRegisterTools.mockClear()
})

async function bootRoute(token: string): Promise<{ url: string; resolveCredential: ReturnType<typeof vi.fn> }> {
  const route: Route = { handler: undefined, dispose: undefined }
  const currentToken = token
  const resolveCredential = vi.fn(async () => ({ value: currentToken, source: 'env' as const }))
  const workspace = { attachSession: vi.fn(async () => {}) }
  const context = {
    credentials: { resolve: resolveCredential },
    logger: { warn: vi.fn() },
    webServer: {
      register: vi.fn((registered: { handler: NonNullable<Route['handler']> }) => {
        route.handler = registered.handler
        const dispose = (): void => { route.handler = undefined }
        route.dispose = dispose
        return dispose
      }),
    },
    workspaceRegistry: { create: vi.fn(async () => workspace) },
    effect: vi.fn((factory: () => () => unknown) => { cleanup = factory() }),
  }
  await apply(context as never, {
    allowedRoots: [resolve('.')],
    allowedPermissionPresets: ['read-only', 'workspace-write'],
    path: '/mcp/dsh-agent',
    authCredential: 'DSH_MCP_TOKEN',
  })
  expect(route.handler).toBeDefined()
  httpServer = createServer((request, response) => {
    void route.handler?.(request, response)
  })
  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not expose a port')
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp/dsh-agent`,
    resolveCredential,
  }
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text()
  const data = body.match(/data:\s*(\{[\s\S]*\})/u)?.[1]
  return JSON.parse(data ?? body) as Record<string, unknown>
}

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'web-test', version: '1.0.0' },
  },
})

describe('Web-hosted MCP transport', () => {
  it('rejects missing credentials and accepts a rotated Bearer token', async () => {
    const route = await bootRoute('first-secret')
    const denied = await fetch(route.url, { method: 'POST', body: initialize, headers: { 'content-type': 'application/json' } })
    expect(denied.status).toBe(401)
    expect(denied.headers.get('www-authenticate')).toBe('Bearer')

    const accepted = await fetch(route.url, {
      method: 'POST',
      body: initialize,
      headers: {
        authorization: 'bearer first-secret',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
    })
    expect(accepted.status).toBe(200)
    const initialized = (await readJsonResponse(accepted)).result as { serverInfo: { name: string } }
    expect(initialized.serverInfo.name).toBe('dsh-mcp-agent')

    const next = 'second-secret'
    route.resolveCredential.mockResolvedValue({ value: next, source: 'env' as const })
    const oldToken = await fetch(route.url, {
      method: 'POST', body: initialize,
      headers: { authorization: 'Bearer first-secret', 'content-type': 'application/json' },
    })
    expect(oldToken.status).toBe(401)
    const newToken = await fetch(route.url, {
      method: 'POST', body: initialize,
      headers: {
        authorization: 'Bearer second-secret',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
    })
    expect(newToken.status).toBe(200)
    expect(route.resolveCredential).toHaveBeenCalledTimes(3)
  })

  it('retains one MCP transport per protocol session while keeping the runtime registry shared', async () => {
    const route = await bootRoute('secret')
    const initialized = await fetch(route.url, {
      method: 'POST',
      body: initialize,
      headers: {
        authorization: 'Bearer secret',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
    })
    expect(initialized.status).toBe(200)
    const sessionId = initialized.headers.get('mcp-session-id')
    expect(sessionId).not.toBeNull()
    const response = await fetch(route.url, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      headers: {
        authorization: 'Bearer secret',
        'mcp-session-id': sessionId as string,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
    })
    expect(response.status).toBe(200)
    const body = await readJsonResponse(response)
    const tools = (body.result as { tools: { name: string }[] }).tools
    expect(tools.map(tool => tool.name)).toContain('web_probe')
    expect(runtimeRegisterTools).toHaveBeenCalledTimes(1)
  })
})

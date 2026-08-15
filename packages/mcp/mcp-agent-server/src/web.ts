/**
 * Streamable HTTP transport for the shared DSH delegation runtime.
 *
 * The HTTP endpoint is hosted by the Web Host so its sessions, workspace
 * registry and event stream are the same services the browser already uses.
 * Each MCP protocol session gets its own server and transport; task state
 * lives in the runtime returned by {@link createRuntime}.
 *
 * @module @deepseek-ai/dsh-mcp-agent-server/web
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Config as AgentConfig } from './index.ts'
import { createMcpServer, createRuntime, validateConfig } from './index.ts'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'

/** Web-hosted MCP plugin name. */
export const name = 'mcp-agent-server-web'
/** Services required by the Web transport and shared task runtime. */
export const inject = [
  'agents', 'jobs', 'sessionPersistence', 'agentPresets', 'agentDefaultModel', 'permissionPresets',
  'webServer', 'workspaceRegistry', 'credentials',
]

/** Web transport configuration. */
export interface Config extends AgentConfig {
  /** Exact Web Host route claimed by the MCP endpoint. */
  path?: string
  /** Credential reference resolved for the Authorization Bearer token. */
  authCredential?: string
}

/** Schemastery schema for the Web transport. */
export const Config: z<Config> = z.object({
  allowedRoots: z.array(z.string()).required(),
  allowedPermissionPresets: z.array(z.string()).default(['read-only']),
  defaultPermissionPreset: z.string().default('read-only'),
  maxWaitMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
  maxResultBytes: z.number().step(1).min(1).default(65_536),
  path: z.string().default('/mcp/dsh-agent'),
  authCredential: z.string().default('DSH_MCP_TOKEN'),
})

/**
 * Validate the Web transport's route and credential reference settings.
 *
 * @param config - Web transport configuration after composition defaults.
 */
export function validateWebConfig(config: Config): void {
  validateConfig(config)
  if (config.path !== undefined
    && (!config.path.startsWith('/') || config.path.length < 2 || config.path.endsWith('/') || config.path.includes('?'))) {
    throw new Error('mcp-agent-server-web: path must be an absolute route without a trailing slash or query')
  }
  if (config.authCredential !== undefined && config.authCredential.trim().length === 0) {
    throw new Error('mcp-agent-server-web: authCredential must be non-empty')
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

async function authorized(ctx: Context, request: IncomingMessage, reference: ReturnType<typeof credentialRef>): Promise<boolean> {
  const header = request.headers.authorization
  const match = header === undefined ? undefined : /^Bearer\s+(.+)$/iu.exec(header)
  if (match === undefined || match === null) return false
  const credential = await ctx.credentials.resolve(reference)
  const token = match[1]
  return credential !== undefined && token !== undefined && sameSecret(token, credential.value)
}

function unauthorized(response: ServerResponse): void {
  response.writeHead(401, { 'WWW-Authenticate': 'Bearer' })
  response.end('Unauthorized')
}

/**
 * Mount the Web-hosted Streamable HTTP MCP endpoint.
 *
 * @param ctx - Web Host context carrying the shared DSH services.
 * @param rawConfig - delegation roots, native permission policy, path and credential policy.
 */
export async function apply(ctx: Context, rawConfig: Config): Promise<void> {
  validateWebConfig(rawConfig)
  const { path = '/mcp/dsh-agent', authCredential = 'DSH_MCP_TOKEN', ...agentConfig } = rawConfig
  const config = { ...agentConfig, path, authCredential }
  const reference = credentialRef(config.authCredential)
  const runtime = await createRuntime(ctx, config, {
    onSessionReady: async (session) => {
      if (session.header.cwd === undefined) {
        throw new Error(`mcp-agent-server-web: session "${session.id}" has no workspace cwd`)
      }
      const workspace = await ctx.workspaceRegistry.create(session.header.cwd)
      await workspace.attachSession(session.id)
    },
  })

  interface TransportState {
    readonly server: McpServer
    readonly transport: StreamableHTTPServerTransport
    closed: boolean
  }

  const transports = new Map<string, TransportState>()
  const closeTransport = async (state: TransportState): Promise<void> => {
    if (state.closed) return
    state.closed = true
    for (const [sessionId, current] of transports) {
      if (current === state) transports.delete(sessionId)
    }
    try {
      await state.transport.close()
    } catch (error) {
      ctx.logger.warn(`mcp-agent-server-web: transport close failed: ${String(error)}`)
    }
    try {
      await state.server.close()
    } catch (error) {
      ctx.logger.warn(`mcp-agent-server-web: MCP request close failed: ${String(error)}`)
    }
  }

  const createTransport = async (): Promise<TransportState> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        if (!state.closed) transports.set(sessionId, state)
      },
      onsessionclosed: (sessionId) => {
        const current = transports.get(sessionId)
        if (current !== undefined) {
          transports.delete(sessionId)
          void closeTransport(current)
        }
      },
    })
    const server = createMcpServer()
    runtime.registerTools(server)
    await server.connect(transport as Transport)
    const state: TransportState = { server, transport, closed: false }
    return state
  }

  let unregister: () => void
  try {
    unregister = ctx.webServer.register({
      kind: 'exact',
      path: config.path,
      handler: async (request, response) => {
        if (!(await authorized(ctx, request, reference))) {
          unauthorized(response)
          return
        }
        const requestedSessionId = request.headers['mcp-session-id']
        const sessionId = Array.isArray(requestedSessionId) ? requestedSessionId[0] : requestedSessionId
        let state = sessionId === undefined ? undefined : transports.get(sessionId)
        if (sessionId !== undefined && state === undefined) {
          response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'MCP session not found' },
            id: null,
          }))
          return
        }
        const createdForRequest = state === undefined
        try {
          if (state === undefined) state = await createTransport()
          await state.transport.handleRequest(request, response)
          // A transport without a protocol session (for example a malformed
          // non-initialize request) is request-scoped and can be released.
          // Once initialization returns a session id, retain it for the
          // standard MCP client's later tools/call requests.
          if (createdForRequest && state.transport.sessionId === undefined) await closeTransport(state)
          if (request.method === 'DELETE') await closeTransport(state)
        } catch (_error: unknown) {
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }))
          } else {
            response.destroy()
          }
          if (createdForRequest && state !== undefined) await closeTransport(state)
        }
      },
    })
  } catch (error) {
    await runtime.shutdown()
    throw error
  }

  ctx.effect(() => () => {
    unregister()
    return Promise.all([...new Set(transports.values())].map(closeTransport))
      .then(() => runtime.shutdown())
  }, 'mcp-agent-server-web.lifecycle')
}

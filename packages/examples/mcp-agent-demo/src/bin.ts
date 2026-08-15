#!/usr/bin/env node
/**
 * Boot an external Cordis composition that exposes the DSH MCP agent server.
 * Stdout belongs exclusively to MCP frames; diagnostics and boot failures use
 * stderr through the shared app-boot helpers.
 * @module @deepseek-ai/dsh-mcp-agent-demo/bin
 */

import { parseArgs } from 'node:util'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-mcp-agent'

/* v8 ignore start -- thin process wiring; protocol behavior is owned by the
   package plugin and the executable smoke. */
installFailLoud(NAME)
loadEnv(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
})
const requested = values.config
if (requested === undefined || requested.trim().length === 0) {
  process.stderr.write(`usage: ${NAME} --config <path-to-cordis.yml>\n`)
  process.exit(1)
}
const ctx = await boot(NAME, resolveConfigPath(requested, undefined))
let exiting = false
async function disposeAndExit(code: number): Promise<void> {
  if (exiting) return
  exiting = true
  try {
    await ctx.fiber.dispose()
  } finally {
    process.exit(code)
  }
}
process.stdin.on('end', () => { void disposeAndExit(0) })
process.on('SIGTERM', () => { void disposeAndExit(0) })
process.on('SIGINT', () => { void disposeAndExit(130) })
/* v8 ignore stop */

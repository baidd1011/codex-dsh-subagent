/** Package-owned invariant companion for `@deepseek-ai/dsh-mcp-agent-demo`. @module @deepseek-ai/dsh-mcp-agent-demo/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-agent-demo'

/** Cordis companion plugin name. */
export const name = 'mcp-agent-demo-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bin package owns no independent event stream or
 * mutable runtime state; its loader wiring is covered by the real bin smoke.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

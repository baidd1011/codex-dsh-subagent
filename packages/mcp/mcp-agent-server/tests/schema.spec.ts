import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWithinAllowedRoot, validateConfig } from '../src/index.ts'
import { validateWebConfig } from '../src/web.ts'

const root = resolve('mcp-agent-test-root')
const base = {
  allowedRoots: [root],
}

describe('mcp-agent-server config validation', () => {
  it('accepts the read-only default and explicit native permission presets', () => {
    expect(() => { validateConfig(base) }).not.toThrow()
    expect(() => { validateConfig({ ...base, allowedPermissionPresets: ['read-only', 'workspace-write'], defaultPermissionPreset: 'workspace-write' }) }).not.toThrow()
  })

  it('rejects an empty or relative allowed root', () => {
    expect(() => { validateConfig({ ...base, allowedRoots: [] }) }).toThrow(/at least one directory/)
    expect(() => { validateConfig({ ...base, allowedRoots: ['relative'] }) }).toThrow(/must be absolute/)
  })

  it('rejects permission presets that are not explicitly admitted', () => {
    expect(() => { validateConfig({ ...base, allowedPermissionPresets: [] }) }).toThrow(/allowedPermissionPresets/)
    expect(() => { validateConfig({ ...base, allowedPermissionPresets: ['read-only'], defaultPermissionPreset: 'workspace-write' }) }).toThrow(/defaultPermissionPreset/)
    expect(() => { validateConfig({ ...base, allowedPermissionPresets: [''] }) }).toThrow(/allowedPermissionPresets/)
  })

  it('rejects invalid positive bounds', () => {
    expect(() => { validateConfig({ ...base, maxWaitMs: 0 }) }).toThrow(/maxWaitMs/)
    expect(() => { validateConfig({ ...base, maxWaitMs: 2_147_483_648 }) }).toThrow(/maxWaitMs/)
    expect(() => { validateConfig({ ...base, maxResultBytes: Number.POSITIVE_INFINITY }) }).toThrow(/maxResultBytes/)
  })
})

describe('mcp-agent-server allowed-root containment', () => {
  it('accepts the root and descendants', () => {
    expect(isWithinAllowedRoot(root, root)).toBe(true)
    expect(isWithinAllowedRoot(root, join(root, 'child'))).toBe(true)
  })

  it('rejects parents, siblings and traversal paths', () => {
    expect(isWithinAllowedRoot(root, resolve(root, '..'))).toBe(false)
    expect(isWithinAllowedRoot(root, `${root}-sibling`)).toBe(false)
    expect(isWithinAllowedRoot(root, join(root, '..', 'outside'))).toBe(false)
  })
})

describe('mcp-agent-server Web configuration', () => {
  it('accepts the default route and credential reference', () => {
    expect(() => {
      validateWebConfig({
        ...base,
        allowedPermissionPresets: ['read-only', 'workspace-write'],
        path: '/mcp/dsh-agent',
        authCredential: 'DSH_MCP_TOKEN',
      })
    }).not.toThrow()
  })

  it.each([
    ['relative path', { path: 'mcp/dsh-agent' }],
    ['trailing slash', { path: '/mcp/dsh-agent/' }],
    ['query string', { path: '/mcp/dsh-agent?x=1' }],
    ['empty credential reference', { authCredential: '   ' }],
  ])('rejects a %s', (_label, change) => {
    expect(() => { validateWebConfig({ ...base, ...change }) }).toThrow(/mcp-agent-server-web/)
  })
})

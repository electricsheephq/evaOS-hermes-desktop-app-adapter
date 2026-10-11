import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as sdk from '@hermes/plugin-sdk'
import * as react from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { describe, expect, it } from 'vitest'

// Vendored plugin builds (src/plugins/<id>/plugin.js) are copied byte for byte from their own repos, so nothing
// type-checks them against this app. This guard fails the app's tests, before any release, when an upstream merge
// drops a name a vendored plugin imports, or when a plugin imports anything outside the runtime allowlist.
const PLUGINS = join(__dirname, '..', 'plugins')
const MODULES: Record<string, object> = { '@hermes/plugin-sdk': sdk, react, 'react/jsx-runtime': jsxRuntime }

const vendored = readdirSync(PLUGINS, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => {
    try {
      return readFileSync(join(PLUGINS, name, 'plugin.js')).length > 0
    } catch {
      return false
    }
  })

function imports(source: string) {
  const statements = source.match(/^\s*import\b/gm)?.length ?? 0

  const named = [...source.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm)].map(match => ({
    module: match[2],
    names: match[1]
      .split(',')
      .map(part => part.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
  }))

  // Only `import { … } from '…'` can be checked by name, so any other import form fails the guard.
  const unchecked = /\bimport\s*\(|^\s*export\b[^;]*\bfrom\b|\brequire\s*\(/m.test(source)

  return { named, statements, unchecked }
}

describe('vendored bundled plugins', () => {
  it('finds the vendored builds', () => {
    expect(vendored).toEqual(expect.arrayContaining(['fish-audio', 'hermes-cloud-file-manager']))
  })

  it.each(vendored)('%s imports only allowlisted modules and names they export', name => {
    const { named, statements, unchecked } = imports(readFileSync(join(PLUGINS, name, 'plugin.js'), 'utf8'))
    expect(named.length).toBeGreaterThan(0)
    expect(statements).toBe(named.length)
    expect(unchecked).toBe(false)
    expect(named.filter(i => !(i.module in MODULES)).map(i => i.module)).toEqual([])
    expect(named.flatMap(i => i.names.filter(n => !(n in (MODULES[i.module] ?? {}))).map(n => `${i.module}:${n}`))).toEqual([])
  })
})

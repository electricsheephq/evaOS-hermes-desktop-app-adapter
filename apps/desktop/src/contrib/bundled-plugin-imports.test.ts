import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as sdk from '@hermes/plugin-sdk'
import { describe, expect, it } from 'vitest'

// Vendored plugin builds (src/plugins/<id>/plugin.js) are copied byte for byte from their own repos, so nothing
// type-checks them against this app. This guard fails the app's tests, before any release, when an upstream merge
// drops an SDK name a vendored plugin imports, or when a plugin imports anything outside the runtime allowlist.
const PLUGINS = join(__dirname, '..', 'plugins')
const ALLOWED = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])

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
  const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)].map(match => match[1])

  const names = [...source.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*["']@hermes\/plugin-sdk["']/gm)].flatMap(match =>
    match[1]
      .split(',')
      .map(part => part.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
  )

  return { names, specifiers }
}

describe('vendored bundled plugins', () => {
  it('finds the vendored builds', () => {
    expect(vendored).toEqual(expect.arrayContaining(['fish-audio', 'hermes-cloud-file-manager']))
  })

  it.each(vendored)('%s imports only allowlisted modules and SDK names this app exports', name => {
    const { names, specifiers } = imports(readFileSync(join(PLUGINS, name, 'plugin.js'), 'utf8'))
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(specifier => !ALLOWED.has(specifier))).toEqual([])
    expect(names.filter(imported => !(imported in sdk))).toEqual([])
  })
})

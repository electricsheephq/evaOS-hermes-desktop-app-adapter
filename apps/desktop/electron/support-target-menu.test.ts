import assert from 'node:assert/strict'

import { test } from 'vitest'

import { supportTargetMenuPlacement } from './support-target-menu'

const item = { label: 'Switch Support Target…' }

test('a managed build carries the switch entry on every platform', () => {
  for (const isMac of [true, false]) {
    const { appMenu, fileMenu } = supportTargetMenuPlacement(item, { isMac, managed: true })
    const entries = [...appMenu, ...fileMenu]

    assert.equal(
      entries.filter(entry => entry === item).length,
      1,
      `expected exactly one switch entry with isMac=${isMac}`
    )
    assert.deepEqual(entries.at(-1), { type: 'separator' })
  }
})

test('the entry sits in the application menu on macOS and the File menu elsewhere', () => {
  assert.deepEqual(supportTargetMenuPlacement(item, { isMac: true, managed: true }), {
    appMenu: [item, { type: 'separator' }],
    fileMenu: []
  })
  assert.deepEqual(supportTargetMenuPlacement(item, { isMac: false, managed: true }), {
    appMenu: [],
    fileMenu: [item, { type: 'separator' }]
  })
})

test('an unmanaged build carries no switch entry at all', () => {
  assert.deepEqual(supportTargetMenuPlacement(item, { isMac: true, managed: false }), { appMenu: [], fileMenu: [] })
  assert.deepEqual(supportTargetMenuPlacement(item, { isMac: false, managed: false }), { appMenu: [], fileMenu: [] })
})

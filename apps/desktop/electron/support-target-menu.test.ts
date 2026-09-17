import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { supportTargetMenuPlacement, switchSupportTargetMenuItem } from './support-target-menu'

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

test('the switch click opens the picker only after switching resolves', async () => {
  let resolveSwitch!: () => void
  const openPicker = vi.fn()
  const pending = new Promise<void>(resolve => (resolveSwitch = resolve))
  const { click } = switchSupportTargetMenuItem({ switchSupportTarget: () => pending, openPicker, log: vi.fn() })

  click()
  assert.equal(openPicker.mock.calls.length, 0)
  resolveSwitch()
  await vi.waitFor(() => assert.equal(openPicker.mock.calls.length, 1))
})

test('the switch click never opens the picker on rejection and logs only a bounded code', async () => {
  for (const [error, expected] of [
    [{ code: 'support-session-active' }, 'support-session-active'],
    [{ code: 'Bad Code With detail@x' }, 'switch-target-failed'],
    [new Error('private detail'), 'switch-target-failed']
  ] as const) {
    const openPicker = vi.fn()
    const log = vi.fn()

    const { click } = switchSupportTargetMenuItem({
      switchSupportTarget: () => Promise.reject(error),
      openPicker,
      log
    })

    click()
    await vi.waitFor(() => assert.equal(log.mock.calls.length, 1))
    assert.equal(openPicker.mock.calls.length, 0)
    assert.equal(log.mock.calls[0][0], `[eva-support] switch support target rejected: ${expected}`)
    assert.equal(log.mock.calls[0][0].includes('private detail'), false)
  }
})

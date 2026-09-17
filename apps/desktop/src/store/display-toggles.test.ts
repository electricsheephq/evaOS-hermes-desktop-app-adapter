import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const $gateway = atom<unknown>(null)
const $evaManagedStatus = atom<Record<string, unknown> | null>(null)
const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => undefined)
let managed = false

vi.mock('@/store/gateway', () => ({
  $gateway,
  activeGateway: () => ({ request })
}))
vi.mock('@/i18n/managed-brand', () => ({ isManagedEvaosAgent: () => managed }))
vi.mock('@/store/support-picker', () => ({ $evaManagedStatus }))

const { mirrorDisplayToggle } = await import('./display-toggles')

const STORAGE_KEY = 'hermes.desktop.test-toggle.v1'

const $enabled = atom(true)

mirrorDisplayToggle('display.test_toggle', STORAGE_KEY, $enabled)

const sets = () => request.mock.calls.filter(([method]) => method === 'config.set').map(([, params]) => params)

beforeEach(() => {
  managed = false
  $evaManagedStatus.set(null)
  localStorage.clear()
  request.mockClear()
  $enabled.set(true)
  request.mockClear()
})

describe('display toggle mirror', () => {
  it('sends the user answer to the gateway when it changes', () => {
    $enabled.set(false)

    expect(sets()).toEqual([{ key: 'display.test_toggle', value: 'false' }])
  })

  it('re-sends a touched setting to a gateway that has never seen it', () => {
    localStorage.setItem(STORAGE_KEY, 'false')
    $enabled.set(false)
    request.mockClear()

    $gateway.set({})

    expect(sets()).toEqual([{ key: 'display.test_toggle', value: 'false' }])
  })

  it('does not write a touched setting when a managed gateway connects', () => {
    managed = true
    $evaManagedStatus.set({ delegatedSupportActive: false })
    localStorage.setItem(STORAGE_KEY, 'false')

    $gateway.set({})

    expect(sets()).toEqual([])
  })

  it('sends an explicit managed toggle for an ordinary session', () => {
    managed = true
    $evaManagedStatus.set({ delegatedSupportActive: false })

    $enabled.set(false)

    expect(sets()).toEqual([{ key: 'display.test_toggle', value: 'false' }])
  })

  it('keeps an explicit managed toggle local during delegated support', () => {
    managed = true
    $evaManagedStatus.set({ delegatedSupportActive: true })

    $enabled.set(false)

    expect(sets()).toEqual([])
  })

  it('keeps an explicit managed toggle local while managed status is unknown', () => {
    managed = true

    $enabled.set(false)

    expect(sets()).toEqual([])
  })

  it('leaves an untouched setting alone, so a hand-edited config.yaml wins', () => {
    $gateway.set({})

    expect(sets()).toEqual([])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ingestBackendSkin: vi.fn(),
  setChangeEventsAvailable: vi.fn()
}))

vi.mock('@/store/live-sync', () => ({
  notifyCronChanged: vi.fn(),
  notifyPairingChanged: vi.fn(),
  notifyPetChanged: vi.fn(),
  notifyPlatformsChanged: vi.fn(),
  notifySessionsChanged: vi.fn(),
  setChangeEventsAvailable: mocks.setChangeEventsAvailable
}))
vi.mock('@/store/session-states', () => ({ dropSessionState: vi.fn(), unbindTileRuntime: vi.fn() }))
vi.mock('@/themes/backend-sync', () => ({ ingestBackendSkin: mocks.ingestBackendSkin }))

import { handleLifecycleEvent } from './lifecycle'
import type { GatewayEventContext } from './types'

const SKIN = { id: 'test-skin' }

function context(fromActive: boolean, changeEvents: boolean): GatewayEventContext {
  return {
    deps: {},
    event: { type: 'gateway.ready' },
    explicitSid: '',
    fromActiveSource: () => fromActive,
    isActiveEvent: false,
    occurredAt: 0,
    payload: { change_events: changeEvents, skin: SKIN },
    sessionId: null
  } as unknown as GatewayEventContext
}

describe('gateway lifecycle source isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not replace the active capability flag from a background gateway', () => {
    expect(handleLifecycleEvent(context(false, true))).toBe(true)
    expect(mocks.setChangeEventsAvailable).not.toHaveBeenCalled()
    expect(mocks.ingestBackendSkin).not.toHaveBeenCalled()
  })

  it('updates the capability flag for the active gateway', () => {
    expect(handleLifecycleEvent(context(true, true))).toBe(true)
    expect(mocks.setChangeEventsAvailable).toHaveBeenCalledWith(true)
    expect(mocks.ingestBackendSkin).toHaveBeenCalledWith(SKIN, { apply: false })
  })
})

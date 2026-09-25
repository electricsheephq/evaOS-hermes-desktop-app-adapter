import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useStatusSnapshot } from '@/app/shell/hooks/use-status-snapshot'
import { getStatus } from '@/hermes'
import { $setupReadyTick } from '@/store/live-sync'
import type * as LiveSyncModule from '@/store/live-sync'

import { handleLifecycleEvent } from './lifecycle'
import type { GatewayEventContext } from './types'

const sourceIsolationMocks = vi.hoisted(() => ({
  ingestBackendSkin: vi.fn(),
  setChangeEventsAvailable: vi.fn()
}))

vi.mock('@/store/live-sync', async importOriginal => ({
  ...(await importOriginal<typeof LiveSyncModule>()),
  setChangeEventsAvailable: sourceIsolationMocks.setChangeEventsAvailable
}))
vi.mock('@/themes/backend-sync', () => ({ ingestBackendSkin: sourceIsolationMocks.ingestBackendSkin }))

vi.mock(import('@/hermes'), async importOriginal => ({
  ...(await importOriginal()),
  getStatus: vi.fn()
}))

type GatewayRequester = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

const SKIN = { id: 'test-skin' }

function gatewayReadyContext(fromActive: boolean, changeEvents: boolean): GatewayEventContext {
  const payload = { change_events: changeEvents, skin: SKIN }

  return {
    deps: {},
    event: { payload, type: 'gateway.ready' },
    explicitSid: '',
    fromActiveSource: () => fromActive,
    isActiveEvent: false,
    occurredAt: 0,
    payload,
    sessionId: null
  } as unknown as GatewayEventContext
}

describe('gateway lifecycle source isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not replace the active capability flag from a background gateway', () => {
    expect(handleLifecycleEvent(gatewayReadyContext(false, true))).toBe(true)
    expect(sourceIsolationMocks.setChangeEventsAvailable).not.toHaveBeenCalled()
    expect(sourceIsolationMocks.ingestBackendSkin).not.toHaveBeenCalled()
  })

  it('updates the capability flag for the active gateway', () => {
    expect(handleLifecycleEvent(gatewayReadyContext(true, true))).toBe(true)
    expect(sourceIsolationMocks.setChangeEventsAvailable).toHaveBeenCalledWith(true)
    expect(sourceIsolationMocks.ingestBackendSkin).toHaveBeenCalledWith(SKIN, { apply: false })
  })
})

function setupReadyContext(fromActiveSource: boolean): GatewayEventContext {
  const payload = {
    error: '',
    finished_at: 1_700_000_100,
    free_tier: true,
    has_identity: true,
    inference_provider: 'nous',
    other_providers: false,
    provider_configured: true
  }

  return {
    deps: {} as GatewayEventContext['deps'],
    event: { payload, type: 'setup.ready' },
    explicitSid: '',
    fromActiveSource: () => fromActiveSource,
    isActiveEvent: false,
    occurredAt: 1_700_000_100,
    payload: payload as GatewayEventContext['payload'],
    scheduleConfigRefresh: vi.fn(),
    sessionId: null
  }
}

async function flushAsync() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** Mount the status snapshot on an open gateway and return its requester with
 *  the open-time readiness round already consumed. */
async function mountedStatusSnapshot() {
  const requestGateway = vi.fn(
    async (method: string) => (method === 'setup.runtime_check' ? { ok: true } : { provider_configured: true }) as never
  )

  renderHook(() => useStatusSnapshot('open', requestGateway as unknown as GatewayRequester))
  await flushAsync()
  requestGateway.mockClear()
  vi.mocked(getStatus).mockClear()

  return requestGateway
}

function callsTo(requestGateway: ReturnType<typeof vi.fn>, method: string) {
  return requestGateway.mock.calls.filter(([called]) => called === method)
}

describe('handleLifecycleEvent setup.ready', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.mocked(getStatus)
      .mockReset()
      .mockResolvedValue({} as never)
    $setupReadyTick.set(0)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('claims the event and triggers one free-tier refresh plus one readiness evaluation from the active source', async () => {
    const requestGateway = await mountedStatusSnapshot()

    expect(handleLifecycleEvent(setupReadyContext(true))).toBe(true)
    await flushAsync()

    expect(callsTo(requestGateway, 'free_tier.status')).toHaveLength(1)
    expect(callsTo(requestGateway, 'setup.runtime_check')).toHaveLength(1)
    expect(callsTo(requestGateway, 'setup.status')).toHaveLength(1)
    // The push is a readiness seam, not a status tick.
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('claims but ignores setup.ready from a non-active source', async () => {
    const requestGateway = await mountedStatusSnapshot()

    expect(handleLifecycleEvent(setupReadyContext(false))).toBe(true)
    await flushAsync()

    expect(requestGateway).not.toHaveBeenCalled()
    expect($setupReadyTick.get()).toBe(0)
  })
})

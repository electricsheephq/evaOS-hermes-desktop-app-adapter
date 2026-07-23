// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { $gateway } from '@/store/gateway'
import { $gatewayState } from '@/store/session'

import { useGatewayRequest } from './use-gateway-request'

describe('useGatewayRequest', () => {
  beforeEach(() => {
    $gateway.set(null)
    $gatewayState.set('idle')
  })

  afterEach(() => {
    cleanup()
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
  })

  it('reconnects the live gateway when the UI state is stale-open', async () => {
    let transportState: 'closed' | 'open' = 'closed'
    let requestCount = 0

    const gateway = {
      get connectionState() {
        return transportState
      },
      connect: vi.fn(async () => {
        transportState = 'open'
      }),
      request: vi.fn(async () => {
        requestCount += 1

        if (transportState !== 'open') {
          throw new Error('evaOS Agent gateway is not connected')
        }

        return { ok: true }
      })
    } as unknown as HermesGateway

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      getConnection: vi.fn(async () => ({
        authMode: 'oauth',
        baseUrl: 'https://agent.example',
        profile: 'default',
        token: '',
        wsUrl: 'wss://agent.example/api/ws?ticket=stale'
      })),
      getGatewayWsUrl: vi.fn(async () => 'wss://agent.example/api/ws?ticket=fresh')
    }

    $gateway.set(gateway)
    // Reproduce the customer screenshot: the status bar still says ready even
    // though the socket used by prompt.submit has already closed.
    $gatewayState.set('open')

    const { result } = renderHook(() => useGatewayRequest())

    await act(async () => {
      await expect(result.current.requestGateway('prompt.submit', { text: 'hello' })).resolves.toEqual({ ok: true })
    })

    expect(requestCount).toBe(2)
    expect(gateway.connect).toHaveBeenCalledWith('wss://agent.example/api/ws?ticket=fresh')
  })
})

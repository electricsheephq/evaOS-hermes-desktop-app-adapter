import { afterEach, expect, it, vi } from 'vitest'

import { setApiRequestConnection } from '@/api/client'
import { setApiRequestProfile } from '@/hermes'

import { resolveSpeakStreamUrl } from './voice-playback'

afterEach(() => {
  setApiRequestProfile(null)
  setApiRequestConnection(null)
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

it('accepts only the exact managed speech-stream endpoint', async () => {
  const getConnection = vi.fn(async (profile: null | string) => ({
    authMode: 'token',
    profile,
    wsUrl: 'ws://127.0.0.1:4123/api/ws?ticket=stale'
  }))
  const getGatewayWsUrl = vi
    .fn()
    .mockResolvedValueOnce('ws://127.0.0.1:4123/unexpected/api/audio/speak-stream?ticket=wrong')
    .mockResolvedValueOnce('ws://127.0.0.1:4123/api/audio/speak-stream?ticket=exact')
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = { getConnection, getGatewayWsUrl }
  setApiRequestProfile('research')

  await expect(resolveSpeakStreamUrl()).resolves.toBeNull()
  await expect(resolveSpeakStreamUrl()).resolves.toBe(
    'ws://127.0.0.1:4123/api/audio/speak-stream?ticket=exact&profile=research'
  )
  expect(getGatewayWsUrl).toHaveBeenCalledWith('research', '/api/audio/speak-stream')
})

it('mints an endpoint-bound managed ticket after resolving the owning registry route', async () => {
  const getConnectionFor = vi.fn(async () => ({
    authMode: 'token',
    baseUrl: 'eva-managed://assigned',
    profile: 'research',
    wsUrl: 'ws://127.0.0.1:4123/api/ws?ticket=stale'
  }))
  const getGatewayWsUrl = vi.fn(async () => ({
    ok: true,
    wsUrl: 'ws://127.0.0.1:4123/api/audio/speak-stream?ticket=exact'
  }))
  const getGatewayWsUrlFor = vi.fn(async () => ({
    ok: true,
    wsUrl: 'ws://127.0.0.1:4123/api/ws?ticket=wrong-endpoint'
  }))
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
    getConnection: vi.fn(),
    getConnectionFor,
    getGatewayWsUrl,
    getGatewayWsUrlFor
  }
  setApiRequestProfile('research')
  setApiRequestConnection('eva-managed-runtime')

  await expect(resolveSpeakStreamUrl()).resolves.toBe(
    'ws://127.0.0.1:4123/api/audio/speak-stream?ticket=exact&profile=research'
  )
  expect(getConnectionFor).toHaveBeenCalledExactlyOnceWith({
    connectionId: 'eva-managed-runtime',
    profile: 'research'
  })
  expect(getGatewayWsUrl).toHaveBeenCalledExactlyOnceWith('research', '/api/audio/speak-stream')
  expect(getGatewayWsUrlFor).not.toHaveBeenCalled()
})

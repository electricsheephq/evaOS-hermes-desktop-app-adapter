import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({
  requestForSessionProfile: vi.fn(async () => ({ status: 'answered' }))
}))

vi.mock('./session-request-router', () => ({
  isSessionOwnerRoute: (owner: unknown) => Boolean(owner && typeof owner === 'object' && 'connectionId' in owner),
  requestForSessionProfile: router.requestForSessionProfile
}))

import { $connectionsRegistry } from './connection-registry-state'
import { $gateway } from './gateway'
import { $mcpSetupRequests, hasMcpSetupRequest, setMcpSetupRequest, skipMcpSetupRequest } from './mcp-setup'
import { $sessionTiles } from './session-states'

describe('skipMcpSetupRequest', () => {
  const ambientRequest = vi.fn(async () => ({ status: 'ambient' }))

  beforeEach(() => {
    $mcpSetupRequests.set({})
    $sessionTiles.set([])
    $connectionsRegistry.set(null)
    ambientRequest.mockClear()
    router.requestForSessionProfile.mockClear()
    $gateway.set({ request: ambientRequest } as unknown as ReturnType<typeof $gateway.get>)
  })

  afterEach(() => {
    $mcpSetupRequests.set({})
    $sessionTiles.set([])
    $connectionsRegistry.set(null)
    $gateway.set(null)
  })

  it('routes a typed decline through the session owner before dropping its card', async () => {
    const owner = { connectionId: 'source-a', profile: 'clientops', targetProfile: 'asuka' }
    $sessionTiles.set([{ storedSessionId: 'stored-a', runtimeId: 'runtime-a', ownerRoute: owner }])
    setMcpSetupRequest({
      action: 'install',
      reason: 'Synthetic setup request',
      requestId: 'request-a',
      server: 'synthetic-mcp',
      sessionId: 'runtime-a'
    })

    await expect(skipMcpSetupRequest('runtime-a')).resolves.toBe(true)

    expect(router.requestForSessionProfile).toHaveBeenCalledWith(owner, expect.any(Function), 'mcp.setup.respond', {
      request_id: 'request-a',
      result: JSON.stringify({ server: 'synthetic-mcp', status: 'declined' })
    })
    expect(ambientRequest).not.toHaveBeenCalled()
    expect(hasMcpSetupRequest('runtime-a')).toBe(false)
  })

  it('keeps the card when a registry session owner is unknown', async () => {
    $connectionsRegistry.set({ connections: [{ id: 'local' }] } as never)
    setMcpSetupRequest({
      action: 'install',
      reason: 'Synthetic setup request',
      requestId: 'request-unknown',
      server: 'synthetic-mcp',
      sessionId: 'runtime-unknown'
    })

    await expect(skipMcpSetupRequest('runtime-unknown')).resolves.toBe(false)

    expect(router.requestForSessionProfile).not.toHaveBeenCalled()
    expect(ambientRequest).not.toHaveBeenCalled()
    expect(hasMcpSetupRequest('runtime-unknown')).toBe(true)
  })
})

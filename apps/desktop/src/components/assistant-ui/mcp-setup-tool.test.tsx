import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $gateway } from '@/store/gateway'
import { clearMcpSetupRequest, setMcpSetupRequest } from '@/store/mcp-setup'
import { $profiles } from '@/store/profile'
import { $activeSessionId, _resetSessionOwnerHintsForTests, setSessionOwnerHint } from '@/store/session'

import { McpSetupTool } from './mcp-setup-tool'

const gatewayMocks = vi.hoisted(() => ({
  requestGatewayForAgent: vi.fn(async () => ({ ok: true }))
}))

const hermesMocks = vi.hoisted(() => ({
  setMcpServerEnabled: vi.fn(async () => ({ ok: true }))
}))

vi.mock('@/store/gateway', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestGatewayForAgent: gatewayMocks.requestGatewayForAgent
}))

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  setMcpServerEnabled: hermesMocks.setMcpServerEnabled
}))

vi.mock('@assistant-ui/react', () => ({
  useAuiState: () => true
}))

afterEach(() => {
  cleanup()
  clearMcpSetupRequest()
  $activeSessionId.set(null)
  $gateway.set(null)
  $profiles.set([])
  _resetSessionOwnerHintsForTests({ storage: true })
  vi.clearAllMocks()
})

function liveProps(): ToolCallMessagePartProps {
  const args = { action: 'enable', reason: 'Needed for this task', server: 'calendar' }

  return {
    addResult: vi.fn(),
    args,
    argsText: JSON.stringify(args),
    isError: false,
    respondToApproval: vi.fn(),
    result: undefined,
    resume: vi.fn(),
    status: { type: 'running' },
    toolCallId: 'mcp-setup-live',
    toolName: 'setup_mcp',
    type: 'tool-call'
  }
}

describe('McpSetupTool owner routing', () => {
  it('mutates, reloads, and answers on the requesting session owner, never the foreground gateway', async () => {
    const ambient = vi.fn(async () => ({ ok: true }))
    const owner = { connectionId: 'conn-profile-a', profile: 'profile-a' }

    $profiles.set([{ name: 'profile-a' }, { name: 'profile-b' }] as never)
    $activeSessionId.set('session-a')
    setSessionOwnerHint('session-a', owner)
    $gateway.set({ request: ambient } as never)
    setMcpSetupRequest({
      action: 'enable',
      reason: 'Needed for this task',
      requestId: 'request-a',
      server: 'calendar',
      sessionId: 'session-a'
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <McpSetupTool {...liveProps()} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: /Enable/ }))

    await waitFor(() => {
      expect(hermesMocks.setMcpServerEnabled).toHaveBeenCalledWith('calendar', true, owner)
      expect(gatewayMocks.requestGatewayForAgent).toHaveBeenCalledTimes(2)
    })

    expect(gatewayMocks.requestGatewayForAgent).toHaveBeenNthCalledWith(
      1,
      owner.connectionId,
      owner.profile,
      'reload.mcp',
      { confirm: true, session_id: 'session-a' }
    )
    expect(gatewayMocks.requestGatewayForAgent).toHaveBeenNthCalledWith(
      2,
      owner.connectionId,
      owner.profile,
      'mcp.setup.respond',
      {
        request_id: 'request-a',
        result: JSON.stringify({ server: 'calendar', status: 'enabled' })
      }
    )
    expect(ambient).not.toHaveBeenCalled()
  })
})

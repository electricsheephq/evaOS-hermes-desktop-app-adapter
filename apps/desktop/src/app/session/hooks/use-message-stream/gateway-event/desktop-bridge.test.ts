import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readActivePreview: vi.fn(async () => ({ text: 'foreground preview' })),
  readActiveTerminal: vi.fn(() => ({ text: 'foreground terminal' })),
  revealDesktopPane: vi.fn(),
  requestGatewayForAgent: vi.fn(async () => ({}))
}))

vi.mock('@/app/chat/right-rail/preview-reader', () => ({ readActivePreview: mocks.readActivePreview }))
vi.mock('@/app/right-sidebar/terminal/agent-terminal-stream', () => ({ writeAgentTerminalChunk: vi.fn() }))
vi.mock('@/app/right-sidebar/terminal/buffer', () => ({ readActiveTerminal: mocks.readActiveTerminal }))
vi.mock('@/app/right-sidebar/terminal/terminals', () => ({ closeAgentTerminalByProc: vi.fn() }))
vi.mock('@/store/gateway', () => ({ requestGatewayForAgent: mocks.requestGatewayForAgent }))
vi.mock('@/store/pane-focus', () => ({ applyDesktopLayoutPreset: vi.fn(), revealDesktopPane: mocks.revealDesktopPane }))
vi.mock('@/store/reactions-local', () => ({ recordAgentReaction: vi.fn() }))
vi.mock('@/store/session', () => ({ setMessages: vi.fn() }))

import { handleDesktopBridgeEvent } from './desktop-bridge'
import type { GatewayEventContext } from './types'

function context(type: string, isActiveEvent: boolean, fromActiveSource = isActiveEvent): GatewayEventContext {
  return {
    deps: { activeGatewayProfile: 'active-profile' },
    event: {
      connectionId: 'source-b',
      profile: 'background-profile',
      session_id: 'runtime-session',
      type
    },
    explicitSid: 'runtime-session',
    fromActiveSource: () => fromActiveSource,
    isActiveEvent,
    occurredAt: 0,
    payload: { request_id: 'request-1' },
    sessionId: 'runtime-session'
  } as unknown as GatewayEventContext
}

describe('desktop bridge source and foreground isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers a background preview read on its source without reading the foreground pane', async () => {
    expect(handleDesktopBridgeEvent(context('preview.read.request', false))).toBe(true)
    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())

    expect(mocks.readActivePreview).not.toHaveBeenCalled()
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith(
      'source-b',
      'background-profile',
      'preview.read.respond',
      { request_id: 'request-1', text: '' }
    )
  })

  it('denies a same-session-id event from a different source access to the foreground surface', async () => {
    expect(handleDesktopBridgeEvent(context('preview.read.request', true, false))).toBe(true)
    expect(handleDesktopBridgeEvent(context('pane.reveal', true, false))).toBe(true)
    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())

    expect(mocks.readActivePreview).not.toHaveBeenCalled()
    expect(mocks.revealDesktopPane).not.toHaveBeenCalled()
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith(
      'source-b',
      'background-profile',
      'preview.read.respond',
      { request_id: 'request-1', text: '' }
    )
  })

  it('reads an active terminal and returns it only through the requesting source', async () => {
    expect(handleDesktopBridgeEvent(context('terminal.read.request', true))).toBe(true)
    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())

    expect(mocks.readActiveTerminal).toHaveBeenCalledOnce()
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith(
      'source-b',
      'background-profile',
      'terminal.read.respond',
      { request_id: 'request-1', text: JSON.stringify({ text: 'foreground terminal' }) }
    )
  })

  it('answers a background window read without invoking the native foreground reader', async () => {
    const readWindowBelow = vi.fn(async () => ({
      frontmost: { app: 'Synthetic', title: 'private foreground window' },
      platform: 'darwin',
      window: {
        app: 'Synthetic',
        bounds: { height: 100, width: 100, x: 0, y: 0 },
        id: 1,
        title: 'private foreground window'
      }
    }))

    window.hermesDesktop = { ...window.hermesDesktop, readWindowBelow } as typeof window.hermesDesktop

    expect(handleDesktopBridgeEvent(context('window.read.request', false))).toBe(true)
    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())

    expect(readWindowBelow).not.toHaveBeenCalled()
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith(
      'source-b',
      'background-profile',
      'window.read.respond',
      { request_id: 'request-1', text: '' }
    )
  })
})

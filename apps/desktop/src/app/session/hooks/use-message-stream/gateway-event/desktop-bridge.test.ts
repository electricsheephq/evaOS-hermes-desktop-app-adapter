import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  actOnActivePreview: vi.fn(async () => ({ acted: 'elements', success: true })),
  readActivePreview: vi.fn(async () => ({ text: 'foreground preview' })),
  readActiveTerminal: vi.fn(() => ({ text: 'foreground terminal' })),
  recordAgentReaction: vi.fn(),
  revealDesktopPane: vi.fn(),
  requestGatewayForAgent: vi.fn(async () => ({})),
  runTour: vi.fn(async () => ({ success: true })),
  setMessages: vi.fn()
}))

vi.mock('@/app/chat/right-rail/preview-act', () => ({ actOnActivePreview: mocks.actOnActivePreview }))
vi.mock('@/app/chat/right-rail/preview-reader', () => ({ readActivePreview: mocks.readActivePreview }))
vi.mock('@/app/right-sidebar/terminal/agent-terminal-stream', () => ({ writeAgentTerminalChunk: vi.fn() }))
vi.mock('@/app/right-sidebar/terminal/buffer', () => ({ readActiveTerminal: mocks.readActiveTerminal }))
vi.mock('@/app/right-sidebar/terminal/terminals', () => ({ closeAgentTerminalByProc: vi.fn() }))
vi.mock('@/lib/tour', () => ({ runTour: mocks.runTour }))
vi.mock('@/store/gateway', () => ({ requestGatewayForAgent: mocks.requestGatewayForAgent }))
vi.mock('@/store/pane-focus', () => ({ applyDesktopLayoutPreset: vi.fn(), revealDesktopPane: mocks.revealDesktopPane }))
vi.mock('@/store/reactions-local', () => ({ recordAgentReaction: mocks.recordAgentReaction }))
vi.mock('@/store/session', () => ({ setMessages: mocks.setMessages }))

import { handleDesktopBridgeEvent } from './desktop-bridge'
import type { GatewayEventContext } from './types'

function context(type: string, isActiveEvent: boolean, fromActiveSource = isActiveEvent): GatewayEventContext {
  return {
    deps: {
      activeGatewayProfile: 'active-profile',
      activeSessionIdRef: { current: isActiveEvent ? 'runtime-session' : 'other-session' }
    },
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

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { promise, resolve }
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

  it('discards a preview read when its session loses the foreground while the read is pending', async () => {
    const pending = deferred<{ text: string }>()
    mocks.readActivePreview.mockReturnValueOnce(pending.promise)
    const ctx = context('preview.read.request', true)

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    expect(mocks.readActivePreview).toHaveBeenCalledOnce()

    ctx.deps.activeSessionIdRef.current = 'new-foreground-session'
    pending.resolve({ text: 'previous session preview' })

    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith(
      'source-b',
      'background-profile',
      'preview.read.respond',
      { request_id: 'request-1', text: '' }
    )
  })

  it('does not drive the new foreground preview after ownership changes during engine loading', async () => {
    const ctx = context('preview.act.request', true)
    const sourceOwner = { current: true }
    ctx.fromActiveSource = () => sourceOwner.current
    ctx.payload = { action: 'elements', request_id: 'request-1' } as GatewayEventContext['payload']

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    sourceOwner.current = false

    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())
    expect(mocks.actOnActivePreview).not.toHaveBeenCalled()
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith(
      'source-b',
      'background-profile',
      'preview.act.respond',
      expect.objectContaining({ request_id: 'request-1', text: expect.stringContaining('session') })
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

  it('discards a native window read when its session loses the foreground while IPC is pending', async () => {
    const pending = deferred<{ frontmost: null; platform: string; window: null }>()
    const readWindowBelow = vi.fn(() => pending.promise)
    window.hermesDesktop = { ...window.hermesDesktop, readWindowBelow } as typeof window.hermesDesktop
    const ctx = context('window.read.request', true)

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    expect(readWindowBelow).toHaveBeenCalledOnce()

    ctx.deps.activeSessionIdRef.current = 'new-foreground-session'
    pending.resolve({ frontmost: null, platform: 'darwin', window: null })

    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith(
      'source-b',
      'background-profile',
      'window.read.respond',
      { request_id: 'request-1', text: '' }
    )
  })

  it('does not paint a tour after its session loses the foreground during lazy loading', async () => {
    const ctx = context('tour.request', true)

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    ctx.deps.activeSessionIdRef.current = 'new-foreground-session'

    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())
    expect(mocks.runTour).not.toHaveBeenCalled()
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith(
      'source-b',
      'background-profile',
      'tour.respond',
      expect.objectContaining({ request_id: 'request-1', text: expect.stringContaining('session') })
    )
  })

  it('does not paint a background reaction into the foreground transcript', () => {
    const ctx = context('message.reaction', false)
    ctx.payload = {
      reactions: [{ at: 1, author: 'agent', emoji: 'eyes' }],
      role: 'assistant',
      row_id: 42
    } as GatewayEventContext['payload']

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    expect(mocks.setMessages).not.toHaveBeenCalled()
    expect(mocks.recordAgentReaction).not.toHaveBeenCalled()
  })

  it('still publishes a reaction owned by the active surface', () => {
    const ctx = context('message.reaction', true)
    ctx.payload = {
      reactions: [{ at: 1, author: 'agent', emoji: 'thumbs_up' }],
      role: 'assistant',
      row_id: 7
    } as GatewayEventContext['payload']

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    expect(mocks.setMessages).toHaveBeenCalledOnce()
  })
})

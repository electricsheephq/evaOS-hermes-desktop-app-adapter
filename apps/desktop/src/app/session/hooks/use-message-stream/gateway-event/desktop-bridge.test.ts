import { beforeEach, describe, expect, it, vi } from 'vitest'

<<<<<<< HEAD
const mocks = vi.hoisted(() => {
  const previewSurface = { owned: true }

  return {
    actOnActivePreview: vi.fn(async () => ({ acted: 'elements', success: true })),
    captureActivePreviewSurface: vi.fn(() => ({ generation: 1, ownershipEpoch: 1, tabId: 'url:one' })),
    ownsActivePreviewSurface: vi.fn(() => previewSurface.owned),
    previewSurface,
    readActivePreview: vi.fn(async () => ({ text: 'foreground preview' })),
    readActiveTerminal: vi.fn(() => ({ text: 'foreground terminal' })),
    recordAgentReaction: vi.fn(),
    revealDesktopPane: vi.fn(),
    requestGatewayForAgent: vi.fn(async () => ({})),
    runTour: vi.fn(async () => ({ success: true })),
    setMessages: vi.fn(),
    showTip: vi.fn(),
    tipsEnabled: vi.fn(() => true),
    toursEnabled: vi.fn(() => true)
  }
})

vi.mock('@/app/chat/right-rail/preview-act', () => ({ actOnActivePreview: mocks.actOnActivePreview }))
vi.mock('@/app/chat/right-rail/preview-reader', () => ({ readActivePreview: mocks.readActivePreview }))
vi.mock('@/app/right-sidebar/terminal/agent-terminal-stream', () => ({ writeAgentTerminalChunk: vi.fn() }))
vi.mock('@/app/right-sidebar/terminal/buffer', () => ({ readActiveTerminal: mocks.readActiveTerminal }))
vi.mock('@/app/right-sidebar/terminal/terminals', () => ({ closeAgentTerminalByProc: vi.fn() }))
vi.mock('@/lib/tour', () => ({ runTour: mocks.runTour }))
vi.mock('@/store/gateway', () => ({ requestGatewayForAgent: mocks.requestGatewayForAgent }))
vi.mock('@/store/pane-focus', () => ({ applyDesktopLayoutPreset: vi.fn(), revealDesktopPane: mocks.revealDesktopPane }))
vi.mock('@/store/preview', () => ({
  captureActivePreviewSurface: mocks.captureActivePreviewSurface,
  ownsActivePreviewSurface: mocks.ownsActivePreviewSurface
}))
vi.mock('@/store/reactions-local', () => ({ recordAgentReaction: mocks.recordAgentReaction }))
vi.mock('@/store/session', () => ({ setMessages: mocks.setMessages }))
vi.mock('@/store/tips', () => ({ $tipsEnabled: { get: mocks.tipsEnabled }, showTip: mocks.showTip }))
vi.mock('@/store/tours', () => ({ $toursEnabled: { get: mocks.toursEnabled } }))
||||||| 939e45c91d
import { $gateway } from '@/store/gateway'
import { $toursEnabled } from '@/store/tours'
=======
import { $activeTip, $retiredTips, $tipsEnabled, dismissTip, resetTips, retireActiveTip } from '@/store/tips'
>>>>>>> f97608f178

import { handleDesktopBridgeEvent } from './desktop-bridge'
import type { GatewayEventContext } from './types'

<<<<<<< HEAD
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
||||||| 939e45c91d
function previewActContext({
  explicitSid,
  isActiveEvent
}: {
  explicitSid: string
  isActiveEvent: boolean
}): GatewayEventContext {
  return {
    event: { session_id: explicitSid || undefined, type: 'preview.act.request' },
    explicitSid,
    isActiveEvent,
    payload: { action: 'elements', request_id: 'request-1' }
  } as GatewayEventContext
}
=======
vi.mock('@/app/right-sidebar/terminal/agent-terminal-stream', () => ({ writeAgentTerminalChunk: vi.fn() }))
vi.mock('@/app/right-sidebar/terminal/terminals', () => ({ closeAgentTerminalByProc: vi.fn() }))
vi.mock('@/store/pane-focus', () => ({ applyDesktopLayoutPreset: vi.fn(), revealDesktopPane: vi.fn() }))
vi.mock('@/store/reactions-local', () => ({ recordAgentReaction: vi.fn() }))
vi.mock('@/store/session', () => ({ setMessages: vi.fn() }))
>>>>>>> f97608f178

<<<<<<< HEAD
function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })
||||||| 939e45c91d
describe('preview action bridge routing', () => {
  afterEach(() => {
    $gateway.set(null)
  })
=======
const tipShow = (text: string): GatewayEventContext =>
  ({
    event: { type: 'tip.show' },
    isActiveEvent: true,
    payload: { selector: '[data-tour="model-pill"]', text }
  }) as unknown as GatewayEventContext
>>>>>>> f97608f178

<<<<<<< HEAD
  return { promise, resolve }
}

describe('desktop bridge source and foreground isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.previewSurface.owned = true
    mocks.tipsEnabled.mockReturnValue(true)
    mocks.toursEnabled.mockReturnValue(true)
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
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith('source-b', 'background-profile', 'window.read.respond', {
      request_id: 'request-1',
      text: ''
    })
  })
||||||| 939e45c91d
  it('leaves a scoped action request unanswered in a window showing another session', () => {
    const request = vi.fn()
    $gateway.set({ request } as never)

    expect(handleDesktopBridgeEvent(previewActContext({ explicitSid: 'session-a', isActiveEvent: false }))).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps the legacy fail-fast response for an unscoped inactive request', () => {
    const request = vi.fn()
    $gateway.set({ request } as never)

    expect(handleDesktopBridgeEvent(previewActContext({ explicitSid: '', isActiveEvent: false }))).toBe(true)
    expect(request).toHaveBeenCalledWith('preview.act.respond', {
      request_id: 'request-1',
      text: JSON.stringify({
        error: 'The in-app browser only takes actions in the session the user is looking at.',
        success: false
      })
    })
  })
})
=======
beforeEach(() => {
  dismissTip()
  resetTips()
  $tipsEnabled.set(true)
})
>>>>>>> f97608f178

<<<<<<< HEAD
  it('discards a native window read when its session loses the foreground while IPC is pending', async () => {
    const pending = deferred<{ frontmost: null; platform: string; window: null }>()
    const readWindowBelow = vi.fn(() => pending.promise)
    window.hermesDesktop = { ...window.hermesDesktop, readWindowBelow } as typeof window.hermesDesktop
    const ctx = context('window.read.request', true)
||||||| 939e45c91d
function tourContext({
  explicitSid,
  isActiveEvent
}: {
  explicitSid: string
  isActiveEvent: boolean
}): GatewayEventContext {
  return {
    event: { session_id: explicitSid || undefined, type: 'tour.request' },
    explicitSid,
    isActiveEvent,
    payload: { action: 'discover', request_id: 'tour-request-1' }
  } as GatewayEventContext
}
=======
describe('tip.show bridge (#117216)', () => {
  it('a ✕-closed agent tip does not come back on the next tip.show of the same content', () => {
    handleDesktopBridgeEvent(tipShow('Choose a model here.'))
    const tipId = $activeTip.get()?.tipId
>>>>>>> f97608f178

<<<<<<< HEAD
    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    expect(readWindowBelow).toHaveBeenCalledOnce()
||||||| 939e45c91d
describe('tour bridge routing', () => {
  afterEach(() => {
    $gateway.set(null)
    $toursEnabled.set(true)
  })
=======
    expect(tipId).toMatch(/^agent:/)
>>>>>>> f97608f178

<<<<<<< HEAD
    ctx.deps.activeSessionIdRef.current = 'new-foreground-session'
    pending.resolve({ frontmost: null, platform: 'darwin', window: null })
||||||| 939e45c91d
  it('leaves a scoped request unanswered in another session even when tours are disabled', () => {
    const request = vi.fn()
    $gateway.set({ request } as never)
    $toursEnabled.set(false)
=======
    retireActiveTip()
    expect($retiredTips.get()).toContain(tipId)
>>>>>>> f97608f178

<<<<<<< HEAD
    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith('source-b', 'background-profile', 'window.read.respond', {
      request_id: 'request-1',
      text: ''
    })
||||||| 939e45c91d
    expect(handleDesktopBridgeEvent(tourContext({ explicitSid: 'session-a', isActiveEvent: false }))).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps the legacy fail-fast response for an unscoped inactive request', () => {
    const request = vi.fn()
    $gateway.set({ request } as never)

    expect(handleDesktopBridgeEvent(tourContext({ explicitSid: '', isActiveEvent: false }))).toBe(true)
    expect(request).toHaveBeenCalledWith('tour.respond', {
      request_id: 'tour-request-1',
      text: JSON.stringify({
        error: 'Tours only run in the session the user is looking at.',
        success: false
      })
    })
=======
    handleDesktopBridgeEvent(tipShow('Choose a model here.'))
    expect($activeTip.get()).toBeNull()

    // Different content is a different tip and still shows.
    handleDesktopBridgeEvent(tipShow('Attach files with the paperclip.'))
    expect($activeTip.get()?.text).toBe('Attach files with the paperclip.')
>>>>>>> f97608f178
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

  it('does not paint a preview tour after its active tab changes during lazy loading', async () => {
    const ctx = context('tour.request', true)
    ctx.payload = { request_id: 'request-1', surface: 'preview' } as GatewayEventContext['payload']

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    mocks.previewSurface.owned = false

    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())
    expect(mocks.captureActivePreviewSurface).toHaveBeenCalledOnce()
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

  it('renders a protocol-3 tip only for the active session owner', () => {
    const ctx = context('tip.show', true)
    ctx.payload = { selector: '#preview', text: 'Public preview' } as GatewayEventContext['payload']

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    expect(mocks.showTip).toHaveBeenCalledExactlyOnceWith({
      side: 'top',
      targets: ['#preview'],
      text: 'Public preview',
      title: undefined
    })
    expect(mocks.requestGatewayForAgent).not.toHaveBeenCalled()
  })

  it.each([
    [false, false],
    [true, false]
  ])('does not paint a tip from an inactive owner (%s, %s)', (active, source) => {
    const ctx = context('tip.show', active, source)
    ctx.payload = { selector: '#preview', text: 'Public preview' } as GatewayEventContext['payload']

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    expect(mocks.showTip).not.toHaveBeenCalled()
  })

  it('respects disabled tips without emitting a response', () => {
    mocks.tipsEnabled.mockReturnValue(false)
    const ctx = context('tip.show', true)
    ctx.payload = { selector: '#preview', text: 'Public preview' } as GatewayEventContext['payload']

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    expect(mocks.showTip).not.toHaveBeenCalled()
    expect(mocks.requestGatewayForAgent).not.toHaveBeenCalled()
  })

  it('leaves a scoped preview action unanswered in a window showing another session', () => {
    expect(handleDesktopBridgeEvent(context('preview.act.request', false))).toBe(true)
    expect(mocks.requestGatewayForAgent).not.toHaveBeenCalled()
  })

  it('keeps the fail-fast response for an unscoped inactive preview action', async () => {
    const ctx = context('preview.act.request', false)
    ctx.explicitSid = ''

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith(
      'source-b',
      'background-profile',
      'preview.act.respond',
      expect.objectContaining({ request_id: 'request-1', text: expect.stringContaining('session') })
    )
  })

  it('leaves a scoped tour unanswered in another session even when tours are disabled', () => {
    mocks.toursEnabled.mockReturnValue(false)
    expect(handleDesktopBridgeEvent(context('tour.request', false))).toBe(true)
    expect(mocks.requestGatewayForAgent).not.toHaveBeenCalled()
  })

  it('keeps the fail-fast response for an unscoped inactive tour', async () => {
    const ctx = context('tour.request', false)
    ctx.explicitSid = ''

    expect(handleDesktopBridgeEvent(ctx)).toBe(true)
    await vi.waitFor(() => expect(mocks.requestGatewayForAgent).toHaveBeenCalledOnce())
    expect(mocks.requestGatewayForAgent).toHaveBeenCalledWith(
      'source-b',
      'background-profile',
      'tour.respond',
      expect.objectContaining({ request_id: 'request-1', text: expect.stringContaining('session') })
    )
  })
})

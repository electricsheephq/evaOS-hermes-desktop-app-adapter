import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyDesktopLayoutPreset, revealDesktopPane } from '@/store/pane-focus'
import { setMessages } from '@/store/session'
import { $activeTip, $retiredTips, $tipsEnabled, dismissTip, resetTips, retireActiveTip } from '@/store/tips'

import { handleDesktopBridgeEvent } from './desktop-bridge'
import type { GatewayEventContext } from './types'

vi.mock('@/app/right-sidebar/terminal/agent-terminal-stream', () => ({ writeAgentTerminalChunk: vi.fn() }))
vi.mock('@/app/right-sidebar/terminal/terminals', () => ({ closeAgentTerminalByProc: vi.fn() }))
vi.mock('@/store/pane-focus', () => ({ applyDesktopLayoutPreset: vi.fn(), revealDesktopPane: vi.fn() }))
vi.mock('@/store/reactions-local', () => ({ recordAgentReaction: vi.fn() }))
vi.mock('@/store/session', () => ({ setMessages: vi.fn() }))

// The bridge only paints for the routed session the user is looking at, and
// only when the event came from that session's own (connection, profile).
function context(
  type: string,
  { activeSession = true, activeSource = true }: { activeSession?: boolean; activeSource?: boolean } = {},
  payload: Record<string, unknown> = {}
): GatewayEventContext {
  return {
    deps: {
      activeGatewayProfile: 'active-profile',
      activeSessionIdRef: { current: activeSession ? 'runtime-session' : 'other-session' }
    },
    event: { connectionId: 'source-b', profile: 'background-profile', session_id: 'runtime-session', type },
    explicitSid: 'runtime-session',
    fromActiveSource: () => activeSource,
    isActiveEvent: activeSession,
    occurredAt: 0,
    payload,
    sessionId: 'runtime-session'
  } as unknown as GatewayEventContext
}

const tipShow = (text: string): GatewayEventContext =>
  context('tip.show', {}, { selector: '[data-tour="model-pill"]', text })

beforeEach(() => {
  vi.clearAllMocks()
  dismissTip()
  resetTips()
  $tipsEnabled.set(true)
})

describe('tip.show bridge (#117216)', () => {
  it('a ✕-closed agent tip does not come back on the next tip.show of the same content', () => {
    handleDesktopBridgeEvent(tipShow('Choose a model here.'))
    const tipId = $activeTip.get()?.tipId

    expect(tipId).toMatch(/^agent:/)

    retireActiveTip()
    expect($retiredTips.get()).toContain(tipId)

    handleDesktopBridgeEvent(tipShow('Choose a model here.'))
    expect($activeTip.get()).toBeNull()

    // Different content is a different tip and still shows.
    handleDesktopBridgeEvent(tipShow('Attach files with the paperclip.'))
    expect($activeTip.get()?.text).toBe('Attach files with the paperclip.')
  })
})

describe('desktop bridge source and foreground isolation', () => {
  it('lets the foreground session from its own source drive the visible surface', () => {
    expect(handleDesktopBridgeEvent(context('pane.reveal', {}, { pane: 'preview' }))).toBe(true)
    expect(handleDesktopBridgeEvent(context('layout.apply', {}, { preset: 'focus' }))).toBe(true)

    expect(revealDesktopPane).toHaveBeenCalledWith('preview')
    expect(applyDesktopLayoutPreset).toHaveBeenCalledWith('focus')
  })

  it('denies a same-session-id event from a different source access to the foreground surface', () => {
    const otherSource = { activeSource: false }

    expect(handleDesktopBridgeEvent(context('pane.reveal', otherSource, { pane: 'preview' }))).toBe(true)
    expect(handleDesktopBridgeEvent(context('layout.apply', otherSource, { preset: 'focus' }))).toBe(true)
    expect(
      handleDesktopBridgeEvent(context('tip.show', otherSource, { selector: '[data-tour="model-pill"]', text: 'Hi' }))
    ).toBe(true)
    expect(
      handleDesktopBridgeEvent(context('message.reaction', otherSource, { reactions: ['+1'], role: 'user', row_id: 7 }))
    ).toBe(true)

    expect(revealDesktopPane).not.toHaveBeenCalled()
    expect(applyDesktopLayoutPreset).not.toHaveBeenCalled()
    expect($activeTip.get()).toBeNull()
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('keeps a background session from moving the user focus', () => {
    expect(handleDesktopBridgeEvent(context('pane.reveal', { activeSession: false }, { pane: 'preview' }))).toBe(true)

    expect(revealDesktopPane).not.toHaveBeenCalled()
  })
})

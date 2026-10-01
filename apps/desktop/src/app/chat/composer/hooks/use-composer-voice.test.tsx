import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setActiveSessionId, setIntroSeed } from '@/store/session'

import type { ChatBarProps } from '../types'

import { useComposerVoice } from './use-composer-voice'

const mocks = vi.hoisted(() => ({
  conversation: {
    end: vi.fn(async () => undefined),
    level: 0,
    muted: false,
    start: vi.fn(async () => undefined),
    status: 'idle' as const,
    stopTurn: vi.fn(),
    toggleMute: vi.fn()
  },
  conversationArgs: null as null | { onSubmit: (text: string) => Promise<void> | void }
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      assistant: { thread: { readAloudFailed: '' } },
      notifications: { voice: { sayStopToEnd: (phrase: string) => phrase } },
      settings: { config: { autosaveFailed: '' } }
    }
  })
}))

vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }))
vi.mock('@/lib/spoken-reply', () => ({
  adoptSpokenReplySession: vi.fn(),
  markAssistantIdSpoken: vi.fn(),
  resolveSpokenReply: vi.fn(() => null)
}))
vi.mock('@/lib/tts-lease', () => ({
  CONVERSATION_LEASE: 'conversation',
  READ_ALOUD_LEASE: 'read-aloud',
  syncTtsLease: vi.fn(async () => undefined)
}))
vi.mock('@/lib/wake-indicator', () => ({
  clearWakeIndicator: vi.fn(),
  syncWakeIndicatorWithVoice: vi.fn(() => false)
}))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/wake-word', () => ({ resumeWakeAfterVoice: vi.fn(async () => undefined) }))
vi.mock('./use-auto-speak-replies', () => ({ useAutoSpeakReplies: vi.fn() }))
vi.mock('./use-voice-conversation', () => ({
  useVoiceConversation: (args: { onSubmit: (text: string) => Promise<void> | void }) => {
    mocks.conversationArgs = args

    return mocks.conversation
  }
}))
vi.mock('./use-voice-recorder', () => ({
  useVoiceRecorder: () => ({ dictate: {}, voiceActivityState: 'idle', voiceStatus: 'idle' })
}))

const baseProps = {
  busy: false,
  clearDraft: vi.fn(),
  disabled: false,
  focusInput: vi.fn(),
  insertText: vi.fn(),
  maxRecordingSeconds: 30,
  onTranscribeAudio: vi.fn(async () => 'hello'),
  target: 'main' as const
}

function renderVoice(sessionId: string | null, onSubmit: ChatBarProps['onSubmit']) {
  return renderHook(
    ({ currentSessionId }) =>
      useComposerVoice({
        ...baseProps,
        onSubmit,
        sessionId: currentSessionId
      }),
    { initialProps: { currentSessionId: sessionId } }
  )
}

describe('useComposerVoice session ownership', () => {
  afterEach(() => {
    cleanup()
    setActiveSessionId(null)
    setIntroSeed(0)
    mocks.conversationArgs = null
    vi.clearAllMocks()
  })

  it('drops a pending draft utterance after the main composer opens an existing session', async () => {
    const onSubmit = vi.fn(async () => true)
    const hook = renderVoice(null, onSubmit)

    act(() => hook.result.current.startConversation())
    const pendingSubmit = mocks.conversationArgs!.onSubmit

    act(() => setActiveSessionId('runtime-existing'))
    hook.rerender({ currentSessionId: 'runtime-existing' })

    await waitFor(() => expect(hook.result.current.voiceConversationActive).toBe(false))
    await act(async () => pendingSubmit('draft audio'))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(mocks.conversation.end).toHaveBeenCalled()
  })

  it('drops pending audio when a new draft replaces another null-runtime draft', async () => {
    const onSubmit = vi.fn(async () => true)
    const hook = renderVoice(null, onSubmit)

    act(() => hook.result.current.startConversation())
    const pendingSubmit = mocks.conversationArgs!.onSubmit

    act(() => setIntroSeed(seed => seed + 1))
    await act(async () => pendingSubmit('old draft audio'))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(hook.result.current.voiceConversationActive).toBe(false)
    expect(mocks.conversation.end).toHaveBeenCalled()
  })

  it('keeps its own first created session active without letting a late callback claim a later switch', async () => {
    let createdCallback: ((runtimeSessionId: string) => void) | undefined

    const onSubmit = vi.fn<ChatBarProps['onSubmit']>(async (_text, options) => {
      createdCallback = options?.onRuntimeSessionCreated
      createdCallback?.('runtime-created')
      setActiveSessionId('runtime-created')

      return true
    })

    const hook = renderVoice(null, onSubmit)

    act(() => hook.result.current.startConversation())
    await act(async () => mocks.conversationArgs!.onSubmit('first voice turn'))
    hook.rerender({ currentSessionId: 'runtime-created' })

    expect(hook.result.current.voiceConversationActive).toBe(true)

    act(() => hook.result.current.endConversation())
    act(() => hook.result.current.startConversation())
    createdCallback?.('runtime-late')
    act(() => setActiveSessionId('runtime-late'))
    hook.rerender({ currentSessionId: 'runtime-late' })

    await waitFor(() => expect(hook.result.current.voiceConversationActive).toBe(false))
  })
})

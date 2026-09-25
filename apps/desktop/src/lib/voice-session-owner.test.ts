import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { assertVoiceOwnerAvailable, ownerScoped } from '@/api/client'
import { setApiRequestConnection, setApiRequestProfile, transcribeAudio } from '@/hermes'
import { _resetSessionOwnerHintsForTests, setSessionOwnerHint } from '@/store/session'

import { clearVoiceClientConfigCache, fetchVoiceClientConfig } from './voice-client-direct'
import { resolveSpeakStreamUrl } from './voice-playback'
import { sessionVoiceOwner, sessionVoiceRequestScope, useSessionVoiceOwner } from './voice-session-owner'

afterEach(() => {
  cleanup()
  _resetSessionOwnerHintsForTests()
  clearVoiceClientConfigCache()
  setApiRequestConnection(null)
  setApiRequestProfile(null)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

it.each([
  ['gw-other', 'default'],
  ['gw-active', 'bot']
])('uses stored owner %s/%s while chrome remains active/default', (connectionId, profile) => {
  setApiRequestConnection('gw-active')
  setApiRequestProfile('default')
  setSessionOwnerHint('bot-session', { connectionId, profile, mode: 'remote' })
  expect(ownerScoped(sessionVoiceOwner('bot-session'))).toEqual({ connectionId, priority: 'foreground', profile })
})

it('rejects ambiguous ownership before configuration, credentials or speech routing', async () => {
  for (const connectionId of ['gw-one', 'gw-two']) {
    setSessionOwnerHint('same-id', { connectionId, profile: 'default', mode: 'remote' })
  }

  const api = vi.fn()
  const getConnection = vi.fn()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api, getConnection } })
  const owner = sessionVoiceOwner('same-id')
  expect(() => assertVoiceOwnerAvailable(owner)).toThrow(/owner could not be resolved/)
  expect(() => ownerScoped(owner)).toThrow(/owner could not be resolved/)
  await expect(fetchVoiceClientConfig(owner)).rejects.toThrow(/owner could not be resolved/)
  await expect(resolveSpeakStreamUrl(owner)).rejects.toThrow(/owner could not be resolved/)
  expect(api).not.toHaveBeenCalled()
  expect(getConnection).not.toHaveBeenCalled()
})

it('captures the fresh draft route for both configuration and relay transcription', async () => {
  setApiRequestConnection('gw-secondary')
  setApiRequestProfile('research')
  const api = vi.fn(async () => ({ ok: false }))
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api } })
  const scope = sessionVoiceRequestScope(null)
  await fetchVoiceClientConfig(scope)
  await transcribeAudio('data:audio/wav;base64,AA==', 'audio/wav', scope)
  expect(api).toHaveBeenCalledTimes(2)

  for (const [request] of api.mock.calls as unknown as [{ connectionId: string; profile: string }][]) {
    expect(request).toMatchObject({ connectionId: 'gw-secondary', profile: 'research' })
  }
})

it('reacts to a late owner hint and ambiguity without an unrelated render', () => {
  const hook = renderHook(() => useSessionVoiceOwner('late-bot'))
  expect(hook.result.current).toEqual({})
  act(() => setSessionOwnerHint('late-bot', { connectionId: 'gw-one', profile: 'bot', mode: 'remote' }))
  expect(hook.result.current).toEqual({ connectionId: 'gw-one', profile: 'bot' })
  act(() => setSessionOwnerHint('late-bot', { connectionId: 'gw-two', profile: 'bot', mode: 'remote' }))
  expect(hook.result.current).toEqual({ voiceOwnerUnavailable: true })
})

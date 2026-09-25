import { afterEach, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile, transcribeAudio } from '@/hermes'
import { transcribeAudioClientDirect } from '@/lib/voice-client-direct'
import { notifyVoiceFallback } from '@/lib/voice-fallback-notice'

import { tileTranscribeAudio, tileVoiceOwner } from './session-tile'

vi.mock('@/lib/voice-client-direct', () => ({ transcribeAudioClientDirect: vi.fn(async () => null) }))
vi.mock('@/lib/voice-fallback-notice', () => ({ notifyVoiceFallback: vi.fn() }))
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<object>()),
  transcribeAudio: vi.fn(async () => ({ transcript: 'fixture', fallback_active: true, fallback_reason: 'quota' }))
}))
afterEach(() => {
  vi.clearAllMocks()
  setApiRequestConnection(null)
  setApiRequestProfile(null)
})
it('keeps both recognition paths on the tile owner and localizes fallback', async () => {
  const owner = { connectionId: 'secondary', profile: 'default' }
  const audio = new Blob(['fixture'], { type: 'audio/webm' })
  expect(await tileTranscribeAudio(audio, owner)).toBe('fixture')
  expect(transcribeAudioClientDirect).toHaveBeenCalledWith(audio, { ...owner, priority: 'foreground' })
  expect(transcribeAudio).toHaveBeenCalledWith(expect.stringContaining('data:'), 'audio/webm', {
    ...owner,
    priority: 'foreground'
  })
  expect(notifyVoiceFallback).toHaveBeenCalledWith('quota')
})
it('discards stale direct results before calling the relay', async () => {
  await expect(
    tileTranscribeAudio(new Blob(['fixture']), { connectionId: 'secondary', profile: 'default' }, () => {
      throw new DOMException('changed', 'AbortError')
    })
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(transcribeAudio).not.toHaveBeenCalled()
  expect(notifyVoiceFallback).not.toHaveBeenCalled()
})

it('captures the ambient gateway and profile for an untagged legacy tile', async () => {
  setApiRequestConnection('secondary')
  setApiRequestProfile('research')
  const audio = new Blob(['fixture'], { type: 'audio/webm' })
  await tileTranscribeAudio(audio, {})
  const scope = { connectionId: 'secondary', profile: 'research' }
  expect(transcribeAudioClientDirect).toHaveBeenCalledWith(audio, scope)
  expect(transcribeAudio).toHaveBeenCalledWith(expect.any(String), 'audio/webm', scope)
})

it('rejects ambiguous inferred tile ownership before either transcription provider', async () => {
  setApiRequestConnection('ambient')
  setApiRequestProfile('default')
  const owner = tileVoiceOwner(undefined, { voiceOwnerUnavailable: true }, undefined)
  await expect(tileTranscribeAudio(new Blob(['fixture']), owner)).rejects.toThrow()
  expect(transcribeAudioClientDirect).not.toHaveBeenCalled()
  expect(transcribeAudio).not.toHaveBeenCalled()
})

it('retains an explicit tile route when the stored ID exists on multiple gateways', async () => {
  const owner = tileVoiceOwner(
    { connectionId: 'secondary', profile: 'default' },
    { voiceOwnerUnavailable: true },
    { connectionId: 'ambient', profile: 'default' }
  )

  await tileTranscribeAudio(new Blob(['fixture']), owner)
  expect(transcribeAudioClientDirect).toHaveBeenCalledWith(expect.any(Blob), {
    connectionId: 'secondary',
    priority: 'foreground',
    profile: 'default'
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'
import { setRuntimeI18nLocale } from '@/i18n/runtime'
import { notify } from '@/store/notifications'

import { notifyVoiceFallback } from './voice-fallback-notice'

vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))

afterEach(() => {
  setRuntimeI18nLocale('en')
  vi.clearAllMocks()
})

describe('localized voice fallback notices', () => {
  it('renders credential and billing categories in English', () => {
    notifyVoiceFallback('credential')
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: TRANSLATIONS.en.notifications.voice.fallbackCredential })
    )
    notifyVoiceFallback('quota')
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: TRANSLATIONS.en.notifications.voice.fallbackQuota })
    )
  })
  it('uses Japanese and never displays an unrecognized provider diagnostic', () => {
    setRuntimeI18nLocale('ja')
    notifyVoiceFallback('availability')
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: TRANSLATIONS.ja.notifications.voice.fallbackAvailability })
    )
    notifyVoiceFallback('untrusted provider diagnostic')
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: TRANSLATIONS.ja.notifications.voice.fallbackGeneric })
    )
  })
  it('has explicit nonempty notices in every supported locale', () => {
    for (const copy of Object.values(TRANSLATIONS)) {
      for (const key of [
        'fallbackTitle',
        'fallbackCredential',
        'fallbackQuota',
        'fallbackAvailability',
        'fallbackGeneric'
      ] as const) {
        expect(copy.notifications.voice[key].trim()).not.toBe('')
      }
    }
  })
})

import { translateNow } from '@/i18n/runtime'
import { notify } from '@/store/notifications'

/** Only allowlisted reason categories cross into UI copy, never provider text. */
export function notifyVoiceFallback(reason?: string) {
  const key =
    reason === 'credential'
      ? 'fallbackCredential'
      : reason === 'quota'
        ? 'fallbackQuota'
        : reason === 'availability'
          ? 'fallbackAvailability'
          : 'fallbackGeneric'

  notify({
    kind: 'warning',
    title: translateNow('notifications.voice.fallbackTitle'),
    message: translateNow(`notifications.voice.${key}`)
  })
}

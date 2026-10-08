import { atom } from 'nanostores'

import type { EvaManagedStatus } from '@/global'

// Open/closed state of the in-app support target picker (sc#540). Renderer-
// owned presentation state: the banner's Switch button and the native menu's
// push both flip it; the picker owns everything else about its session.
export const $supportPickerOpen = atom(false)

export function setSupportPickerOpen(open: boolean) {
  $supportPickerOpen.set(open)
}

export const $evaManagedStatus = atom<EvaManagedStatus | null>(null)
export const activeSupportSession = (status: EvaManagedStatus | null) =>
  status?.delegatedSupportActive && status.supportCustomerLabel && status.supportAgentLabel && status.supportExpiresAt
    ? { agent: status.supportAgentLabel, customer: status.supportCustomerLabel, expiresAt: status.supportExpiresAt }
    : null

export function formatSupportRemaining(expiresAt: string, now = Date.now()): string {
  const seconds = Math.ceil(Math.max(0, Date.parse(expiresAt) - now) / 1_000)

  return [Math.floor(seconds / 3_600), Math.floor((seconds % 3_600) / 60), seconds % 60]
    .map(value => String(value).padStart(2, '0'))
    .join(':')
}

export async function refreshEvaManagedStatus() {
  const status = await window.hermesDesktop?.eva?.status?.()

  if (status) {
    const current = $evaManagedStatus.get()

    const unchanged =
      current !== null &&
      Object.keys(status).length === Object.keys(current).length &&
      Object.entries(status).every(([key, value]) => Object.is(current[key as keyof EvaManagedStatus], value))

    if (!unchanged || activeSupportSession(status)) {
      $evaManagedStatus.set({ ...status })
    }
  }

  return status ?? null
}

export async function runSupportSessionAction(action: 'end' | 'switch') {
  if (action === 'switch') {
    const status = await window.hermesDesktop.eva.switchSupportTarget()
    $evaManagedStatus.set({ ...status })
    setSupportPickerOpen(true)

    return status
  }

  const ended = await window.hermesDesktop.eva.endSupportSession()

  return ended.ok ? refreshEvaManagedStatus().catch(() => $evaManagedStatus.get()) : Promise.reject(new Error())
}

let lastProfileScopeKey: null | string = null

$evaManagedStatus.listen(status => {
  const nextProfileScopeKey = status?.profileScopeKey || null

  if (!nextProfileScopeKey) {
    lastProfileScopeKey = null

    return
  }

  const previousProfileScopeKey = lastProfileScopeKey
  lastProfileScopeKey = nextProfileScopeKey

  if (previousProfileScopeKey === null || previousProfileScopeKey === nextProfileScopeKey) {
    return
  }

  void import('@/store/profile')
    .then(async ({ refreshActiveProfile, refreshProfiles }) => {
      await refreshActiveProfile()
      await refreshProfiles()
    })
    .catch(() => undefined)
})

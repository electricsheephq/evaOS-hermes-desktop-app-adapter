import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import {
  $evaManagedStatus,
  activeSupportSession,
  refreshEvaManagedStatus,
  runSupportSessionAction
} from '@/store/support-picker'

import { TITLEBAR_HEIGHT } from '../app/shell/titlebar'

import { Button } from './ui/button'

export function DelegatedSupportBanner() {
  const { t } = useI18n()
  const status = useStore($evaManagedStatus)
  const [ending, setEnding] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [switchFailed, setSwitchFailed] = useState(false)

  const refresh = useCallback(() => {
    void refreshEvaManagedStatus().catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 1_000)

    return () => window.clearInterval(timer)
  }, [refresh])

  const supportActive = Boolean(activeSupportSession(status))

  // A lease this app still holds a handle for but no longer an enrollment (a
  // start that failed after the server activated it, a sign-out or credential
  // expiry whose remote end never landed): End must stay reachable for it.
  const cleanupPending = Boolean(status?.supportCleanupPending) && !supportActive
  const noPersonalAgent = Boolean(status?.missingAgentBinding) && !supportActive && !cleanupPending

  const switchTarget = async () => {
    if (switching) {
      return
    }

    setSwitching(true)
    setSwitchFailed(false)

    try {
      // Resolves at once on a live desktop session; otherwise only after the
      // plain browser sign-in lands. The picker itself is an app surface now.
      await runSupportSessionAction('switch')
    } catch {
      // The main process already logged the bounded broker code; the operator
      // only needs to know the browser handoff did not start.
      setSwitchFailed(true)
    } finally {
      setSwitching(false)
      refresh()
    }
  }

  const switchButton = (
    <Button
      disabled={switching || ending}
      onClick={() => void switchTarget()}
      size="sm"
      type="button"
      variant="outline"
    >
      {switching ? t.delegatedSupport.switchingTarget : t.delegatedSupport.switchTarget}
    </Button>
  )

  const endSession = async () => {
    if (ending) {
      return
    }

    setEnding(true)

    try {
      await runSupportSessionAction('end')
    } catch {
      refresh()
    } finally {
      setEnding(false)
    }
  }

  const endButton = (
    <Button
      disabled={ending || switching}
      onClick={() => void endSession()}
      size="sm"
      type="button"
      variant="destructive"
    >
      {ending ? t.delegatedSupport.endingSession : t.delegatedSupport.endSession}
    </Button>
  )

  if (cleanupPending && status) {
    return (
      <div
        aria-label={t.delegatedSupport.cleanupPending}
        className="fixed inset-x-0 z-(--z-support-session) flex min-h-10 items-center justify-center gap-3 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-4 py-2 text-sm text-(--ui-text-primary)"
        role="region"
        style={{ top: TITLEBAR_HEIGHT }}
      >
        <span aria-live="polite" className="sr-only" role="status">
          {t.delegatedSupport.cleanupPending}
        </span>
        <span className="font-medium">{t.delegatedSupport.cleanupPending}</span>
        {status.supportTargetLabel && <span className="text-(--ui-text-secondary)">{status.supportTargetLabel}</span>}
        {status.supportEndFailed && <span role="status">{t.delegatedSupport.endFailed}</span>}
        {switchFailed && <span role="status">{t.delegatedSupport.switchTargetFailed}</span>}
        {switchButton}
        {endButton}
      </div>
    )
  }

  if (noPersonalAgent) {
    return (
      <div
        aria-label={t.delegatedSupport.noPersonalAgent}
        className="fixed inset-x-0 z-(--z-support-session) flex min-h-10 items-center justify-center gap-3 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-4 py-2 text-sm text-(--ui-text-primary)"
        role="region"
        style={{ top: TITLEBAR_HEIGHT }}
      >
        <span aria-live="polite" className="sr-only" role="status">
          {t.delegatedSupport.noPersonalAgent}
        </span>
        <span className="font-medium">{t.delegatedSupport.noPersonalAgent}</span>
        <span className="text-(--ui-text-secondary)">{t.delegatedSupport.noPersonalAgentHint}</span>
        {switchFailed && <span role="status">{t.delegatedSupport.switchTargetFailed}</span>}
        {switchButton}
      </div>
    )
  }

  return null
}

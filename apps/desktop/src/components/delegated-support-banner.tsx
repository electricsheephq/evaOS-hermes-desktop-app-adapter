import { useCallback, useEffect, useState } from 'react'

import type { EvaManagedStatus } from '@/global'
import { useI18n } from '@/i18n'

import { TITLEBAR_HEIGHT } from '../app/shell/titlebar'

import { Button } from './ui/button'

function formatRemaining(expiresAt: string | null | undefined): string {
  const parsedExpiry = Date.parse(String(expiresAt || ''))
  const remainingMs = Number.isFinite(parsedExpiry) ? Math.max(0, parsedExpiry - Date.now()) : 0
  const totalSeconds = Math.ceil(remainingMs / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}`
}

export function DelegatedSupportBanner() {
  const { t } = useI18n()
  const [status, setStatus] = useState<EvaManagedStatus | null>(null)
  const [ending, setEnding] = useState(false)

  const refresh = useCallback(() => {
    const readStatus = window.hermesDesktop?.eva?.status

    if (!readStatus) {
      return
    }

    void readStatus()
      .then(setStatus)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 1_000)

    return () => window.clearInterval(timer)
  }, [refresh])

  if (
    !status?.delegatedSupportActive ||
    !status.supportExpiresAt ||
    !status.supportCustomerLabel ||
    !status.supportAgentLabel
  ) {
    return null
  }

  const endSession = async () => {
    if (ending) {
      return
    }

    setEnding(true)

    try {
      await window.hermesDesktop.eva.endSupportSession()

      refresh()
    } finally {
      setEnding(false)
    }
  }

  return (
    <div
      aria-label={t.delegatedSupport.actingForCustomer(status.supportCustomerLabel)}
      className="fixed inset-x-0 z-(--z-over-modal) flex min-h-10 items-center justify-center gap-3 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-4 py-2 text-sm text-(--ui-text-primary)"
      role="region"
      style={{ top: TITLEBAR_HEIGHT }}
    >
      <span aria-live="polite" className="sr-only" role="status">
        {t.delegatedSupport.actingForCustomer(status.supportCustomerLabel)}
      </span>
      <span className="font-medium">{t.delegatedSupport.actingForCustomer(status.supportCustomerLabel)}</span>
      <span className="text-(--ui-text-secondary)">{t.delegatedSupport.assignedAgent(status.supportAgentLabel)}</span>
      <span className="tabular-nums text-(--ui-text-secondary)">
        {t.delegatedSupport.endsIn(formatRemaining(status.supportExpiresAt))}
      </span>
      {status.supportEndFailed && <span role="status">{t.delegatedSupport.endFailed}</span>}
      <Button disabled={ending} onClick={() => void endSession()} size="sm" type="button" variant="destructive">
        {ending ? t.delegatedSupport.endingSession : t.delegatedSupport.endSession}
      </Button>
    </div>
  )
}

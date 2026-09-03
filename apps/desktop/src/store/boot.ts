import { atom } from 'nanostores'

import type { DesktopBootProgress } from '@/global'
import { translateNow } from '@/i18n'

export interface DesktopBootState extends DesktopBootProgress {
  visible: boolean
}

const INITIAL_BOOT_STATE: DesktopBootState = {
  error: null,
  fakeMode: false,
  message: translateNow('boot.steps.startingHermesDesktop'),
  phase: 'renderer.init',
  progress: 2,
  running: true,
  timestamp: Date.now(),
  visible: true
}

export const $desktopBoot = atom<DesktopBootState>(INITIAL_BOOT_STATE)

function clampProgress(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(100, Math.round(value)))
}

export function applyDesktopBootProgress(progress: DesktopBootProgress) {
  const current = $desktopBoot.get()

  // A hard renderer failure is terminal for this boot cycle. The main-process
  // operation that lost the deadline cannot be cancelled, so ignore its late
  // non-error progress rather than hiding the recovery overlay. Explicit Retry
  // reloads the renderer and starts a fresh cycle with a fresh store.
  if (current.error && !current.running && !progress.error) {
    return
  }

  const nextProgress = clampProgress(progress.progress)
  const mergedProgress = progress.running ? Math.max(current.progress, nextProgress) : nextProgress

  // Don't let a late progress event (error: null) clobber a previously-set
  // boot failure — failDesktopBoot is terminal for this boot cycle.
  const error = progress.error ?? (current.running ? null : current.error)

  $desktopBoot.set({
    ...current,
    ...progress,
    error,
    progress: mergedProgress,
    visible: progress.running || mergedProgress < 100 || Boolean(error)
  })
}

export function setDesktopBootStep(step: {
  phase: string
  message: string
  progress: number
  running?: boolean
  fakeMode?: boolean
  error?: string | null
}) {
  const current = $desktopBoot.get()
  applyDesktopBootProgress({
    error: step.error ?? null,
    fakeMode: step.fakeMode ?? current.fakeMode,
    message: step.message,
    phase: step.phase,
    progress: step.progress,
    running: step.running ?? true,
    timestamp: Date.now()
  })
}

/**
 * Re-arm the boot overlay for an automatic bounded retry of a failed REMOTE
 * boot (#82679). Unlike setDesktopBootStep — whose null `error` intentionally
 * cannot clear a latched failure — this explicitly lifts the error so the
 * overlay shows the retry status instead of the terminal failure surface
 * while the retry is in flight. failDesktopBoot() re-latches when the
 * bounded retries are exhausted.
 */
export function resumeDesktopBootForRetry(message: string) {
  const current = $desktopBoot.get()
  $desktopBoot.set({
    ...current,
    error: null,
    message,
    phase: 'renderer.boot.retry',
    running: true,
    timestamp: Date.now(),
    visible: true
  })
}

export function completeDesktopBoot(message = translateNow('boot.ready')) {
  const current = $desktopBoot.get()
  $desktopBoot.set({
    ...current,
    error: null,
    message,
    phase: 'renderer.ready',
    progress: 100,
    running: false,
    timestamp: Date.now(),
    visible: false
  })
}

export function failDesktopBoot(message: string) {
  const current = $desktopBoot.get()
  $desktopBoot.set({
    ...current,
    error: message,
    message: translateNow('boot.desktopBootFailedWithMessage', message),
    phase: 'renderer.error',
    progress: clampProgress(current.progress),
    running: false,
    timestamp: Date.now(),
    visible: true
  })
}

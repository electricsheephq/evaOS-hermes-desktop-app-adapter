import { atom } from 'nanostores'

import { getActionStatus, restartGateway } from '@/hermes'
import { translateNow } from '@/i18n'
import { notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import type { ActionResponse } from '@/types/hermes'

const POLL_ATTEMPTS = 18
const POLL_INTERVAL_MS = 1200
const POLL_TIMEOUT_S = 180

// True while a gateway restart is in flight — drives the statusbar gateway
// indicator (glyph spinner) so the restart shows up where users already look,
// instead of a toast that vanishes or a generic "Agents running" counter.
export const $gatewayRestarting = atom(false)

export type GatewayRestartStatus = 'failed' | 'restarted' | 'timed_out'

export interface GatewayRestartResult {
  profile: string
  status: GatewayRestartStatus
}

// Poll a backend action to completion (or a bounded window), throwing on a
// non-zero exit so the caller can surface the failure and preserving timeout
// as an explicit status for inline lifecycle output.
async function awaitAction(started: ActionResponse, profile: string): Promise<Exclude<GatewayRestartStatus, 'failed'>> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await new Promise(resolve => window.setTimeout(resolve, POLL_INTERVAL_MS))
    const status = await getActionStatus(started.name, POLL_TIMEOUT_S, profile)

    if (!status.running) {
      if (status.exit_code != null && status.exit_code !== 0) {
        throw new Error(translateNow('commandCenter.gatewayRestartFailed'))
      }

      return 'restarted'
    }
  }

  return 'timed_out'
}

// Restart the messaging gateway, surfacing progress in the statusbar gateway
// indicator. Self-contained and never rejects, so every trigger — Cmd+K, the
// messaging save/toggle toasts — gets identical feedback from a plain
// `void runGatewayRestart()`. The result keeps the canonical current profile
// available to callers that render an inline lifecycle status.
export async function runGatewayRestart(): Promise<GatewayRestartResult> {
  const profile = normalizeProfileKey($activeGatewayProfile.get())
  $gatewayRestarting.set(true)

  try {
    // Pin both the restart request and every status poll to the profile that
    // was current when the user invoked the action. A profile switch while the
    // asynchronous restart is running must not retarget either half of the
    // operation.
    const started = await restartGateway(profile)

    if (!started.ok) {
      throw new Error(translateNow('commandCenter.gatewayRestartFailed'))
    }

    return { profile, status: await awaitAction(started, profile) }
  } catch (err) {
    notifyError(err, translateNow('commandCenter.gatewayRestartFailed'))

    return { profile, status: 'failed' }
  } finally {
    $gatewayRestarting.set(false)
  }
}

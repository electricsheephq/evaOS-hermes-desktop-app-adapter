import { useStore } from '@nanostores/react'

import { assertVoiceOwnerAvailable, capabilityScoped, type OwnerScope } from '@/api/client'
import { $sessionOwnerHintsSnapshot, getSessionOwnerHints } from '@/store/session'
import type { SessionOwnerRoute } from '@/store/session-request-router'

/** In-place Bot chats retain ambient chrome; only the session identifies their owner. */
export function sessionVoiceOwner(sessionId: null | string): OwnerScope {
  return voiceOwnerFromHints(sessionId ? getSessionOwnerHints(sessionId) : [])
}

function voiceOwnerFromHints(owners: SessionOwnerRoute[]): OwnerScope {
  if (owners.length > 1) {
    return { voiceOwnerUnavailable: true }
  }

  const owner = owners[0]

  return owner ? { connectionId: owner.connectionId, profile: owner.targetProfile || owner.profile } : {}
}

/** Capture ambient routing for a fresh draft, but never for an ambiguous stored owner. */
export function captureVoiceOwnerScope(owner: OwnerScope): OwnerScope {
  assertVoiceOwnerAvailable(owner)

  return capabilityScoped(owner.connectionId || owner.profile ? owner : undefined)
}

export function sessionVoiceRequestScope(sessionId: null | string): OwnerScope {
  return captureVoiceOwnerScope(sessionVoiceOwner(sessionId))
}

export function useSessionVoiceOwner(sessionId: null | string): OwnerScope {
  const hints = useStore($sessionOwnerHintsSnapshot)

  return voiceOwnerFromHints(hints.filter(hint => hint.id === sessionId).map(hint => hint.route))
}

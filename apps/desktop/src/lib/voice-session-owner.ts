import type { OwnerScope } from '@/api/client'
import { getSessionOwnerHints } from '@/store/session'

/** In-place Bot chats retain ambient chrome; only the session identifies their owner. */
export function sessionVoiceOwner(sessionId: null | string): OwnerScope {
  const owners = sessionId ? getSessionOwnerHints(sessionId) : []

  if (owners.length > 1) {return { voiceOwnerUnavailable: true }}
  const owner = owners[0]

  return owner ? { connectionId: owner.connectionId, profile: owner.targetProfile || owner.profile } : {}
}

import { isManagedEvaosAgent } from '@/i18n/managed-brand'
import { $evaManagedStatus } from '@/store/support-picker'

// Must match EVA_MANAGED_ALLOWED_GATEWAY_READS in electron/eva-managed.cjs.
export const MANAGED_ALLOWED_GATEWAY_READS = new Set([
  'billing.charge_status',
  'billing.state',
  'subscription.state',
  'usage.bars'
])
const MANAGED_NOUS_GATEWAY_PREFIXES = ['billing.', 'subscription.']

const MANAGED_HIDDEN_ADVANCED_FIELDS = new Set([
  'toolsets',
  'terminal.backend',
  'terminal.docker_image',
  'terminal.singularity_image',
  'terminal.modal_image',
  'terminal.daytona_image',
  'updates.non_interactive_local_changes'
])

export function isManagedSettingsViewVisible(view: string, managed: boolean): boolean {
  return !managed || view !== 'billing'
}

export function isManagedConfigFieldVisible(key: string, managed: boolean): boolean {
  return !managed || !MANAGED_HIDDEN_ADVANCED_FIELDS.has(key)
}

export function isDisplayToggleWriteAllowed(connectPush: boolean): boolean {
  if (!isManagedEvaosAgent()) {
    return true
  }

  if (connectPush) {
    return false
  }

  const status = $evaManagedStatus.get()

  return status !== null && !status.delegatedSupportActive
}

export function assertManagedGatewayMethodAllowed(method: string, managed: boolean): void {
  if (
    managed &&
    !MANAGED_ALLOWED_GATEWAY_READS.has(method) &&
    MANAGED_NOUS_GATEWAY_PREFIXES.some(prefix => method.startsWith(prefix))
  ) {
    throw new Error('Billing and subscription actions are unavailable in managed evaOS Agent.')
  }
}

import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import {
  assertManagedGatewayMethodAllowed,
  isManagedConfigFieldVisible,
  isManagedSettingsViewVisible
} from './managed-ui-policy'

const { isEvaManagedGatewayMethodBlocked } = createRequire(import.meta.url)('../../electron/eva-managed.cjs') as {
  isEvaManagedGatewayMethodBlocked: (method: string) => boolean
}

describe('managed renderer policy', () => {
  it('removes Billing without narrowing any other Settings destination', () => {
    expect(isManagedSettingsViewVisible('billing', true)).toBe(false)
    expect(isManagedSettingsViewVisible('providers', true)).toBe(true)
    expect(isManagedSettingsViewVisible('gateway', true)).toBe(true)
    expect(isManagedSettingsViewVisible('plugins', true)).toBe(true)
    expect(isManagedSettingsViewVisible('billing', false)).toBe(true)
  })

  it('hides exactly the approved Advanced fields', () => {
    const hidden = [
      'toolsets',
      'terminal.backend',
      'terminal.docker_image',
      'terminal.singularity_image',
      'terminal.modal_image',
      'terminal.daytona_image',
      'updates.non_interactive_local_changes'
    ]

    expect(hidden.every(key => !isManagedConfigFieldVisible(key, true))).toBe(true)
    expect(isManagedConfigFieldVisible('terminal.timeout', true)).toBe(true)
    expect(isManagedConfigFieldVisible('agent.max_turns', true)).toBe(true)
    expect(isManagedConfigFieldVisible('toolsets', false)).toBe(true)
  })

  it('lets Nous billing reads through but rejects spend and plan changes below the managed UI', () => {
    for (const method of [
      'billing.state',
      'billing.charge_status',
      'subscription.state',
      'usage.bars',
      'plugin.billing-helper.run',
      'session.status',
      'usage.snapshot'
    ]) {
      expect(() => assertManagedGatewayMethodAllowed(method, true)).not.toThrow()
      expect(() => assertManagedGatewayMethodAllowed(method, false)).not.toThrow()
    }

    for (const method of [
      'billing.charge',
      'billing.auto_reload',
      'billing.step_up',
      'subscription.change',
      'subscription.resume',
      'subscription.upgrade',
      'subscription.preview',
      'billing.future_method',
      'subscription.future_method'
    ]) {
      expect(() => assertManagedGatewayMethodAllowed(method, true)).toThrow(/unavailable in managed evaOS Agent/)
      expect(() => assertManagedGatewayMethodAllowed(method, false)).not.toThrow()
    }
  })

  it('makes the same allow or block decision as the Electron main-process gate', () => {
    for (const method of [
      'billing.state',
      'billing.charge_status',
      'subscription.state',
      'usage.bars',
      'billing.charge',
      'billing.auto_reload',
      'billing.step_up',
      'subscription.change',
      'subscription.resume',
      'subscription.upgrade',
      'subscription.preview',
      'billing.future_method',
      'subscription.future_method',
      'session.status',
      'usage.snapshot',
      'plugin.billing-helper.run'
    ]) {
      let rendererBlocked = false

      try {
        assertManagedGatewayMethodAllowed(method, true)
      } catch {
        rendererBlocked = true
      }

      expect({ method, blocked: rendererBlocked }).toEqual({
        method,
        blocked: isEvaManagedGatewayMethodBlocked(method)
      })
    }
  })
})

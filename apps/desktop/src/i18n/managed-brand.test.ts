import { describe, expect, it } from 'vitest'

import { en } from './en'
import { createManagedTranslations, sanitizeManagedBrandText } from './managed-brand'

describe('managed evaOS Agent branding', () => {
  it('rebrands visible upstream product and provider names', () => {
    expect(sanitizeManagedBrandText('Start Hermes Desktop with Eva and Nous Portal')).toBe(
      'Start evaOS Agent with evaOS Agent and Electric Sheep account'
    )
  })

  it('rebrands both static and parameterized translation copy', () => {
    const managed = createManagedTranslations(en)

    expect(managed.boot.ready).toBe('evaOS Agent is ready')
    expect(managed.settings.gateway.connectedTo('https://example.invalid', '1.0')).toBe(
      'Connected to https://example.invalid · evaOS Agent 1.0'
    )
  })
})

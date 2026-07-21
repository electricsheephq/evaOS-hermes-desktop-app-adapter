import { describe, expect, it } from 'vitest'

import { en } from './en'
import { createManagedTranslations, sanitizeManagedBrandText } from './managed-brand'

function collectRenderedCopy(value: unknown, copy: string[] = []): string[] {
  if (typeof value === 'string') {
    copy.push(value)
    return copy
  }

  if (typeof value === 'function') {
    copy.push(String(value('Example', '1', '2', '3')))
    return copy
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    Object.values(value).forEach(entry => collectRenderedCopy(entry, copy))
  }

  if (Array.isArray(value)) {
    value.forEach(entry => collectRenderedCopy(entry, copy))
  }

  return copy
}

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

  it('keeps the English customer copy free of upstream product branding', () => {
    const visibleCopy = collectRenderedCopy(en)
    const allowedTechnicalCopy = [
      'Base URL for the remote dashboard backend. Path prefixes are supported, for example /hermes.',
      'Restorable via hermes curator restore.',
      '@hermes:example.org',
      'exit hermes',
      'This adds the “Example” pattern to your permanent allowlist (~/.hermes/config.yaml). evaOS Agent won’t ask again for commands like this — in this session or any future one.',
      'Timed out waiting for the gateway. Is `hermes gateway` running?'
    ]

    expect(visibleCopy.filter(value => /\b(?:Hermes|Nous)\b/i.test(value))).toEqual(allowedTechnicalCopy)
  })
})

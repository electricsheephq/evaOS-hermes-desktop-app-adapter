import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from './catalog'
import { LOCALE_OPTIONS } from './languages'

// The delegated-support banner is the only surface that names the way out of
// the no-personal-agent dead end, so an English fallback there is a support
// operator reading copy they may not understand while the app is unusable.
describe('delegated support locale coverage', () => {
  const english = TRANSLATIONS.en.delegatedSupport

  const render = (copy: typeof english) => ({
    ...copy,
    actingForCustomer: copy.actingForCustomer('Acme'),
    assignedAgent: copy.assignedAgent('eva-1'),
    endsIn: copy.endsIn('00:42:00')
  })

  it('defines every supported locale in the catalog', () => {
    for (const locale of LOCALE_OPTIONS) {
      expect(TRANSLATIONS[locale.id]?.delegatedSupport).toBeDefined()
    }
  })

  it('ships localized support-target and no-personal-agent copy for every supported locale', () => {
    const englishCopy = render(english)

    for (const locale of LOCALE_OPTIONS) {
      const copy = render(TRANSLATIONS[locale.id].delegatedSupport)

      for (const [key, value] of Object.entries(copy)) {
        expect(String(value).trim(), `${locale.id}.${key} is empty`).not.toBe('')

        if (locale.id !== 'en') {
          expect(value, `${locale.id}.${key} falls back to English`).not.toBe(
            englishCopy[key as keyof typeof englishCopy]
          )
        }
      }
    }
  })
})

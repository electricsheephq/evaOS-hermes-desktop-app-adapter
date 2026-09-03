import { describe, expect, it } from 'vitest'

import { formatBlueprintCommand, resolveDeepLinkAction } from './deeplink-routes'

describe('resolveDeepLinkAction', () => {
  it('routes unified plugin install deeplinks', () => {
    expect(
      resolveDeepLinkAction({
        kind: 'plugin',
        name: 'install',
        params: { repo: 'owner/repo', enable: '0', force: '1' }
      })
    ).toEqual({
      type: 'plugin-install',
      repo: 'owner/repo',
      enable: false,
      force: true,
      legacyHint: null
    })
  })

  it('routes legacy plugin-agent alias', () => {
    expect(
      resolveDeepLinkAction({
        kind: 'plugin-agent',
        name: '',
        params: { repo: 'owner/repo' }
      })
    ).toMatchObject({ type: 'plugin-install', legacyHint: 'agent' })
  })

  it('routes blueprint composer inserts', () => {
    expect(
      resolveDeepLinkAction({
        kind: 'blueprint',
        name: 'morning-brief',
        params: { time: '08:00' }
      })
    ).toEqual({
      type: 'composer-blueprint',
      name: 'morning-brief',
      params: { time: '08:00' }
    })
  })

  it('quotes and escapes blueprint values before inserting a composer command', () => {
    expect(formatBlueprintCommand('morning-brief', { value: 'one\\ two"three' })).toBe(
      '/blueprint morning-brief value="one\\\\ two\\"three"'
    )
  })
})

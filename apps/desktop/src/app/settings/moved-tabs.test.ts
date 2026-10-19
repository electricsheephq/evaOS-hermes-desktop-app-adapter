import { describe, expect, it } from 'vitest'

import { movedSettingsTabRedirect } from './moved-tabs'

describe('movedSettingsTabRedirect', () => {
  it('sends the retired Settings plugin/MCP tabs to Capabilities, keeping the row selector', () => {
    expect(movedSettingsTabRedirect('?tab=plugins')).toBe('/capabilities?tab=plugins')
    expect(movedSettingsTabRedirect('?tab=plugins&plugin=demo%2Fplugin')).toBe(
      '/capabilities?tab=plugins&plugin=demo%2Fplugin'
    )
    expect(movedSettingsTabRedirect('?tab=mcp&server=github')).toBe('/capabilities?tab=connectors&server=github')
  })

  it('turns an agent settings link into the row highlight plus an open settings form', () => {
    expect(movedSettingsTabRedirect('?tab=plugins&agent=fish-audio&plugin=fish-audio&profile=default')).toBe(
      '/capabilities?tab=plugins&plugin=fish-audio&settings=fish-audio'
    )
    // Upstream's own links carry only agent=: the row still gets highlighted.
    expect(movedSettingsTabRedirect('?tab=plugins&agent=demo')).toBe(
      '/capabilities?tab=plugins&plugin=demo&settings=demo'
    )
    expect(movedSettingsTabRedirect('?tab=mcp&agent=demo')).toBe('/capabilities?tab=connectors')
  })

  it('leaves live Settings tabs alone', () => {
    expect(movedSettingsTabRedirect('?tab=providers&pview=keys')).toBeNull()
    expect(movedSettingsTabRedirect('')).toBeNull()
  })
})

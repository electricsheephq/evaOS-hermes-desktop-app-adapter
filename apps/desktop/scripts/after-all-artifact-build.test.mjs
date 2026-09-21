import { describe, expect, it } from 'vitest'

import { planDmgNotarization, selectDmgArtifacts } from './after-all-artifact-build.mjs'

describe('afterAllArtifactBuild DMG notarization hook', () => {
  it('selects only macOS DMGs from the produced artifacts', () => {
    expect(selectDmgArtifacts(['/dist/evaOS Agent.dmg', '/dist/evaOS Agent.zip'], 'darwin')).toEqual([
      '/dist/evaOS Agent.dmg'
    ])
    expect(selectDmgArtifacts(['/dist/evaOS Agent.dmg'], 'linux')).toEqual([])
  })

  it('skips when Apple notarization credentials are absent', () => {
    expect(
      planDmgNotarization({
        artifactPaths: ['/dist/evaOS Agent.dmg'],
        env: {},
        platform: 'darwin'
      })
    ).toEqual({ artifacts: [], skip: 'credentials' })
  })
})

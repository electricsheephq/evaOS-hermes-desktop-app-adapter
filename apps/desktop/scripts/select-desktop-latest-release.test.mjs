import assert from 'node:assert/strict'
import test from 'node:test'

import { isCompleteDesktopRelease, selectDesktopLatestRelease } from './select-desktop-latest-release.mjs'

const BASE = 'evaOS-Agent-2026.10.1-es.13-arm64'

function createReleaseFixture(overrides = {}) {
  return {
    id: 13,
    tag_name: 'v2026.10.1-es.13',
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T00:00:00Z',
    assets: ['latest-mac.yml', `${BASE}.dmg`, `${BASE}.dmg.blockmap`, `${BASE}.zip`, `${BASE}.zip.blockmap`].map(
      name => ({ name })
    ),
    ...overrides
  }
}

function withoutAssets(match) {
  const release = createReleaseFixture()
  release.assets = release.assets.filter(asset => !match(asset.name))
  return release
}

// AGENTS.md caps a fix at 1-2 INVARIANT tests, so the two behaviour contracts
// below are table-driven rather than one test per case. Each row is named, so a
// failure still says which property broke.
test('isCompleteDesktopRelease: a release is complete only when every DMG and ZIP payload has its own blockmap', () => {
  const orphansOnly = withoutAssets(name => name.endsWith('.blockmap'))
  orphansOnly.assets.push(
    { name: 'evaOS-Agent-2026.10.1-es.11-arm64.zip.blockmap' },
    { name: 'evaOS-Agent-2026.10.1-es.12-arm64.zip.blockmap' }
  )

  const unpairedExtraDmg = createReleaseFixture()
  unpairedExtraDmg.assets.push({ name: 'evaOS-Agent-2026.10.1-es.13-x64.dmg' })

  const pairedExtraDmg = createReleaseFixture()
  pairedExtraDmg.assets.push(
    { name: 'evaOS-Agent-2026.10.1-es.13-x64.dmg' },
    { name: 'evaOS-Agent-2026.10.1-es.13-x64.dmg.blockmap' }
  )

  const unpairedExtraZip = createReleaseFixture()
  unpairedExtraZip.assets.push({ name: 'evaOS-Agent-2026.10.1-es.13-x64.zip' })

  const malformedAssets = createReleaseFixture()
  malformedAssets.assets.push(null, {}, { name: null }, { name: 1 })

  const noAssetsKey = createReleaseFixture()
  delete noAssetsKey.assets

  for (const [label, release, expected] of [
    ['its own paired blockmaps', createReleaseFixture(), true],
    // The regression this file exists for: real releases inherit blockmaps for
    // other versions, so a count or a per-type check passes on orphans alone.
    ['only orphan blockmaps from other versions', orphansOnly, false],
    ['a DMG blockmap but no ZIP blockmap', withoutAssets(name => name.endsWith('.zip.blockmap')), false],
    ['a second DMG payload with no blockmap', unpairedExtraDmg, false],
    ['a second DMG payload with its blockmap', pairedExtraDmg, true],
    ['a second ZIP payload with no blockmap', unpairedExtraZip, false],
    ['draft set', createReleaseFixture({ draft: true }), false],
    ['prerelease set', createReleaseFixture({ prerelease: true }), false],
    ['a non-Desktop tag', createReleaseFixture({ tag_name: 'evaos-runtime-es.12-v0.21.5-r34.4' }), false],
    ['no latest-mac.yml', withoutAssets(name => name === 'latest-mac.yml'), false],
    ['no DMG payload', withoutAssets(name => name.endsWith('.dmg')), false],
    ['no ZIP payload', withoutAssets(name => name.endsWith('.zip')), false],
    ['unreadable asset entries alongside complete ones', malformedAssets, true],
    ['no assets key', noAssetsKey, false],
    ['a null assets value', createReleaseFixture({ assets: null }), false],
    ['a non-array assets value', createReleaseFixture({ assets: {} }), false]
  ]) {
    assert.equal(isCompleteDesktopRelease(release), expected, `release with ${label}`)
  }
})

test('selectDesktopLatestRelease: picks the newest complete Desktop release, or null', () => {
  const newest = createReleaseFixture()
  const older = createReleaseFixture({ id: 11, tag_name: 'v2026.10.1-es.11', published_at: '2026-09-29T00:00:00Z' })
  const middle = createReleaseFixture({ id: 12, tag_name: 'v2026.10.1-es.12', published_at: '2026-09-30T00:00:00Z' })
  const newerRuntime = createReleaseFixture({
    tag_name: 'evaos-runtime-es.12-v0.21.5-r34.4',
    published_at: '2026-10-02T00:00:00Z'
  })

  for (const [label, releases, expected] of [
    // Wrong-latest recovery: a runtime release published later must not win.
    ['a newer non-Desktop release present', [newerRuntime, newest], newest],
    ['unordered input', [newest, older, middle], newest],
    ['an empty list', [], null],
    ['no qualifying release', [createReleaseFixture({ draft: true }), createReleaseFixture({ prerelease: true })], null]
  ]) {
    assert.equal(selectDesktopLatestRelease(releases), expected, `selection with ${label}`)
  }
})

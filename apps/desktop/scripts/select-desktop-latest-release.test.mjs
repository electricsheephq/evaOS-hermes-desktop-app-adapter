import assert from 'node:assert/strict'
import test from 'node:test'

import { isCompleteDesktopRelease, selectDesktopLatestRelease } from './select-desktop-latest-release.mjs'

function createReleaseFixture(overrides = {}) {
  const base = 'evaOS-Agent-2026.10.1-es.13-arm64'

  return {
    id: 13,
    tag_name: 'v2026.10.1-es.13',
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T00:00:00Z',
    assets: ['latest-mac.yml', `${base}.dmg`, `${base}.dmg.blockmap`, `${base}.zip`, `${base}.zip.blockmap`].map(
      name => ({ name })
    ),
    ...overrides
  }
}

test('accepts a complete Desktop release with its own paired blockmaps', () => {
  assert.equal(isCompleteDesktopRelease(createReleaseFixture()), true)
})

test('regression: rejects a release whose only blockmaps are orphans', () => {
  const release = createReleaseFixture()
  release.assets = release.assets.filter(asset => !asset.name.endsWith('.blockmap'))
  release.assets.push(
    { name: 'evaOS-Agent-2026.10.1-es.11-arm64.zip.blockmap' },
    { name: 'evaOS-Agent-2026.10.1-es.12-arm64.zip.blockmap' }
  )

  assert.equal(isCompleteDesktopRelease(release), false)
})

test('rejects a paired DMG when its own ZIP blockmap is missing', () => {
  const release = createReleaseFixture()
  release.assets = release.assets.filter(asset => !asset.name.endsWith('.zip.blockmap'))

  assert.equal(isCompleteDesktopRelease(release), false)
})

test('requires a matching blockmap for every DMG and ZIP payload', () => {
  for (const ext of ['dmg', 'zip']) {
    const release = createReleaseFixture()
    const name = `evaOS-Agent-2026.10.1-es.13-x64.${ext}`
    release.assets.push({ name })

    assert.equal(isCompleteDesktopRelease(release), false)
    release.assets.push({ name: `${name}.blockmap` })
    assert.equal(isCompleteDesktopRelease(release), true)
  }
})

for (const [label, overrides] of [
  ['draft', { draft: true }],
  ['prerelease', { prerelease: true }],
  ['non-Desktop tag', { tag_name: 'evaos-runtime-es.12-v0.21.5-r34.4' }]
]) {
  test(`rejects a release with ${label}`, () => {
    assert.equal(isCompleteDesktopRelease(createReleaseFixture(overrides)), false)
  })
}

for (const [label, remove] of [
  ['latest-mac.yml', name => name === 'latest-mac.yml'],
  ['DMG payload', name => name.endsWith('.dmg')],
  ['ZIP payload', name => name.endsWith('.zip')]
]) {
  test(`rejects a release missing its ${label}`, () => {
    const release = createReleaseFixture()
    release.assets = release.assets.filter(asset => !remove(asset.name))

    assert.equal(isCompleteDesktopRelease(release), false)
  })
}

test('wrong-latest recovery selects Desktop over a newer non-Desktop release', () => {
  const desktop = createReleaseFixture()
  const runtime = createReleaseFixture({
    tag_name: 'evaos-runtime-es.12-v0.21.5-r34.4',
    published_at: '2026-10-02T00:00:00Z'
  })

  assert.equal(selectDesktopLatestRelease([runtime, desktop]), desktop)
})

test('picks the newest complete release by published_at from unordered input', () => {
  const newest = createReleaseFixture()
  const oldest = createReleaseFixture({ id: 11, tag_name: 'v2026.10.1-es.11', published_at: '2026-09-29T00:00:00Z' })
  const middle = createReleaseFixture({ id: 12, tag_name: 'v2026.10.1-es.12', published_at: '2026-09-30T00:00:00Z' })

  assert.equal(selectDesktopLatestRelease([newest, oldest, middle]), newest)
})

test('returns null for an empty release list', () => {
  assert.equal(selectDesktopLatestRelease([]), null)
})

test('returns null when every release is unqualified', () => {
  const releases = [createReleaseFixture({ draft: true }), createReleaseFixture({ prerelease: true })]

  assert.equal(selectDesktopLatestRelease(releases), null)
})

test('tolerates a release with no assets key', () => {
  const release = createReleaseFixture()
  delete release.assets

  assert.equal(isCompleteDesktopRelease(release), false)
})

test('tolerates a release with null assets', () => {
  assert.equal(isCompleteDesktopRelease(createReleaseFixture({ assets: null })), false)
})

test('tolerates non-array assets and ignores absent or non-string names', () => {
  assert.equal(isCompleteDesktopRelease(createReleaseFixture({ assets: {} })), false)

  const release = createReleaseFixture()
  release.assets.push(null, {}, { name: null }, { name: 1 })

  assert.equal(isCompleteDesktopRelease(release), true)
})

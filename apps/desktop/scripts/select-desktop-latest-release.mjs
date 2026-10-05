#!/usr/bin/env node

import { isMain } from './utils.mjs'

export function isCompleteDesktopRelease(release) {
  if (
    release?.draft !== false ||
    release?.prerelease !== false ||
    typeof release?.tag_name !== 'string' ||
    !/^v[0-9].*-es\.[0-9]+$/.test(release.tag_name)
  ) {
    return false
  }

  const assets = Array.isArray(release.assets) ? release.assets : []
  const names = new Set(assets.map(asset => asset?.name).filter(name => typeof name === 'string'))
  const dmg = [...names].filter(name => name.endsWith('.dmg'))
  const zip = [...names].filter(name => name.endsWith('.zip'))

  return (
    names.has('latest-mac.yml') &&
    dmg.length > 0 &&
    zip.length > 0 &&
    [...dmg, ...zip].every(name => names.has(`${name}.blockmap`))
  )
}

export function selectDesktopLatestRelease(releases) {
  const complete = releases.filter(isCompleteDesktopRelease)
  complete.sort((left, right) => {
    if (left.published_at < right.published_at) return -1
    if (left.published_at > right.published_at) return 1
    return 0
  })

  return complete.at(-1) ?? null
}

export async function main() {
  process.stdin.setEncoding('utf8')
  let source = ''
  for await (const chunk of process.stdin) {
    source += chunk
  }

  const release = selectDesktopLatestRelease(JSON.parse(source))
  if (!release) {
    throw new Error('No complete stable Desktop updater release is available.')
  }

  process.stdout.write(`${release.id}\t${release.tag_name}\n`)
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}

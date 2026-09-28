import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'

import { test } from 'vitest'

import {
  MIN_BACKEND_CONTRACT_KEY,
  minBackendContractBuilderArg,
  readRequiredBackendContract
} from './backend-contract.mjs'

const require = createRequire(import.meta.url)

test('reads REQUIRED_BACKEND_CONTRACT from the renderer source', () => {
  const source = fs.readFileSync(new URL('../src/store/updates.ts', import.meta.url), 'utf8')
  const declared = Number(/^export const REQUIRED_BACKEND_CONTRACT = (\d+)$/m.exec(source)?.[1])

  assert.ok(Number.isInteger(declared) && declared > 0)
  assert.equal(readRequiredBackendContract(), declared)
  assert.equal(readRequiredBackendContract('export const REQUIRED_BACKEND_CONTRACT = 11\n'), 11)
})

test('refuses a source without exactly one numeric declaration', () => {
  assert.throws(() => readRequiredBackendContract('export const REQUIRED_BACKEND_CONTRACT = next\n'))
  assert.throws(() =>
    readRequiredBackendContract('export const REQUIRED_BACKEND_CONTRACT = 1\nexport const REQUIRED_BACKEND_CONTRACT = 2\n')
  )
})

test('electron-builder receives the contract as a numeric releaseInfo.vendor field', () => {
  const builder = require('electron-builder/out/builder.js')
  const yargs = require('yargs')
  const argv = builder.configureBuildCommand(yargs(['--mac', minBackendContractBuilderArg(9)])).parse()
  const { config } = builder.normalizeOptions(argv)

  assert.deepEqual(config.releaseInfo, { vendor: { [MIN_BACKEND_CONTRACT_KEY]: 9 } })
  assert.equal(minBackendContractBuilderArg(), minBackendContractBuilderArg(readRequiredBackendContract()))
})

test('the builder wrapper passes the derived value and package.json never hand-sets it', () => {
  const wrapper = fs.readFileSync(new URL('./run-electron-builder.mjs', import.meta.url), 'utf8')
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  assert.match(wrapper, /args\.push\(minBackendContractBuilderArg\(\)\)/)
  assert.equal(manifest.build.releaseInfo?.vendor?.[MIN_BACKEND_CONTRACT_KEY], undefined)
})

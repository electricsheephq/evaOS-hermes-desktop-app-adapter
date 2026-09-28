// The app-update feed carries the minimum agent contract a release needs
// (latest-mac.yml `vendor.evaosMinBackendContract`). It is derived at build
// time from the renderer's REQUIRED_BACKEND_CONTRACT, never hand-edited, so
// the gate in electron/eva-app-updater.cjs cannot drift from the app it ships.

import fs from 'node:fs'

export const MIN_BACKEND_CONTRACT_KEY = 'evaosMinBackendContract'

const UPDATES_STORE = new URL('../src/store/updates.ts', import.meta.url)

export function readRequiredBackendContract(source = fs.readFileSync(UPDATES_STORE, 'utf8')) {
  const matches = [...String(source).matchAll(/^export const REQUIRED_BACKEND_CONTRACT = (\d+)$/gm)]

  if (matches.length !== 1) {
    throw new Error('src/store/updates.ts must declare exactly one numeric REQUIRED_BACKEND_CONTRACT.')
  }

  return Number(matches[0][1])
}

export function minBackendContractBuilderArg(contract = readRequiredBackendContract()) {
  return `-c.releaseInfo.vendor.${MIN_BACKEND_CONTRACT_KEY}=${contract}`
}

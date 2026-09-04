import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export function validateMacSigningIdentity(options, env = process.env) {
  const expected = String(env.CSC_NAME || '')
    .trim()
    .toUpperCase()
  const selected = String(options?.identity || '')
    .trim()
    .toUpperCase()
  if (!/^[A-F0-9]{40}$/.test(expected) || selected !== expected) {
    throw new Error('macOS signing requires CSC_NAME to match the exact selected certificate fingerprint.')
  }
  return { ...options, identity: expected }
}

// app-builder-lib 26.15.3 builds options with the certificate hash but its
// default doSign path replaces that hash with the ambiguous display name.
// Use its supported custom-sign hook and existing nested-code signer instead;
// no installed dependency patch or new signing implementation is needed.
export default async function signMac(options) {
  const verifiedOptions = validateMacSigningIdentity(options)
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
  const { sign } = builderRequire('app-builder-lib/out/codeSign/macCodeSign.js')
  await sign(verifiedOptions)
}

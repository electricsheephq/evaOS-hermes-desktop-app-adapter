import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { validateMacSigningIdentity } from './sign-mac.mjs'

const fingerprint = 'A'.repeat(40)

test('custom signing preserves the selected fingerprint and nested signing options', () => {
  const options = {
    identity: fingerprint,
    app: '/synthetic/app',
    hardenedRuntime: true,
    keychain: '/synthetic/keychain'
  }
  assert.deepEqual(validateMacSigningIdentity(options, { CSC_NAME: fingerprint.toLowerCase() }), options)
  assert.equal(options.identity, fingerprint)
})

test('signing fails closed for names, missing identity and mismatched fingerprints', () => {
  for (const expected of ['', 'Developer ID Application: Synthetic', 'B'.repeat(40)]) {
    assert.throws(
      () => validateMacSigningIdentity({ identity: fingerprint }, { CSC_NAME: expected }),
      /exact selected certificate/
    )
  }
  assert.throws(() =>
    validateMacSigningIdentity({ identity: 'Developer ID Application: Synthetic' }, { CSC_NAME: fingerprint })
  )
  assert.throws(() => validateMacSigningIdentity({}, { CSC_NAME: fingerprint }))
})

test('managed macOS build uses the supported signing hook', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.build.mac.sign, 'scripts/sign-mac.mjs')
})

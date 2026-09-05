const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const desktopRoot = path.resolve(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))

// Main-process behavior is exercised through the built Electron preload in
// e2e/managed-boot.spec.ts, and through the production managed backend gate.
// Do not assert TypeScript source spelling as a substitute for those contracts.
test('the canonical Desktop check includes managed contracts', () => {
  assert.equal(packageJson.scripts['check:test:managed'], 'npm run test:managed')
  assert.match(packageJson.scripts.check, /npm run check:test:managed/)
  assert.match(packageJson.scripts['test:managed'], /electron\/r31-managed-profile-bypass\.test\.cjs/)
  assert.equal(packageJson.dependencies['electron-updater'], '6.8.9')
})

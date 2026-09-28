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

// Exception to the rule above: the moment of the first safeStorage touch is
// module-scope ordering in main.ts, which no unit test can execute. Without
// it, a process that starts signed out pins a different macOS Keychain key
// than the one every later launch reads with.
test('managed macOS builds touch safeStorage before the managed runtime reads state', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
  const guard = main.indexOf("if (EVA_MANAGED_BUILD && process.platform === 'darwin') {")
  const runtime = main.indexOf('const evaManagedRuntime = createEvaManagedRuntime(')
  assert.ok(guard > 0, 'early-key block guarded by the managed flag and darwin')
  assert.ok(runtime > guard, 'early-key block precedes createEvaManagedRuntime(')
  const block = main.slice(guard, runtime)
  assert.match(block, /safeStorage\.isEncryptionAvailable\(\)/)
  assert.match(block, /secure-storage early key/)
  assert.match(main.slice(runtime, runtime + 400), /secureStorageState: \(\) => /)
})

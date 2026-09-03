const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const desktopRoot = path.resolve(__dirname, '..')
const mainSource = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))

function assertSourceMatch(pattern, message) {
  assert.ok(pattern.test(mainSource), message)
}

test('managed main-process wiring survives an upstream Desktop recut', () => {
  assertSourceMatch(
    /async function ensureBackend\(profile\)\s*{\s*if \(EVA_MANAGED_BUILD\)\s*{\s*return evaManagedRuntime\.resolveBackend\(\{ profile \}\)/,
    'managed connections must resolve through the enrollment runtime'
  )
  assertSourceMatch(
    /function globalRemoteActive\(\)\s*{\s*if \(EVA_MANAGED_BUILD\)\s*{\s*return true/,
    'managed mode must stay globally remote even without local connection config'
  )
  assertSourceMatch(
    /ipcMain\.handle\('hermes:api',[\s\S]{0,250}if \(EVA_MANAGED_BUILD\)\s*{\s*return evaManagedRuntime\.requestApi\(request\)/,
    'managed REST must stay possession-bound to the enrollment runtime'
  )
  for (const channel of ['hermes:connection:for', 'hermes:gateway:ws-url-for']) {
    assertSourceMatch(
      new RegExp(
        `ipcMain\\.handle\\('${channel}'[\\s\\S]{0,300}` +
          'if \\(EVA_MANAGED_BUILD\\)[\\s\\S]{0,180}assertEvaManagedConnectionId\\('
      ),
      `${channel} must accept only the opaque enrolled-runtime route in managed mode`
    )
  }
  assertSourceMatch(
    /ipcMain\.handle\('hermes:plugin-profile-routes',[\s\S]{0,500}if \(EVA_MANAGED_BUILD\)\s*{\s*return buildEvaManagedProfileRoutes\(/,
    'managed plugin route inventory must bypass the workstation connection registry'
  )
  assertSourceMatch(
    /ipcMain\.handle\('hermes:window:openInTerminal',[\s\S]{0,220}assertEvaManagedLocalTerminalAllowed\(EVA_MANAGED_BUILD\)/,
    'managed mode must reject external terminal launches before resolving a local runtime'
  )
  for (const channel of ['status', 'sign-in', 'sign-out', 'refresh']) {
    assertSourceMatch(new RegExp(`ipcMain\\.handle\\('hermes:eva:${channel}'`), `missing hermes:eva:${channel} handler`)
  }
  assertSourceMatch(/ipcMain\.handle\('hermes:eva:support:end'/, 'missing hermes:eva:support:end handler')
  assertSourceMatch(
    /mainWindow\.webContents\.once\('did-finish-load', async \(\) =>\s*{\s*await evaManagedRuntime\.flushPendingRendererReset\(\)/,
    'pending account-isolation cleanup must complete before renderer readiness'
  )
  assertSourceMatch(
    /const HERMES_PROTOCOL = EVA_MANAGED_BUILD\s*\? EVA_MANAGED_POLICY\.callbackScheme/,
    'managed auth callbacks must use the packaged evaOS scheme'
  )
  assertSourceMatch(
    /registerFsIpc\(\{[\s\S]{0,500}assertLocalAccessAllowed:/,
    'the extracted local filesystem IPC surface must retain the managed guard'
  )
  assertSourceMatch(
    /registerGitIpc\(\{[\s\S]{0,250}assertLocalMutationAllowed:/,
    'the extracted local Git IPC surface must retain the managed mutation guard'
  )
  assertSourceMatch(
    /registerTerminalIpc\(\{[\s\S]{0,500}assertLocalTerminalAllowed:/,
    'the extracted local terminal IPC surface must retain the managed start guard'
  )
  assertSourceMatch(
    /registerTerminalIpc\(\{[\s\S]{0,500}assertLocalMutationAllowed:/,
    'the extracted local terminal IPC surface must retain the managed mutation guard'
  )
  for (const channel of ['get', 'set', 'pick']) {
    assertSourceMatch(
      new RegExp(
        `ipcMain\\.handle\\('hermes:setting:defaultProjectDir:${channel}'[\\s\\S]{0,220}` +
          'assertEvaManagedLocalMutationAllowed\\(EVA_MANAGED_BUILD'
      ),
      `managed mode must block default project directory ${channel}`
    )
  }
  assertSourceMatch(
    /async function saveGatewayFile\(payload:[\s\S]{0,650}if \(EVA_MANAGED_BUILD\)[\s\S]{0,350}evaManagedRuntime\.requestMedia\(/,
    'managed file downloads must stay on the enrollment-bound media transport'
  )
  assertSourceMatch(
    /function secretStoragePolicy\(\)[\s\S]{0,180}EVA_MANAGED_BUILD[\s\S]{0,120}on: true/,
    'managed enrollment secrets must default to encrypted storage'
  )
})

test('the canonical Desktop check includes managed contracts', () => {
  assert.equal(packageJson.scripts['check:test:managed'], 'npm run test:managed')
  assert.match(packageJson.scripts.check, /npm run check:test:managed/)
  assert.equal(packageJson.dependencies['electron-updater'], '6.8.9')
})

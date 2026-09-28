import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler)
  },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => ''), trashItem: vi.fn(async () => undefined) }
}))

import { registerFsIpc } from './fs-ipc'

const { assertEvaManagedLocalMutationAllowed } = createRequire(import.meta.url)('./eva-managed.cjs')

const roots: string[] = []

function mkdtemp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)

  return dir
}

// A unified package (agent + desktop half) served from a local git repo.
function unifiedPluginRepo(name: string) {
  const repo = path.join(mkdtemp('hermes-managed-plugin-repo-'), name)
  fs.mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  fs.mkdirSync(path.join(repo, 'desktop'))
  fs.writeFileSync(path.join(repo, 'plugin.yaml'), `name: ${name}\n`)
  fs.writeFileSync(path.join(repo, '__init__.py'), 'def register(ctx): pass\n')
  fs.writeFileSync(path.join(repo, 'desktop', 'plugin.js'), `export default { id: "${name}" }\n`)
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-qm', 'init')

  return pathToFileURL(repo).href
}

const invoke = (channel: string, ...args: unknown[]) => {
  const handler = electron.handlers.get(channel)
  expect(handler, `missing handler for ${channel}`).toBeTypeOf('function')

  return Promise.resolve().then(() => handler?.({}, ...args))
}

// The managed build runs upstream's local desktop-plugin path: a remote
// agent's desktop half is installed on this computer and loaded from
// <HERMES_HOME>/desktop-plugins. The managed local-access denial is offered
// here exactly as main.ts used to wire it; it must not be consulted.
describe('registerFsIpc in the managed build', () => {
  let hermesHome: string

  beforeEach(() => {
    electron.handlers.clear()
    hermesHome = mkdtemp('hermes-managed-home-')
    registerFsIpc({
      assertLocalAccessAllowed: (operation: string) => assertEvaManagedLocalMutationAllowed(true, operation),
      hermesHome,
      readActiveDesktopProfile: () => null,
      expandUserPath: value => value,
      resolveRequestedPathForIpc: value => value,
      directoryExists: value => fs.existsSync(value),
      resolveGitBinary: () => 'git'
    } as Parameters<typeof registerFsIpc>[0])
  })

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('probes, installs and keeps a remote agent package desktop half', async () => {
    const repo = unifiedPluginRepo('remote-panel')
    const appRoot = path.join(hermesHome, 'desktop-plugins')

    await expect(invoke('hermes:plugin:probe', { identifier: repo })).resolves.toMatchObject({
      ok: true,
      agent: true,
      desktop: true
    })
    await expect(invoke('hermes:plugin:installDesktop', { identifier: repo })).resolves.toMatchObject({ ok: true })

    // No local plugins/<name>/ exists (the package lives on the remote agent);
    // resolving the root runs the unified-half reconcile, which must keep it.
    await expect(invoke('hermes:fs:desktopPluginsRoot')).resolves.toBe(appRoot)
    await expect(invoke('hermes:fs:reconcileDesktopPlugins')).resolves.toEqual([])
    expect(fs.readdirSync(appRoot)).toEqual(['remote-panel'])
    expect(fs.existsSync(path.join(appRoot, 'remote-panel', 'plugin.js'))).toBe(true)
  })
})

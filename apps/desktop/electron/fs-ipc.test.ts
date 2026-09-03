import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler)
  },
  shell: {
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => undefined)
  }
}))

vi.mock('./desktop-plugin-install', () => ({
  installDesktopPluginFromGit: vi.fn(async () => ({ ok: true })),
  probePluginRepo: vi.fn(async () => ({ ok: true }))
}))
vi.mock('./fs-read-dir', () => ({ readDirForIpc: vi.fn(async () => []) }))
vi.mock('./git-root', () => ({ gitRootForIpc: vi.fn(async () => null) }))

import { registerFsIpc } from './fs-ipc'

describe('registerFsIpc managed boundary', () => {
  beforeEach(() => mocks.handlers.clear())

  it('checks every local filesystem and plugin operation before touching the machine', async () => {
    const blocked = new Error('managed local access blocked')

    const assertLocalAccessAllowed = vi.fn(() => {
      throw blocked
    })

    registerFsIpc({
      assertLocalAccessAllowed,
      directoryExists: () => true,
      expandUserPath: value => value,
      hermesHome: '/tmp/hermes-test',
      readActiveDesktopProfile: () => null,
      resolveGitBinary: () => '/usr/bin/git',
      resolveRequestedPathForIpc: value => value
    })

    const invocations: Array<[string, unknown[]]> = [
      ['hermes:fs:readDir', ['/tmp']],
      ['hermes:fs:gitRoot', ['/tmp']],
      ['hermes:fs:reveal', ['/tmp/file']],
      ['hermes:fs:openDir', ['/tmp/test']],
      ['hermes:fs:desktopPluginsRoot', []],
      ['hermes:fs:logsRoot', []],
      ['hermes:fs:agentPluginsRoot', []],
      ['hermes:plugin:probe', [{ identifier: 'owner/repo' }]],
      ['hermes:plugin:installDesktop', [{ identifier: 'owner/repo' }]],
      ['hermes:fs:rename', ['/tmp/file', 'renamed']],
      ['hermes:fs:writeText', ['/tmp/file', 'text']],
      ['hermes:fs:trash', ['/tmp/file']]
    ]

    for (const [channel, args] of invocations) {
      const handler = mocks.handlers.get(channel)
      expect(handler, `missing handler for ${channel}`).toBeTypeOf('function')
      await expect(Promise.resolve().then(() => handler?.({}, ...args))).rejects.toThrow(blocked)
    }

    expect(assertLocalAccessAllowed).toHaveBeenCalledTimes(invocations.length)
  })
})

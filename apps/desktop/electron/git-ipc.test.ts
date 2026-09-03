import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler)
  }
}))

vi.mock('./git-repo-scan', () => ({ scanGitRepos: vi.fn(async () => []) }))
vi.mock('./git-review-ops', () => ({
  fileDiffVsHead: vi.fn(async () => ''),
  repoStatus: vi.fn(async () => null),
  reviewCommit: vi.fn(async () => ({ ok: true })),
  reviewCommitContext: vi.fn(async () => ({})),
  reviewCreatePr: vi.fn(async () => ({ ok: true })),
  reviewDiff: vi.fn(async () => ''),
  reviewFetchPrComment: vi.fn(async () => null),
  reviewList: vi.fn(async () => []),
  reviewPrList: vi.fn(async () => []),
  reviewPush: vi.fn(async () => ({ ok: true })),
  reviewRevert: vi.fn(async () => ({ ok: true })),
  reviewRevParse: vi.fn(async () => null),
  reviewShipInfo: vi.fn(async () => null),
  reviewStage: vi.fn(async () => ({ ok: true })),
  reviewUnstage: vi.fn(async () => ({ ok: true }))
}))
vi.mock('./git-worktree-ops', () => ({
  addWorktree: vi.fn(async () => ({ ok: true })),
  listBaseBranches: vi.fn(async () => []),
  listBranches: vi.fn(async () => []),
  listWorktrees: vi.fn(async () => []),
  removeWorktree: vi.fn(async () => ({ ok: true })),
  switchBranch: vi.fn(async () => ({ ok: true }))
}))

import { registerGitIpc } from './git-ipc'

describe('registerGitIpc managed mutation boundary', () => {
  beforeEach(() => mocks.handlers.clear())

  it('rejects every local Git mutation before the operation can run', async () => {
    const blocked = new Error('managed local Git mutation blocked')

    const deps = {
      assertLocalMutationAllowed: () => {
        throw blocked
      },
      resolveGhBinary: () => '/usr/bin/gh',
      resolveGitBinary: () => '/usr/bin/git'
    }

    registerGitIpc(deps as Parameters<typeof registerGitIpc>[0])

    const invocations: Array<[string, unknown[]]> = [
      ['hermes:git:worktreeAdd', ['/repo', {}]],
      ['hermes:git:worktreeRemove', ['/repo', '/repo/worktree', {}]],
      ['hermes:git:branchSwitch', ['/repo', 'feature']],
      ['hermes:git:review:stage', ['/repo', 'file.ts']],
      ['hermes:git:review:unstage', ['/repo', 'file.ts']],
      ['hermes:git:review:revert', ['/repo', 'file.ts']],
      ['hermes:git:review:commit', ['/repo', 'message', false]],
      ['hermes:git:review:push', ['/repo']],
      ['hermes:git:review:createPr', ['/repo']]
    ]

    for (const [channel, args] of invocations) {
      const handler = mocks.handlers.get(channel)

      expect(handler, `missing handler for ${channel}`).toBeTypeOf('function')
      await expect(Promise.resolve().then(() => handler?.({}, ...args))).rejects.toBe(blocked)
    }
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProfileInfo } from '@/types/hermes'

// #347 item 5: under a customer-wide support lease the window's socket stays on
// the lease anchor, whose managed resolver refuses a sibling profile (4030).
// A picked sibling's project RPCs must therefore ride the sibling's own pooled
// socket — the one minted with that sibling's profile, as its sessions' RPCs
// already use — and never the anchor's. This drives the REAL gateway registry,
// profile store and projects store; only the socket transport (HermesGateway)
// and the desktop bridge are stubbed, and each socket records the profile its
// WebSocket URL was minted for. Synthetic ids — public repo.

interface FakeSocket {
  mintedFor: null | string
  request: ReturnType<typeof vi.fn>
}

const sockets: FakeSocket[] = []

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  HermesGateway: class {
    connectionState = 'closed'
    mintedFor: null | string = null
    connect = vi.fn(async (url: string) => {
      this.mintedFor = new URL(url).searchParams.get('minted_for')
      this.connectionState = 'open'
    })
    request = vi.fn(async () => ({ active_id: null, projects: [], scoped_session_ids: [] }))
    close = vi.fn()
    onEvent = vi.fn(() => () => {})
    onState = vi.fn(() => () => {})

    constructor() {
      sockets.push(this as unknown as FakeSocket)
    }
  }
}))
vi.mock('@/i18n', () => ({ translateNow: (key: string) => key }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/lib/desktop-fs', () => ({
  desktopDefaultCwd: vi.fn(),
  isDesktopFsRemoteMode: vi.fn(),
  selectDesktopPaths: vi.fn(),
  writeDesktopFileText: vi.fn()
}))

const { $gateway, closeSecondaryGateways, configureGatewayRegistry, setPrimaryGateway } = await import('./gateway')
const { $profiles, adoptActiveGatewayProfile, selectProfile } = await import('./profile')
const { refreshProjectTree } = await import('./projects')

const ANCHOR = 'agent-alpha'
const SIBLING = 'agent-bravo'

const profile = (name: string): ProfileInfo => ({
  has_env: false,
  is_default: false,
  model: null,
  name,
  path: `/srv/hermes/${name}`,
  provider: null,
  skill_count: 0
})

const anchorSocket = {
  connectionState: 'open',
  request: vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
    active_id: null,
    projects: [],
    scoped_session_ids: []
  }))
}

// Electron mints each dial's WebSocket URL for the grant-checked profile the
// renderer names (main.ts freshGatewayWsUrl → eva-runtime freshWsUrl).
const getGatewayWsUrl = vi.fn(async (name: null | string) => `wss://relay.invalid/api/ws?minted_for=${name}`)

beforeEach(() => {
  sockets.length = 0
  anchorSocket.request.mockClear()
  getGatewayWsUrl.mockClear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    api: vi.fn(async () => ({ profiles: [] })),
    getConnection: vi.fn(async (name?: string) => ({ mode: 'remote', profile: name, wsUrl: '' })),
    getGatewayWsUrl,
    touchBackend: vi.fn(async () => undefined)
  }
  configureGatewayRegistry({ onEvent: vi.fn() })
  setPrimaryGateway(anchorSocket as never, ANCHOR)
  $gateway.set(anchorSocket as never)
  adoptActiveGatewayProfile(ANCHOR, true)
  $profiles.set([profile(ANCHOR), profile(SIBLING)])
})

afterEach(() => {
  closeSecondaryGateways()
  adoptActiveGatewayProfile('default', false)
  $profiles.set([])
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('project RPCs for a picked sibling under customer-wide support (#347)', () => {
  it('ride the socket minted for the sibling, never the anchor socket', async () => {
    selectProfile(SIBLING)
    await refreshProjectTree()

    const sibling = sockets.find(socket => socket.mintedFor === SIBLING)

    expect(sibling, 'a socket minted for the sibling').toBeDefined()
    expect(sibling?.request).toHaveBeenCalledWith('projects.tree', expect.objectContaining({ profile: SIBLING }))
    expect(anchorSocket.request).not.toHaveBeenCalledWith('projects.tree', expect.anything())
    expect(getGatewayWsUrl).toHaveBeenCalledWith(SIBLING, '/api/ws')
    expect(getGatewayWsUrl).not.toHaveBeenCalledWith(ANCHOR, expect.anything())
  })

  it('on the anchor stay on the anchor socket and open no other', async () => {
    await refreshProjectTree()

    expect(anchorSocket.request).toHaveBeenCalledWith('projects.tree', expect.objectContaining({ profile: ANCHOR }))
    expect(sockets).toEqual([])
  })
})

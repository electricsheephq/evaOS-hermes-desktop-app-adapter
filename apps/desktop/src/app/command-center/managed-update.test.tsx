import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'

import { CommandCenterView } from './index'

// adapter#387: a managed evaOS agent is updated by Electric Sheep, so the
// Command Center must not offer the backend self-update (POST /api/hermes/update).

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getActionStatus: vi.fn(() => Promise.resolve({ running: false })),
  getLogs: vi.fn(() => Promise.resolve({ lines: [] })),
  getStatus: vi.fn(() => Promise.resolve({ active_sessions: 0, gateway_running: true, version: '0.0.1' })),
  getUsageAnalytics: vi.fn(() => Promise.resolve({})),
  restartGateway: vi.fn(),
  updateHermes: vi.fn()
}))
vi.mock('@/lib/session-export', () => ({ exportSession: vi.fn() }))
vi.mock('./maintenance', () => ({ MaintenancePanel: () => null }))

afterEach(() => {
  cleanup()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

function renderSystemSection() {
  return render(
    <MemoryRouter>
      <CommandCenterView
        initialSection="system"
        onClose={() => {}}
        onDeleteSession={() => Promise.resolve()}
        onOpenSession={() => {}}
      />
    </MemoryRouter>
  )
}

describe('Command Center backend update (adapter#387)', () => {
  it('offers the backend update on an unmanaged build', async () => {
    renderSystemSection()

    expect(await screen.findByRole('button', { name: 'Update Hermes' })).toBeTruthy()
  })

  it('hides the backend update on a managed evaOS agent', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = { eva: {} }
    renderSystemSection()

    expect(await screen.findByRole('button', { name: 'Restart gateway' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Update Hermes' })).toBeNull()
  })
})

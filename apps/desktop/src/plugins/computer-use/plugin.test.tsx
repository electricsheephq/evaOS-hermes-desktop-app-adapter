import { ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Test harness builds the context the plugin loader hands to register().
// eslint-disable-next-line no-restricted-imports
import { createPluginContext } from '@/contrib/plugin'
// Test harness reads the contribution registry the sidebar and router read.
// eslint-disable-next-line no-restricted-imports
import { registry } from '@/contrib/registry'

import plugin, { ComputerUsePage } from './plugin'

const status = (available: boolean) => ({
  available,
  agent: 'Jane’s agent',
  enabled: true,
  cua: { found: true, path: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver', source: 'app', version: '0.30.2' },
  permissions: { accessibility: true, screen_recording: true },
  daemon: { running: false, mode: null },
  connections: [],
  inUse: [],
  error: null
})

let current: ReturnType<typeof status>
let disposers: Array<() => void>

const ids = (area: string) => registry.getArea(area).map(entry => entry.id)
const settle = () => act(async () => void (await Promise.resolve()))

beforeEach(() => {
  vi.useFakeTimers()
  current = status(false)
  disposers = []
  ;(window as any).hermesDesktop = {
    macBridge: {
      status: vi.fn(async () => current),
      setEnabled: vi.fn(async () => current),
      installCua: vi.fn(async () => undefined),
      grantPermissions: vi.fn(async () => undefined)
    }
  }
})

afterEach(() => {
  cleanup()
  disposers.forEach(dispose => dispose())
  delete (window as any).hermesDesktop
  vi.useRealTimers()
})

describe('Computer Use sidebar entry and page', () => {
  it('registers the route always, and the sidebar entry only while available is true', async () => {
    await plugin.register(createPluginContext('computer-use', dispose => disposers.push(dispose)))
    await settle()
    expect(ids(ROUTES_AREA)).toContain('computer-use:page')
    expect(ids(SIDEBAR_NAV_AREA)).not.toContain('computer-use:nav')

    current = status(true)
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
    expect(ids(SIDEBAR_NAV_AREA)).toContain('computer-use:nav')

    current = status(false)
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
    expect(ids(SIDEBAR_NAV_AREA)).not.toContain('computer-use:nav')
    expect(ids(ROUTES_AREA)).toContain('computer-use:page')

    // Unloading the plugin stops the poll and leaves nothing behind.
    current = status(true)
    disposers.forEach(dispose => dispose())
    disposers = []
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)))
    expect(ids(SIDEBAR_NAV_AREA)).not.toContain('computer-use:nav')
    expect(ids(ROUTES_AREA)).not.toContain('computer-use:page')
  })

  it('not available: the page shows only "isn’t set up", with no install, permissions or Enable controls', async () => {
    render(<ComputerUsePage />)
    await settle()
    expect(screen.getByText('Computer Use isn\'t set up for Jane’s agent yet.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('Enable Computer Use')).toBeNull()
    expect(screen.queryByText('macOS permissions')).toBeNull()
  })

  it('available: the existing page', async () => {
    current = status(true)
    render(<ComputerUsePage />)
    await settle()
    expect(screen.queryByText(/isn't set up/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Reinstall CUA' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Grant permissions' })).toBeTruthy()
    expect(screen.getByText('Enable Computer Use')).toBeTruthy()
    expect(screen.getByRole('switch')).toBeTruthy() // the control the not-set-up page must not show
  })

  it('opening the page asks `available` again once; later polls use the cache', async () => {
    const macBridge = (window as any).hermesDesktop.macBridge
    render(<ComputerUsePage />)
    await settle()
    await act(async () => void (await vi.advanceTimersByTimeAsync(4000)))
    expect(macBridge.status.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(macBridge.status.mock.calls[0]).toEqual([{ reprobe: true }])
    expect(macBridge.status.mock.calls.slice(1).every((call: unknown[]) => call[0] === undefined)).toBe(true)
  })

  it('B6: one status poll at a time: a slow status() starts no second call until it answers', async () => {
    current = status(true)
    let answer: (value: ReturnType<typeof status>) => void = () => undefined
    const macBridge = (window as any).hermesDesktop.macBridge
    macBridge.status.mockImplementation(() => new Promise(resolve => (answer = resolve)))

    render(<ComputerUsePage />)
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
    expect(macBridge.status).toHaveBeenCalledTimes(1)

    await act(async () => answer(current))
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)))
    expect(macBridge.status).toHaveBeenCalledTimes(2)
  })

  it('B6: a poll that started before Disable and answers after it is dropped', async () => {
    const macBridge = (window as any).hermesDesktop.macBridge
    const on = status(true)
    const off = { ...status(true), enabled: false }
    let late: (value: ReturnType<typeof status>) => void = () => undefined
    macBridge.status.mockImplementationOnce(async () => on)
    macBridge.status.mockImplementationOnce(() => new Promise(resolve => (late = resolve)))
    macBridge.status.mockImplementation(async () => off)
    macBridge.setEnabled.mockImplementation(async () => off)

    render(<ComputerUsePage />)
    await settle()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000))) // the slow poll starts
    expect(macBridge.status).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('switch'))
    await settle()
    expect(macBridge.setEnabled).toHaveBeenCalledWith(false)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')

    await act(async () => late(on)) // read before Disable: stale
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })
})

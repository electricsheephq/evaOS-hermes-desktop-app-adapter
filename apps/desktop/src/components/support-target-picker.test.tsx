import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvaSupportClient, EvaSupportStartResult, EvaSupportTargetsResult } from '@/global'
import { I18nProvider } from '@/i18n'
import { setSupportPickerOpen } from '@/store/support-picker'

import { SupportTargetPickerOverlay } from './support-target-picker'

const ACCOUNT_ID = '11111111-2222-4333-8444-555555555555'
const VM_ID = '66666666-7777-4888-9999-000000000000'

function clients(): EvaSupportClient[] {
  return [
    {
      customer_account_id: ACCOUNT_ID,
      customer_vm_id: VM_ID,
      display_name: 'Acme',
      profiles: [
        { profile_id: 'main', display_name: 'Asuka' },
        { profile_id: 'ops', display_name: 'Rei' }
      ]
    }
  ]
}

function mountBridge(
  overrides: Partial<
    Record<
      'listSupportTargets' | 'startSupport' | 'switchSupportTarget' | 'endSupportSession' | 'onOpenSupportPicker',
      unknown
    >
  > = {}
) {
  const listSupportTargets = vi
    .fn<() => Promise<EvaSupportTargetsResult>>()
    .mockResolvedValue({ ok: true, is_admin: false, clients: clients() })

  const startSupport = vi.fn<() => Promise<EvaSupportStartResult>>().mockResolvedValue({
    ok: true,
    status: { managed: true } as never
  })

  const switchSupportTarget = vi.fn().mockResolvedValue({ managed: true })
  const endSupportSession = vi.fn().mockResolvedValue({ ok: true })
  const onOpenSupportPicker = vi.fn().mockReturnValue(() => undefined)
  const eva = {
    listSupportTargets,
    startSupport,
    switchSupportTarget,
    endSupportSession,
    onOpenSupportPicker,
    ...overrides
  }
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { eva } })

  return eva
}

function renderPicker() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <SupportTargetPickerOverlay />
    </I18nProvider>
  )
}

beforeEach(() => {
  setSupportPickerOpen(false)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SupportTargetPickerOverlay', () => {
  it('gates Start behind an agent choice and explicit consent, and resets consent when the choice changes', async () => {
    const eva = mountBridge()
    renderPicker()
    setSupportPickerOpen(true)

    const dialog = await screen.findByRole('dialog', { name: 'Switch support target' })
    await waitFor(() => expect(eva.listSupportTargets).toHaveBeenCalledTimes(1))
    const [account, agent] = await screen.findAllByRole('combobox')
    const start = screen.getByRole('button', { name: 'Open selected customer agent' }) as HTMLButtonElement
    const consent = screen.getByRole('checkbox') as HTMLInputElement

    // Nothing chosen: agent select and consent are inert, Start is disabled.
    expect((agent as HTMLSelectElement).disabled).toBe(true)
    expect(consent.disabled).toBe(true)
    expect(start.disabled).toBe(true)
    // A non-admin never sees the all-agents option.
    expect(dialog.textContent).not.toMatch(/All authorized agents/)

    fireEvent.change(account, { target: { value: ACCOUNT_ID } })
    expect(consent.disabled).toBe(true)
    fireEvent.change(agent, { target: { value: 'main' } })
    expect(consent.disabled).toBe(false)
    expect(start.disabled).toBe(true)
    fireEvent.click(consent)
    expect(start.disabled).toBe(false)

    // Changing the agent withdraws the consent that was given for the other one.
    fireEvent.change(agent, { target: { value: 'ops' } })
    expect(consent.checked).toBe(false)
    expect(start.disabled).toBe(true)

    fireEvent.click(consent)
    fireEvent.click(start)

    await waitFor(() => expect(eva.startSupport).toHaveBeenCalledTimes(1))
    // The payload is the dashboard picker's shape, plus labels for the lease handle.
    expect(eva.startSupport).toHaveBeenCalledWith({
      customer_account_id: ACCOUNT_ID,
      customer_vm_id: VM_ID,
      profile_id: 'ops',
      acknowledged: true,
      customer_label: 'Acme',
      agent_label: 'Rei'
    })
    expect((await screen.findByRole('status')).textContent).toBe('Support access granted. Reloading…')
  })

  it('offers all authorized agents to an admin and sends the customer scope', async () => {
    const eva = mountBridge({
      listSupportTargets: vi.fn().mockResolvedValue({ ok: true, is_admin: true, clients: clients() })
    })

    renderPicker()
    setSupportPickerOpen(true)

    const [account, agent] = await screen.findAllByRole('combobox')
    fireEvent.change(account, { target: { value: ACCOUNT_ID } })
    expect((agent as HTMLSelectElement).options[0].textContent).toBe('All authorized agents (default)')
    const consent = screen.getByRole('checkbox') as HTMLInputElement
    expect(consent.disabled).toBe(false)
    fireEvent.click(consent)
    fireEvent.click(screen.getByRole('button', { name: 'Open selected customer agent' }))

    await waitFor(() => expect(eva.startSupport).toHaveBeenCalledTimes(1))
    // Customer scope carries no profile at all: no `profile_id`, no agent label.
    expect(eva.startSupport).toHaveBeenCalledWith({
      customer_account_id: ACCOUNT_ID,
      customer_vm_id: VM_ID,
      profile_scope: 'customer',
      acknowledged: true,
      customer_label: 'Acme'
    })
    const [payload] = (eva.startSupport as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(Object.keys(payload as object)).not.toContain('profile_id')
  })

  it('renders needs_sign_in as a Sign in action that forces a fresh plain sign-in and re-lists', async () => {
    const listSupportTargets = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'needs_sign_in', code: 'broker-rejected', message: 'Sign in again.' })
      .mockResolvedValueOnce({ ok: true, is_admin: false, clients: clients() })

    const eva = mountBridge({ listSupportTargets })
    renderPicker()
    setSupportPickerOpen(true)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Sign in to Electric Sheep again to choose a support target/)
    expect(alert.textContent).toMatch(/update for in-app support is not deployed yet/)

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Electric Sheep' }))

    await waitFor(() => expect(eva.switchSupportTarget).toHaveBeenCalledWith({ signInAgain: true }))
    await waitFor(() => expect(listSupportTargets).toHaveBeenCalledTimes(2))
    expect(await screen.findAllByRole('combobox')).toHaveLength(2)
  })

  it('renders conflict with an End support action and forbidden/error with the bounded message', async () => {
    const eva = mountBridge({
      listSupportTargets: vi.fn().mockResolvedValue({ ok: true, is_admin: false, clients: clients() }),
      startSupport: vi
        .fn()
        .mockResolvedValue({
          ok: false,
          reason: 'conflict',
          code: 'delegated_support_conflict',
          message: 'Another support session is active.'
        })
    })

    renderPicker()
    setSupportPickerOpen(true)

    const [account, agent] = await screen.findAllByRole('combobox')
    fireEvent.change(account, { target: { value: ACCOUNT_ID } })
    fireEvent.change(agent, { target: { value: 'main' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Open selected customer agent' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/Another support session is active/)
    fireEvent.click(screen.getByRole('button', { name: 'End support session' }))
    await waitFor(() => expect(eva.endSupportSession).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()

    // A lease this app still holds a handle for blocks a new start the same way,
    // with the same End control — the one that reaches that handle.
    cleanup()

    const pending = mountBridge({
      startSupport: vi
        .fn()
        .mockResolvedValue({
          ok: false,
          reason: 'cleanup_pending',
          code: 'support-cleanup-pending',
          message: 'A previous support session could not be ended yet. End it, then try again.'
        })
    })

    renderPicker()
    setSupportPickerOpen(true)
    const [pendingAccount, pendingAgent] = await screen.findAllByRole('combobox')
    fireEvent.change(pendingAccount, { target: { value: ACCOUNT_ID } })
    fireEvent.change(pendingAgent, { target: { value: 'main' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Open selected customer agent' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be ended yet/)
    fireEvent.click(screen.getByRole('button', { name: 'End support session' }))
    await waitFor(() => expect(pending.endSupportSession).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()

    cleanup()
    mountBridge({
      listSupportTargets: vi
        .fn()
        .mockResolvedValue({
          ok: false,
          reason: 'error',
          code: 'broker-rejected',
          message: 'Electric Sheep request failed (500).'
        })
    })
    renderPicker()
    setSupportPickerOpen(true)
    expect((await screen.findByRole('alert')).textContent).toMatch(/Electric Sheep request failed \(500\)\./)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('opens when the native menu asks for it', async () => {
    let openFromMenu: (() => void) | null = null
    mountBridge({
      onOpenSupportPicker: vi.fn((callback: () => void) => {
        openFromMenu = callback

        return () => undefined
      })
    })
    renderPicker()

    expect(screen.queryByRole('dialog')).toBeNull()
    openFromMenu!()
    expect(await screen.findByRole('dialog', { name: 'Switch support target' })).toBeTruthy()
  })
})

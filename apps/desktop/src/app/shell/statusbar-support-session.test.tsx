import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { TRANSLATIONS } from '@/i18n/catalog'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $statusbarVisible } from '@/store/statusbar-prefs'
import {
  $evaManagedStatus,
  $supportPickerOpen,
  runSupportSessionAction,
  setSupportPickerOpen
} from '@/store/support-picker'

import { supportSessionStatusbarItem, useStatusbarItems } from './hooks/use-statusbar-items'
import { TitlebarControls } from './titlebar-controls'

const active = {
  delegatedSupportActive: true,
  supportCustomerLabel: 'Customer',
  supportAgentLabel: 'Agent',
  supportExpiresAt: new Date(Date.now() + 60_000).toISOString()
} as never

const noStatusbarItems: never[] = []
const openAgents = vi.fn()
const openCommandCenterSection = vi.fn()
const requestGateway = vi.fn(async () => undefined as never)
const toggleCommandCenter = vi.fn()

afterEach(() => {
  cleanup()
  $evaManagedStatus.set(null)
  $statusbarVisible.set(true)
  setSupportPickerOpen(false)
  clearNotifications()
})

describe('support-session shell indicator', () => {
  it('is locked, links to Gateways, and runs the switch/end menu actions only while active', async () => {
    expect(supportSessionStatusbarItem(null, TRANSLATIONS.en.delegatedSupport).hidden).toBe(true)
    const endSupportSession = vi.fn().mockResolvedValue({ ok: true })
    const status = vi.fn().mockRejectedValue(new Error('status unavailable'))
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        eva: { status, switchSupportTarget: vi.fn().mockResolvedValue(active), endSupportSession }
      }
    })
    const item = supportSessionStatusbarItem(active, TRANSLATIONS.en.delegatedSupport)
    expect(item).toMatchObject({
      hidden: false,
      id: 'support-session',
      lockedVisible: true,
      to: '/settings?tab=gateway'
    })
    expect(item.menuItems?.[0]).toMatchObject({ to: '/settings?tab=gateway' })
    item.menuItems?.[1].onSelect?.()
    await waitFor(() => expect($supportPickerOpen.get()).toBe(true))
    expect(status).not.toHaveBeenCalled()
    item.menuItems?.[2].onSelect?.()
    await waitFor(() => expect(endSupportSession).toHaveBeenCalledOnce())
    endSupportSession.mockResolvedValueOnce({ ok: false })
    await expect(runSupportSessionAction('end')).rejects.toThrow()
  })

  it('renders exactly one titlebar fallback when the statusbar is hidden', async () => {
    $evaManagedStatus.set(active)
    $statusbarVisible.set(false)
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <I18nProvider configClient={null} initialLocale="en">
          <TitlebarControls onOpenSettings={() => {}} />
        </I18nProvider>
      </MemoryRouter>
    )
    expect(document.querySelectorAll('[data-support-session="titlebar"]')).toHaveLength(1)
    act(() => $statusbarVisible.set(true))
    await waitFor(() => expect(document.querySelectorAll('[data-support-session="titlebar"]')).toHaveLength(0))
  })

  it('puts the support-session item after command center and follows the shared store', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="en">
          {children}
        </I18nProvider>
      </MemoryRouter>
    )

    const { result } = renderHook(
      () =>
        useStatusbarItems({
          agentsOpen: false,
          chatOpen: true,
          commandCenterOpen: false,
          extraLeftItems: noStatusbarItems,
          extraRightItems: noStatusbarItems,
          freshDraftReady: true,
          gatewayState: 'open',
          inferenceStatus: null,
          openAgents,
          openCommandCenterSection,
          requestGateway,
          statusSnapshot: null,
          toggleCommandCenter
        }),
      { wrapper }
    )

    expect(result.current.leftStatusbarItems[0]?.id).toBe('command-center')
    expect(result.current.leftStatusbarItems[1]).toMatchObject({ hidden: true, id: 'support-session' })

    act(() => $evaManagedStatus.set(active))
    expect(result.current.leftStatusbarItems[1]).toMatchObject({ hidden: false, id: 'support-session' })
    expect(result.current.leftStatusbarItems[1]?.label).toContain('Customer')
  })

  it('falls back to the localized toast title when ending support is refused', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { eva: { endSupportSession: vi.fn().mockResolvedValue({ ok: false }) } }
    })
    const item = supportSessionStatusbarItem(active, TRANSLATIONS.ja.delegatedSupport)

    item.menuItems?.[2].onSelect?.()

    await waitFor(() => expect($notifications.get()).toHaveLength(1))
    expect($notifications.get()[0]).toMatchObject({
      message: TRANSLATIONS.ja.delegatedSupport.endFailed,
      title: TRANSLATIONS.ja.delegatedSupport.endFailed
    })
  })
})

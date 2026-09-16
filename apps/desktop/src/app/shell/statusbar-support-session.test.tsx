import { act, cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { TRANSLATIONS } from '@/i18n/catalog'
import { $statusbarVisible } from '@/store/statusbar-prefs'
import { $evaManagedStatus, $supportPickerOpen, setSupportPickerOpen } from '@/store/support-picker'

import { supportSessionStatusbarItem } from './hooks/use-statusbar-items'
import { TitlebarControls } from './titlebar-controls'

const active = { delegatedSupportActive: true, supportCustomerLabel: 'Customer', supportAgentLabel: 'Agent',
  supportExpiresAt: new Date(Date.now() + 60_000).toISOString() } as never

afterEach(() => {
  cleanup()
  $evaManagedStatus.set(null)
  $statusbarVisible.set(true)
  setSupportPickerOpen(false)
})

describe('support-session shell indicator', () => {
  it('is locked, links to Gateways, and runs the switch/end menu actions only while active', async () => {
    expect(supportSessionStatusbarItem(null, TRANSLATIONS.en.delegatedSupport).hidden).toBe(true)
    const endSupportSession = vi.fn().mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        eva: {
          status: vi.fn().mockResolvedValue(active),
          switchSupportTarget: vi.fn().mockResolvedValue(active),
          endSupportSession
        }
      }
    })
    const item = supportSessionStatusbarItem(active, TRANSLATIONS.en.delegatedSupport)
    expect(item).toMatchObject({ hidden: false, id: 'support-session', lockedVisible: true, to: '/settings?tab=gateway' })
    item.menuItems?.[0].onSelect?.()
    await waitFor(() => expect($supportPickerOpen.get()).toBe(true))
    item.menuItems?.[1].onSelect?.()
    await waitFor(() => expect(endSupportSession).toHaveBeenCalledOnce())
  })

  it('renders exactly one titlebar fallback when the statusbar is hidden', async () => {
    $evaManagedStatus.set(active)
    $statusbarVisible.set(false)
    render(
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="en">
          <TitlebarControls onOpenSettings={() => {}} />
        </I18nProvider>
      </MemoryRouter>
    )
    expect(document.querySelectorAll('[data-support-session="titlebar"]')).toHaveLength(1)
    act(() => $statusbarVisible.set(true))
    await waitFor(() => expect(document.querySelectorAll('[data-support-session="titlebar"]')).toHaveLength(0))
  })
})

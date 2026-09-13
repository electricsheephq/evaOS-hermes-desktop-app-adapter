import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  $desktopOnboarding,
  clearPendingProviderOAuth,
  type DesktopOnboardingState,
  startManualProviderOAuth
} from '@/store/onboarding'

const idleOnboarding: DesktopOnboardingState = {
  configured: true,
  firstRunSkipped: false,
  flow: { status: 'idle' },
  localEndpoint: false,
  manual: false,
  mode: 'oauth',
  providers: [],
  reason: null,
  requested: false
}

function resolvedZIndex(element: Element): number {
  const style = getComputedStyle(element)
  let value = style.zIndex.trim()
  const seen = new Set<string>()

  while (value.startsWith('var(')) {
    const name = value.match(/^var\((--[^,)]+)/)?.[1]

    if (!name || seen.has(name)) {
      throw new Error(`Could not resolve z-index ${style.zIndex}`)
    }

    seen.add(name)
    value = style.getPropertyValue(name).trim()
  }

  return Number(value)
}

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  document.body.style.setProperty('--z-setup-route', '10')
  document.body.style.setProperty('--z-popover', '20')
  document.body.style.setProperty('--z-onboarding', '30')
  document.body.style.setProperty('--z-onboarding-popover', '40')

  const style = document.createElement('style')
  style.dataset.testid = 'layer-utilities'
  style.textContent = `
    [class~="z-(--z-setup-route)"] { z-index: var(--z-setup-route); }
    [class~="z-(--z-popover)"] { z-index: var(--z-popover); }
    [class~="z-(--z-onboarding)"] { z-index: var(--z-onboarding); }
  `
  document.head.append(style)
})

afterEach(() => {
  cleanup()
  document.querySelector('[data-testid="layer-utilities"]')?.remove()
  document.body.style.removeProperty('--z-setup-route')
  document.body.style.removeProperty('--z-popover')
  document.body.style.removeProperty('--z-onboarding')
  document.body.style.removeProperty('--z-onboarding-popover')
  clearPendingProviderOAuth()
  $desktopOnboarding.set(idleOnboarding)
})

describe('Settings recovery layering', () => {
  it('shows manual provider onboarding above elevated Settings', async () => {
    render(
      <>
        <div className="settings-overlay-elevated z-(--z-setup-route)" data-testid="settings">
          <button onClick={() => startManualProviderOAuth('missing-provider')} type="button">
            Start provider OAuth
          </button>
        </div>
        <DesktopOnboardingOverlay enabled={false} profile="default" requestGateway={async () => undefined as never} />
      </>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start provider OAuth' }))

    await waitFor(() => {
      const onboarding = document.querySelector('[data-glass-opaque]')

      expect(onboarding).toBeTruthy()
      expect(resolvedZIndex(onboarding as Element)).toBeGreaterThan(resolvedZIndex(screen.getByTestId('settings')))
      expect(Number(getComputedStyle(document.body).getPropertyValue('--z-onboarding-popover'))).toBeGreaterThan(
        resolvedZIndex(onboarding as Element)
      )
    })
  })

  it('keeps a body-portaled popover above elevated Settings', () => {
    render(
      <>
        <div className="settings-overlay-elevated z-(--z-setup-route)" data-testid="settings" />
        <Popover open>
          <PopoverTrigger>Open search</PopoverTrigger>
          <PopoverContent>Search results</PopoverContent>
        </Popover>
      </>
    )

    const popover = screen.getByText('Search results').closest('[data-slot="popover-content"]')

    expect(popover).toBeTruthy()
    expect(resolvedZIndex(popover as Element)).toBeGreaterThan(resolvedZIndex(screen.getByTestId('settings')))
  })
})

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { StatusbarControls } from '@/app/shell/statusbar-controls'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

const openExternal = vi.fn().mockResolvedValue(undefined)
const windowOpen = vi.fn()
const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop
const initialWindowOpen = window.open

beforeAll(() => {
  stubResizeObserver()
  stubMenuDomApis()
})

beforeEach(() => {
  desktopWindow.hermesDesktop = { openExternal } as unknown as Window['hermesDesktop']
  window.open = windowOpen
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()

  if (initialHermesDesktop) {
    desktopWindow.hermesDesktop = initialHermesDesktop
  } else {
    delete desktopWindow.hermesDesktop
  }
  window.open = initialWindowOpen
})

function renderStatusbar() {
  const directUrl = 'https://example.com/statusbar/direct'
  const menuUrl = 'https://example.com/statusbar/menu'

  render(
    <MemoryRouter>
      <StatusbarControls
        items={[
          { href: directUrl, id: 'direct-docs', label: 'Direct docs', title: 'Direct docs', variant: 'link' },
          {
            id: 'docs-menu',
            label: 'Docs menu',
            menuItems: [{ href: menuUrl, id: 'menu-docs', label: 'Menu docs' }],
            title: 'Docs menu',
            variant: 'menu'
          }
        ]}
      />
    </MemoryRouter>
  )

  return { directUrl, menuUrl }
}

describe('statusbar external links', () => {
  it('routes a direct statusbar link through the Desktop external opener', () => {
    const { directUrl } = renderStatusbar()
    const link = screen.getByRole('link', { name: 'Direct docs' })

    expect(link.getAttribute('href')).toBe(directUrl)
    expect(link.getAttribute('rel')).toBe('noreferrer')
    fireEvent.click(link)

    expect(openExternal).toHaveBeenCalledWith(directUrl)
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('routes a statusbar menu link through the Desktop external opener', async () => {
    const { menuUrl } = renderStatusbar()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Docs menu' }), { button: 0, pointerType: 'mouse' })
    const link = await screen.findByRole('link', { name: 'Menu docs' })

    expect(link.getAttribute('href')).toBe(menuUrl)
    expect(link.getAttribute('rel')).toBe('noreferrer')
    fireEvent.click(link)

    expect(openExternal).toHaveBeenCalledWith(menuUrl)
    expect(windowOpen).not.toHaveBeenCalled()
  })
})

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocsLink } from './flow'

const openExternal = vi.fn().mockResolvedValue(undefined)
const windowOpen = vi.fn()
const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop
const initialWindowOpen = window.open

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

describe('DocsLink', () => {
  it('routes onboarding docs through the Desktop external opener', () => {
    const href = 'https://example.com/onboarding/docs'
    render(<DocsLink href={href}>Provider docs</DocsLink>)

    const link = screen.getByRole('link', { name: /Provider docs/ })
    expect(link.getAttribute('href')).toBe(href)
    expect(link.getAttribute('rel')).toBe('noreferrer')
    fireEvent.click(link)

    expect(openExternal).toHaveBeenCalledWith(href)
    expect(windowOpen).not.toHaveBeenCalled()
  })
})

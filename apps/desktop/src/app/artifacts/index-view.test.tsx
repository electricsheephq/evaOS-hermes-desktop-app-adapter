import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { getAllSessionMessages, listAllProfileSessions } from '@/hermes'
import { en } from '@/i18n/en'
import type { SessionInfo, SessionMessagesResponse } from '@/types/hermes'

import { ArtifactsView } from './index'

vi.mock('@/hermes', () => ({ getAllSessionMessages: vi.fn(), listAllProfileSessions: vi.fn() }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: en }) }))
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../hooks/use-refresh-hotkey', () => ({ useRefreshHotkey: vi.fn() }))
vi.mock('../hooks/use-route-enum-param', () => ({ useRouteEnumParam: () => ['all', vi.fn()] }))
vi.mock('../open-session', () => ({ openSession: vi.fn() }))
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => children }))
vi.mock('../page-search-shell', () => ({
  PageSearchShell: ({ children, searchTrailingAction }: { children: ReactNode; searchTrailingAction: ReactNode }) => (
    <section>
      {searchTrailingAction}
      {children}
    </section>
  )
}))

const sessions = ['first', 'second'].map(id => ({
  id,
  title: id,
  last_active: 1000,
  started_at: 1000,
  message_count: 1
})) as SessionInfo[]

function messages(name: string): SessionMessagesResponse {
  return { session_id: name, messages: [{ role: 'assistant', content: `[${name}](/tmp/${name})`, timestamp: 1000 }] }
}

function pendingMessages() {
  let resolve!: (value: ReturnType<typeof messages>) => void

  const promise = new Promise<ReturnType<typeof messages>>(done => {
    resolve = done
  })

  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listAllProfileSessions).mockResolvedValue({ sessions, total: 2, limit: 30, offset: 0 })
})
afterEach(cleanup)

it('keeps progress visible after partial artifacts render', async () => {
  const pending = pendingMessages()
  vi.mocked(getAllSessionMessages).mockResolvedValueOnce(messages('first.txt')).mockReturnValueOnce(pending.promise)
  render(<ArtifactsView />)
  await screen.findByText('first.txt')

  expect(screen.queryByRole('status')?.textContent).toContain('(1/2)')
  await act(async () => {
    pending.resolve(messages('second.txt'))
  })
  expect(screen.queryByRole('status')).toBeNull()
})

it('keeps the complete previous index visible until a refresh finishes', async () => {
  const pending = pendingMessages()
  vi.mocked(getAllSessionMessages)
    .mockResolvedValueOnce(messages('first.txt'))
    .mockResolvedValueOnce(messages('second.txt'))
    .mockResolvedValueOnce(messages('first.txt'))
    .mockReturnValueOnce(pending.promise)
  render(<ArtifactsView />)
  await screen.findByText('second.txt')
  fireEvent.click(screen.getByRole('button', { name: en.artifacts.refresh }))
  await waitFor(() => expect(getAllSessionMessages).toHaveBeenCalledTimes(4))

  expect(screen.queryByText('second.txt')).not.toBeNull()
  await act(async () => {
    pending.resolve(messages('second.txt'))
  })
})

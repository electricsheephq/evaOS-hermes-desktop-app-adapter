/**
 * Managed-product E2E smoke.
 *
 * Unlike upstream's local-backend fixtures, evaOS Agent is remote-only. This
 * test launches the real built Electron main/renderer without enrollment and
 * proves it stays on the Electric Sheep sign-in boundary.
 */

import { type ManagedSignedOutFixture, setupManagedSignedOut } from './fixtures'
import { expect, test } from './test'

let fixture: ManagedSignedOutFixture | null = null

test.beforeAll(async () => {
  fixture = await setupManagedSignedOut()
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test.describe('managed signed-out boot', () => {
  test('uses the evaOS Agent product identity', async () => {
    await expect(fixture!.page).toHaveTitle('evaOS Agent')
  })

  test('requires Electric Sheep enrollment without local-backend fallback', async () => {
    const page = fixture!.page

    await expect(page.getByRole('heading', { name: 'Managed by Electric Sheep' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in to evaOS Agent' })).toBeVisible()

    const status = await page.evaluate(() => {
      const desktop = Reflect.get(window, 'hermesDesktop') as {
        eva: { status: () => Promise<Record<string, unknown>> }
      }

      return desktop.eva.status()
    })

    expect(status).toMatchObject({
      managed: true,
      productName: 'evaOS Agent',
      desktopSessionActive: false,
      runtimeSessionActive: false,
      customerId: null,
      agentId: null,
      updateChannel: 'managed-beta'
    })
  })

  test('the real preload denies unenrolled, wrong-owner and local-terminal requests', async () => {
    const errors = await fixture!.page.evaluate(async () => {
      const desktop = Reflect.get(window, 'hermesDesktop') as {
        getConnection: (profile?: string) => Promise<unknown>
        getConnectionFor: (payload: { connectionId: string; profile: string }) => Promise<unknown>
        openSessionInTerminal: (sessionId: string) => Promise<unknown>
      }

      const rejection = async (request: () => Promise<unknown>) => {
        try {
          await request()

          return 'unexpected success'
        } catch (error) {
          return String(error)
        }
      }

      return {
        unenrolled: await rejection(() => desktop.getConnection()),
        wrongOwner: await rejection(() =>
          desktop.getConnectionFor({ connectionId: 'synthetic-workstation', profile: 'synthetic-owner' })
        ),
        terminal: await rejection(() => desktop.openSessionInTerminal('synthetic-session'))
      }
    })

    expect(errors.unenrolled).toContain('Sign in to evaOS Agent from Settings.')
    expect(errors.wrongOwner).toContain('outside the managed runtime route')
    expect(errors.terminal).toContain('Terminal access is unavailable for this managed remote agent.')
  })

  test('support End receives a real click above the managed boot failure', async () => {
    // Only the isolated fixture's IPC authority is synthetic. Keep the real
    // renderer, preload, failure overlay and CSS so Playwright hit-tests End.
    await fixture!.app.evaluate(({ ipcMain }) => {
      let active = true
      const expiresAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString()

      ipcMain.removeHandler('hermes:eva:status')
      ipcMain.handle('hermes:eva:status', () => ({
        managed: true,
        productName: 'evaOS Agent',
        signedOut: false,
        desktopSessionActive: true,
        desktopSessionExpiresAt: expiresAt,
        runtimeSessionActive: false,
        runtimeSessionExpiresAt: null,
        customerId: null,
        agentId: null,
        updateChannel: 'managed-beta',
        delegatedSupportActive: active,
        sessionKind: active ? 'delegated_support' : 'ordinary',
        supportCustomerLabel: 'Test customer',
        supportAgentLabel: 'Test agent',
        supportExpiresAt: expiresAt,
        supportDeadline: expiresAt
      }))
      ipcMain.removeHandler('hermes:eva:support:end')
      ipcMain.handle('hermes:eva:support:end', () => {
        active = false

        return { ok: true }
      })
    })

    const page = fixture!.page
    const banner = page.getByRole('region', { name: 'Acting for Test customer' })

    await expect(page.getByRole('button', { name: 'Sign in to evaOS Agent', exact: true })).toBeVisible()
    await expect(banner).toBeVisible()
    // Do not force the click: it must fail if the real boot overlay covers it.
    await banner.getByRole('button', { name: 'End support session', exact: true }).click()
    await expect(banner).toBeHidden()
    await expect(page.getByRole('button', { name: 'Sign in to evaOS Agent', exact: true })).toBeVisible()
  })
})

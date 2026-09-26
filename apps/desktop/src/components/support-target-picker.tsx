import { useStore } from '@nanostores/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { EvaSupportClient, EvaSupportFlowFailure, EvaSupportTarget } from '@/global'
import { useI18n } from '@/i18n'
import { $supportPickerOpen, setSupportPickerOpen } from '@/store/support-picker'

// Picker session state. Every broker outcome the main process types
// (`needs_sign_in` / `forbidden` / `conflict` / `error`) is a state here, never
// a thrown IPC error: the only thing the renderer can do with a rejection is
// show the operator the one move that is left.
type PickerState =
  | { kind: 'loading' }
  | { kind: 'ready'; clients: EvaSupportClient[]; isAdmin: boolean }
  | { kind: 'needs_sign_in' }
  | { kind: 'signing_in' }
  | { kind: 'forbidden'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'cleanup_pending'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'starting' }
  | { kind: 'started' }

function failureState(failure: EvaSupportFlowFailure): PickerState {
  switch (failure.reason) {
    case 'needs_sign_in':
      return { kind: 'needs_sign_in' }

    case 'forbidden':
      return { kind: 'forbidden', message: failure.message }

    case 'conflict':
      return { kind: 'conflict', message: failure.message }

    case 'cleanup_pending':
      return { kind: 'cleanup_pending', message: failure.message }

    default:
      return { kind: 'error', message: failure.message }
  }
}

const SELECT_CLASS =
  'mt-1 w-full rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-1.5 text-sm text-(--ui-text-primary) disabled:opacity-50'

// The in-app support target picker (sc#540): account → agent (or all
// authorized agents for admins) → consent → start. Consent text and the
// payload shape mirror the dashboard's DesktopSupportTargetPicker so the two
// pickers stay comparable; the create → claim → launch chain runs in the main
// process on the desktop session and this window reloads when it lands.
// Rendered above the boot-failure overlay on purpose: the state an internal
// admin boots into IS a failed boot, and this is the way out of it.
export function SupportTargetPickerOverlay() {
  const open = useStore($supportPickerOpen)
  const { t } = useI18n()
  const copy = t.supportPicker
  const [state, setState] = useState<PickerState>({ kind: 'loading' })
  const [accountId, setAccountId] = useState('')
  const [profileId, setProfileId] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [ending, setEnding] = useState(false)

  // The native menu item asks the app root to open the picker once the main
  // process has a session for it.
  useEffect(() => {
    const subscribe = window.hermesDesktop?.eva?.onOpenSupportPicker

    if (!subscribe) {
      return
    }

    return subscribe(() => setSupportPickerOpen(true))
  }, [])

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    setAccountId('')
    setProfileId('')
    setAcknowledged(false)

    const list = window.hermesDesktop?.eva?.listSupportTargets

    if (!list) {
      setState({ kind: 'error', message: t.delegatedSupport.unavailable })

      return
    }

    try {
      const result = await list()

      if (result.ok) {
        setState({ kind: 'ready', clients: result.clients, isAdmin: result.is_admin })
      } else {
        setState(failureState(result))
      }
    } catch {
      setState({ kind: 'error', message: copy.loadFailed })
    }
  }, [copy.loadFailed, t.delegatedSupport.unavailable])

  useEffect(() => {
    if (open) {
      void load()
    }
  }, [load, open])

  const clients = state.kind === 'ready' ? state.clients : []
  const allAgentsAvailable = state.kind === 'ready' && state.isAdmin
  const client = clients.find(row => row.customer_account_id === accountId)
  const profile = client?.profiles.find(row => row.profile_id === profileId)
  const allAgents = allAgentsAvailable && profileId === '' && Boolean(client?.profiles.length)
  const canStart = Boolean(client) && (Boolean(profile) || allAgents) && acknowledged

  const start = async () => {
    if (!client || !canStart) {
      return
    }

    // `canStart` already holds one of the two: a chosen agent, or the admin's
    // all-agents scope, which carries no profile at all.
    const target: EvaSupportTarget = profile
      ? {
          customer_account_id: client.customer_account_id,
          customer_vm_id: client.customer_vm_id,
          profile_id: profile.profile_id,
          acknowledged: true,
          customer_label: client.display_name,
          agent_label: profile.display_name
        }
      : {
          customer_account_id: client.customer_account_id,
          customer_vm_id: client.customer_vm_id,
          profile_scope: 'customer',
          acknowledged: true,
          customer_label: client.display_name
        }

    setState({ kind: 'starting' })

    try {
      const result = await window.hermesDesktop.eva.startSupport(target)

      if (result.ok) {
        // The main process isolates and reloads this window as part of the
        // claim; this state only covers the gap until that reload lands.
        setState({ kind: 'started' })
      } else {
        setState(failureState(result))
      }
    } catch {
      setState({ kind: 'error', message: copy.loadFailed })
    }
  }

  // A 401 on the session in hand means "sign in again" and, until the broker
  // update is deployed, "update required"; either way the only move is a fresh
  // PLAIN sign-in, so the switch is forced past its live-session shortcut.
  const signIn = async () => {
    setState({ kind: 'signing_in' })

    try {
      await window.hermesDesktop.eva.switchSupportTarget({ signInAgain: true })
      await load()
    } catch {
      setState({ kind: 'needs_sign_in' })
    }
  }

  const endSupport = async () => {
    setEnding(true)

    try {
      await window.hermesDesktop.eva.endSupportSession()
    } catch {
      // The main process keeps its own retry state; the operator can try again.
    } finally {
      setEnding(false)
    }
  }

  const busy = state.kind === 'starting' || state.kind === 'started' || state.kind === 'signing_in'

  let body

  switch (state.kind) {
    case 'loading':
      body = <p role="status">{copy.loading}</p>

      break

    case 'signing_in':
      body = <p role="status">{copy.signingIn}</p>

      break

    case 'starting':
      body = <p role="status">{copy.starting}</p>

      break

    case 'started':
      body = <p role="status">{copy.started}</p>

      break

    case 'needs_sign_in':
      body = (
        <div className="space-y-3" role="alert">
          <p>{copy.signInRequired}</p>
          <Button onClick={() => void signIn()} type="button">
            {copy.signIn}
          </Button>
        </div>
      )

      break

    case 'forbidden':
      body = <p role="alert">{state.message || copy.forbidden}</p>

      break

    // Both states own the same way out: End the lease this app can still reach
    // (the conflict path ends any local handle too), then try again.
    case 'conflict':

    case 'cleanup_pending':
      body = (
        <div className="space-y-3" role="alert">
          <p>{state.message || (state.kind === 'conflict' ? copy.conflict : copy.cleanupPending)}</p>
          <div className="flex gap-2">
            <Button disabled={ending} onClick={() => void endSupport()} type="button" variant="destructive">
              {ending ? copy.endingSupport : copy.endSupport}
            </Button>
            <Button onClick={() => void load()} type="button" variant="outline">
              {copy.tryAgain}
            </Button>
          </div>
        </div>
      )

      break

    case 'error':
      body = (
        <div className="space-y-3" role="alert">
          <p>{state.message || copy.loadFailed}</p>
          <Button onClick={() => void load()} type="button" variant="outline">
            {copy.retry}
          </Button>
        </div>
      )

      break

    case 'ready':
      body =
        clients.length === 0 ? (
          <p role="status">{copy.empty}</p>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm">
              {copy.customerAccount}
              <select
                className={SELECT_CLASS}
                onChange={event => {
                  setAccountId(event.target.value)
                  setProfileId('')
                  setAcknowledged(false)
                }}
                value={accountId}
              >
                <option value="">{copy.chooseCustomer}</option>
                {clients.map(row => (
                  <option key={row.customer_account_id} value={row.customer_account_id}>
                    {row.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              {copy.agent}
              <select
                className={SELECT_CLASS}
                disabled={!client}
                onChange={event => {
                  setProfileId(event.target.value)
                  setAcknowledged(false)
                }}
                value={profileId}
              >
                <option value="">{allAgentsAvailable ? copy.allAgents : copy.chooseAgent}</option>
                {client?.profiles.map(row => (
                  <option key={row.profile_id} value={row.profile_id}>
                    {row.display_name} ({row.profile_id})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                checked={acknowledged}
                className="mt-0.5"
                disabled={!profile && !allAgents}
                onChange={event => setAcknowledged(event.target.checked)}
                type="checkbox"
              />
              <span>{copy.consent}</span>
            </label>
            <Button className="w-full" disabled={!canStart} onClick={() => void start()} type="button">
              {copy.start}
            </Button>
          </div>
        )

      break
  }

  return (
    <DialogPrimitive.Root onOpenChange={next => !busy && setSupportPickerOpen(next)} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-(--z-support-session) bg-black/22 backdrop-blur-[0.125rem]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-(--z-support-session) flex max-h-[85vh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-chat-bubble-background) p-5 text-sm text-(--ui-text-primary) shadow-lg"
        >
          <DialogPrimitive.Title className="text-base font-semibold">{copy.title}</DialogPrimitive.Title>
          <div className="space-y-1">
            <p className="font-medium">{copy.intro}</p>
            <p className="text-(--ui-text-secondary)">{copy.policy}</p>
          </div>
          {body}
          <div className="flex justify-end">
            <Button disabled={busy} onClick={() => setSupportPickerOpen(false)} size="sm" type="button" variant="ghost">
              {copy.close}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

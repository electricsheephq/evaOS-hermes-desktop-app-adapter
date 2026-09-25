import { writeAgentTerminalChunk } from '@/app/right-sidebar/terminal/agent-terminal-stream'
import { closeAgentTerminalByProc } from '@/app/right-sidebar/terminal/terminals'
<<<<<<< HEAD
import type { PreviewActAction } from '@/lib/preview-act/act-in-page'
import type { TourAction, TourStep } from '@/lib/tour'
import { requestGatewayForAgent } from '@/store/gateway'
||||||| 939e45c91d
import type { PreviewActAction } from '@/lib/preview-act/act-in-page'
import type { TourAction, TourStep } from '@/lib/tour'
import { $gateway } from '@/store/gateway'
=======
>>>>>>> f97608f178
import { applyDesktopLayoutPreset, revealDesktopPane } from '@/store/pane-focus'
import { captureActivePreviewSurface, ownsActivePreviewSurface } from '@/store/preview'
import { recordAgentReaction } from '@/store/reactions-local'
import { setMessages } from '@/store/session'
import { $tipsEnabled, type ActiveTip, agentTipId, showTip } from '@/store/tips'

import type { GatewayEventContext } from './types'

/** Desktop-surface bridge events: agent terminal streaming, tips, pane
 *  reveal, layouts and message reactions. The read-back REQUESTS the agent
 *  blocks on (terminal/preview/window/tour) live in `server-requests.ts`. */
export function handleDesktopBridgeEvent(ctx: GatewayEventContext): boolean {
<<<<<<< HEAD
  const { event, payload, explicitSid, isActiveEvent } = ctx

  // Runtime session ids are only unique within a gateway source. Requiring
  // both the routed id and the composite (connection, profile) owner keeps a
  // same-id background source from reading or driving the visible surface.
  // Re-read both values after every async boundary: the user can switch the
  // foreground chat while a webview read, IPC call, or lazy import is pending.
  const ownsActiveSurfaceNow = () =>
    Boolean(ctx.sessionId && ctx.sessionId === ctx.deps.activeSessionIdRef.current && ctx.fromActiveSource())

  const ownsActiveSurface = ownsActiveSurfaceNow()

  const respondToSource = (method: string, params: Record<string, unknown>) =>
    requestGatewayForAgent(
      event.connectionId ?? null,
      event.profile || ctx.deps.activeGatewayProfile,
      method,
      params
    ).catch(() => undefined)

  if (event.type === 'terminal.read.request') {
    // read_terminal tool: serialize the renderer's xterm buffer and answer
    // immediately (Python blocks on the respond). Empty text = no live pane.
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

    if (requestId) {
      const start = typeof payload?.start === 'number' ? payload.start : undefined
      const count = typeof payload?.count === 'number' ? payload.count : undefined
      const result = ownsActiveSurface ? readActiveTerminal({ start, count }) : null

      void respondToSource('terminal.read.respond', {
        request_id: requestId,
        text: result ? JSON.stringify(result) : ''
      })
    }

    return true
  }

  if (event.type === 'preview.read.request') {
    // read_preview tool: serialize the active preview tab (a Browser
    // webview's page text is async) and answer. Empty text = nothing open.
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

    if (requestId) {
      const start = typeof payload?.start === 'number' ? payload.start : undefined
      const count = typeof payload?.count === 'number' ? payload.count : undefined

      if (!ownsActiveSurface) {
        void respondToSource('preview.read.respond', { request_id: requestId, text: '' })
      } else {
        void readActivePreview({ count, shouldNudge: ownsActiveSurfaceNow, start }).then(result => {
          const ownedResult = ownsActiveSurfaceNow() ? result : null

          void respondToSource('preview.read.respond', {
            request_id: requestId,
            text: ownedResult ? JSON.stringify(ownedResult) : ''
          })
        })
      }
    }

    return true
  }

  if (event.type === 'preview.act.request') {
    // drive_preview tool: click/type/scroll/press inside the guest page, or
    // drive the pane's history. Dynamic import keeps the injected engine off
    // the boot path. Active session only: a background turn must never reach
    // into the page the user is working in (desktop AGENTS.md: offer, don't
    // hijack).
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

    if (requestId) {
      // Only the renderer that owns an explicitly scoped request may answer;
      // another window's refusal must not race the owning window's result.
      if (explicitSid && !isActiveEvent) {
        return true
      }

      const denied = {
        error: 'The in-app browser only takes actions in the session the user is looking at.',
        success: false
      }

      const answer = (result: unknown) =>
        respondToSource('preview.act.respond', {
          request_id: requestId,
          text: result ? JSON.stringify(result) : ''
        })

      if (ownsActiveSurface) {
        void loadPreviewEngine()
          .then(run =>
            ownsActiveSurfaceNow()
              ? run(
                  {
                    amount: payload?.amount,
                    key: payload?.key,
                    kind: payload?.action ?? '',
                    max: payload?.max,
                    ref: payload?.ref,
                    selector: payload?.selector,
                    submit: payload?.submit,
                    text: payload?.text,
                    to: payload?.to as PreviewActAction['to']
                  },
                  ownsActiveSurfaceNow
                )
              : denied
          )
          .then(
            result => answer(ownsActiveSurfaceNow() ? result : denied),
            error =>
              answer(
                ownsActiveSurfaceNow()
                  ? { error: error instanceof Error ? error.message : String(error), success: false }
                  : denied
              )
          )
      } else {
        void answer(denied)
      }
    }

    return true
  }

  if (event.type === 'window.read.request') {
    // read_window_below tool: main owns native window enumeration, so ask
    // it over IPC and answer. Empty text = unavailable (no bridge, or
    // enumeration unsupported on this system e.g. Wayland).
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

    if (requestId) {
      const read = window.hermesDesktop?.readWindowBelow

      const answer = (result: unknown) =>
        respondToSource('window.read.respond', {
          request_id: requestId,
          text: result ? JSON.stringify(result) : ''
        })

      // .catch: ipcRenderer.invoke rejects on an older shell without the
      // handler or a main-side throw — without an empty answer the tool
      // would stall its full 30s timeout.
      void Promise.resolve(ownsActiveSurface && read ? read() : null).then(
        result => answer(ownsActiveSurfaceNow() ? result : null),
        () => answer(null)
      )
    }

    return true
  }
||||||| 939e45c91d
  const { event, payload, explicitSid, isActiveEvent } = ctx

  if (event.type === 'terminal.read.request') {
    // read_terminal tool: serialize the renderer's xterm buffer and answer
    // immediately (Python blocks on the respond). Empty text = no live pane.
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

    if (requestId) {
      const start = typeof payload?.start === 'number' ? payload.start : undefined
      const count = typeof payload?.count === 'number' ? payload.count : undefined
      const result = readActiveTerminal({ start, count })

      void $gateway.get()?.request('terminal.read.respond', {
        request_id: requestId,
        text: result ? JSON.stringify(result) : ''
      })
    }

    return true
  }

  if (event.type === 'preview.read.request') {
    // read_preview tool: serialize the active preview tab (a Browser
    // webview's page text is async) and answer. Empty text = nothing open.
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

    if (requestId) {
      const start = typeof payload?.start === 'number' ? payload.start : undefined
      const count = typeof payload?.count === 'number' ? payload.count : undefined

      void readActivePreview({ count, start }).then(result => {
        void $gateway.get()?.request('preview.read.respond', {
          request_id: requestId,
          text: result ? JSON.stringify(result) : ''
        })
      })
    }

    return true
  }

  if (event.type === 'preview.act.request') {
    // drive_preview tool: click/type/scroll/press inside the guest page, or
    // drive the pane's history. Dynamic import keeps the injected engine off
    // the boot path. Active session only: a background turn must never reach
    // into the page the user is working in (desktop AGENTS.md: offer, don't
    // hijack).
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

    if (requestId) {
      // Every mounted desktop window can observe the same gateway event. A
      // scoped mismatch belongs to another window, so answering here would race
      // the owning window and could make this refusal win before its real result.
      if (explicitSid && !isActiveEvent) {
        return true
      }

      const answer = (result: unknown) =>
        $gateway.get()?.request('preview.act.respond', {
          request_id: requestId,
          text: result ? JSON.stringify(result) : ''
        })

      if (isActiveEvent) {
        void loadPreviewEngine()
          .then(run =>
            run({
              amount: payload?.amount,
              key: payload?.key,
              kind: payload?.action ?? '',
              max: payload?.max,
              ref: payload?.ref,
              selector: payload?.selector,
              submit: payload?.submit,
              text: payload?.text,
              to: payload?.to as PreviewActAction['to']
            })
          )
          .then(answer, error =>
            answer({ error: error instanceof Error ? error.message : String(error), success: false })
          )
      } else {
        void answer({
          error: 'The in-app browser only takes actions in the session the user is looking at.',
          success: false
        })
      }
    }

    return true
  }

  if (event.type === 'window.read.request') {
    // read_window_below tool: main owns native window enumeration, so ask
    // it over IPC and answer. Empty text = unavailable (no bridge, or
    // enumeration unsupported on this system e.g. Wayland).
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

    if (requestId) {
      const read = window.hermesDesktop?.readWindowBelow

      const answer = (result: unknown) =>
        $gateway.get()?.request('window.read.respond', {
          request_id: requestId,
          text: result ? JSON.stringify(result) : ''
        })

      // .catch: ipcRenderer.invoke rejects on an older shell without the
      // handler or a main-side throw — without an empty answer the tool
      // would stall its full 30s timeout.
      void Promise.resolve(read ? read() : null).then(answer, () => answer(null))
    }

    return true
  }
=======
  const { event, payload, isActiveEvent } = ctx
>>>>>>> f97608f178

  if (event.type === 'agent.terminal.output') {
    // Live chunk from a background process → its read-only agent terminal tab.
    writeAgentTerminalChunk(payload?.process_id ?? '', payload?.chunk ?? '')

    return true
  }

  if (event.type === 'terminal.close') {
    // Agent closed its own read-only tab via the desktop-gated close_terminal tool.
    // The process is untouched — this only drops the view.
    closeAgentTerminalByProc(payload?.process_id ?? '')

    return true
  }

<<<<<<< HEAD
  if (event.type === 'tour.request') {
    // tour tool: run one guided-tour action (highlight/step/discover) via
    // driver.js — on the app's own DOM or inside the preview pane's guest
    // page — and answer with the outcome. Dynamic import keeps driver.js
    // and the preview injection payload off the boot path. Active session
    // only: a background turn must never paint overlays on the user's
    // screen (desktop AGENTS.md: offer, don't hijack).
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

    if (requestId) {
      // As with preview actions, inactive windows stay silent for explicitly
      // scoped requests so their refusal cannot beat the owning renderer.
      if (explicitSid && !isActiveEvent) {
        return true
      }

      const denied = {
        error: 'Tours only run in the session the user is looking at.',
        success: false
      }

      const tourSurface = payload?.surface === 'preview' ? 'preview' : 'app'
      const previewSurface = tourSurface === 'preview' ? captureActivePreviewSurface() : null

      // Retain the exact visible document across the lazy module import:
      // session/source ownership alone would allow A→B (or A→B→A) to paint
      // the wrong Preview page.
      const ownsTourSurfaceNow = () =>
        ownsActiveSurfaceNow() &&
        (tourSurface === 'app' ||
          (previewSurface ? ownsActivePreviewSurface(previewSurface) : captureActivePreviewSurface() === null))
      const answer = (result: unknown) =>
        respondToSource('tour.respond', {
          request_id: requestId,
          text: result ? JSON.stringify(result) : ''
        })

      if (!$toursEnabled.get()) {
        // Refused in words, not silently dropped: the agent asked for a
        // walkthrough it isn't getting, and a no-op would leave it narrating
        // a spotlight the user can't see.
        void answer({ error: 'The user has turned guided tours off.', success: false })
      } else if (ownsActiveSurface) {
        void import('@/lib/tour')
          .then(({ runTour }) =>
            ownsTourSurfaceNow()
              ? runTour(
                  {
                    kind: (payload?.action ?? 'stop') as TourAction['kind'],
                    selector: payload?.selector,
                    side: payload?.side as TourStep['side'],
                    startAt: payload?.step_index,
                    steps: payload?.steps as TourStep[] | undefined,
                    text: payload?.text,
                    title: payload?.title
                  },
                  tourSurface
                )
              : denied
          )
          .then(
            result => answer(ownsTourSurfaceNow() ? result : denied),
            error =>
              answer(
                ownsTourSurfaceNow()
                  ? { error: error instanceof Error ? error.message : String(error), success: false }
                  : denied
              )
          )
      } else {
        void answer(denied)
      }
    }

    return true
  }

||||||| 939e45c91d
  if (event.type === 'tour.request') {
    // tour tool: run one guided-tour action (highlight/step/discover) via
    // driver.js — on the app's own DOM or inside the preview pane's guest
    // page — and answer with the outcome. Dynamic import keeps driver.js
    // and the preview injection payload off the boot path. Active session
    // only: a background turn must never paint overlays on the user's
    // screen (desktop AGENTS.md: offer, don't hijack).
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

    if (requestId) {
      // As with preview actions, only the renderer that owns an explicitly
      // scoped request may answer. Inactive windows must stay silent even when
      // tours are disabled locally, or their refusal can beat the owner.
      if (explicitSid && !isActiveEvent) {
        return true
      }

      const answer = (result: unknown) =>
        $gateway.get()?.request('tour.respond', {
          request_id: requestId,
          text: result ? JSON.stringify(result) : ''
        })

      if (!$toursEnabled.get()) {
        // Refused in words, not silently dropped: the agent asked for a
        // walkthrough it isn't getting, and a no-op would leave it narrating
        // a spotlight the user can't see.
        void answer({ error: 'The user has turned guided tours off.', success: false })
      } else if (isActiveEvent) {
        void import('@/lib/tour')
          .then(({ runTour }) =>
            runTour(
              {
                kind: (payload?.action ?? 'stop') as TourAction['kind'],
                selector: payload?.selector,
                side: payload?.side as TourStep['side'],
                startAt: payload?.step_index,
                steps: payload?.steps as TourStep[] | undefined,
                text: payload?.text,
                title: payload?.title
              },
              payload?.surface === 'preview' ? 'preview' : 'app'
            )
          )
          .then(answer, error =>
            answer({ error: error instanceof Error ? error.message : String(error), success: false })
          )
      } else {
        void answer({
          error: 'Tours only run in the session the user is looking at.',
          success: false
        })
      }
    }

    return true
  }

=======
>>>>>>> f97608f178
  if (event.type === 'tip.show') {
    // tip tool: point the accent bubble at something and say one line about
    // it. Fire-and-forget — a tip is not a question, and blocking the turn on
    // one would stall the sentence the agent is in the middle of, so there is
    // nothing to answer and a refusal is simply a bubble that never appears.
    // Active session only: a background turn must never paint on the user's
    // screen (desktop AGENTS.md: offer, don't hijack).
    const selector = typeof payload?.selector === 'string' ? payload.selector : ''
    const text = typeof payload?.text === 'string' ? payload.text : ''

    // A tip with nothing to point at is just a notification, and the app
    // already has those. Dropping it here also stops a malformed event from
    // replacing a rotation tip with a bubble that dismisses itself a frame
    // later.
    if ($tipsEnabled.get() && ownsActiveSurface && selector && text) {
      showTip({
        side: (payload?.side as ActiveTip['side']) ?? 'top',
        targets: [selector],
        text,
        tipId: agentTipId(selector, text),
        title: typeof payload?.title === 'string' ? payload.title : undefined
      })
    }

    return true
  }

  if (event.type === 'pane.reveal') {
    // Agent revealed a pane via the desktop-gated focus_pane tool, in
    // response to an explicit user request. Active session only — a
    // background turn must never move the user's focus (desktop AGENTS.md:
    // offer, don't hijack).
    if (ownsActiveSurface) {
      revealDesktopPane(payload?.pane ?? '')
    }

    return true
  }

  if (event.type === 'layout.apply') {
    // Agent applied a layout preset via the desktop-gated apply_layout
    // tool. Same contract as pane.reveal: active session only, and the
    // preset resolves against the SAME layouts registry the picker reads,
    // so core, plugin, and user presets are all addressable.
    if (ownsActiveSurface) {
      applyDesktopLayoutPreset(typeof payload?.preset === 'string' ? payload.preset : '')
    }

    return true
  }

  if (event.type === 'message.reaction') {
    // The agent reacted to a message via the desktop-gated
    // react_to_message tool. Already persisted — this only paints it now
    // instead of at the next resume. Fresh ChatMessage object per change:
    // the runtime repository caches normalized ThreadMessages in a WeakMap
    // keyed by ChatMessage identity.
    const reactedRowId = payload?.row_id

    if (ownsActiveSurface && typeof reactedRowId === 'number') {
      const nextReactions = Array.isArray(payload?.reactions) ? payload.reactions : []
      const reactedRole = payload?.role === 'assistant' ? 'assistant' : 'user'

      setMessages(messages => {
        // Preferred leg: the message already knows its durable row id
        // (rehydrated transcript, or a live row that has round-tripped).
        const byRowId = messages.find(message => message.rowId === reactedRowId)

        if (byRowId) {
          // Overlay survives the end-of-turn resume, which rebuilds from
          // in-memory history that doesn't carry this mid-turn DB write.
          recordAgentReaction(reactedRowId, nextReactions)

          return messages.map(message =>
            message.rowId === reactedRowId ? { ...message, reactions: nextReactions } : message
          )
        }

        // Live leg: the targeted message is still optimistic (no rowId —
        // it hasn't round-tripped through a resume). The agent's default
        // target is the newest message of that role, so stamp the reaction
        // AND the now-known row id onto it. Without this the event matches
        // nothing and the reaction only appears after a reload.
        const lastIndex = messages.findLastIndex(message => message.role === reactedRole && message.rowId === undefined)

        if (lastIndex === -1) {
          return messages
        }

        recordAgentReaction(reactedRowId, nextReactions)

        return messages.map((message, index) =>
          index === lastIndex ? { ...message, rowId: reactedRowId, reactions: nextReactions } : message
        )
      })
    }

    return true
  }

  return false
}

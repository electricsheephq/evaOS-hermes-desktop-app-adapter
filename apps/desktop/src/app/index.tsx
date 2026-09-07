// The app root is the contribution-driven shell: panes, titlebar/statusbar
// items, keybinds, palette commands, routes, and themes all register through
// the contribution registry (src/contrib) — core surfaces use the same calls
// plugins do. Everything lives under ./contrib: the wiring (gateway boot,
// sessions, streams) + pane surfaces, and the pane/layout registration.
import { DelegatedSupportBanner } from '../components/delegated-support-banner'
import { SupportTargetPickerOverlay } from '../components/support-target-picker'

import { ContribController } from './contrib'

export default function App() {
  return (
    <>
      <ContribController />
      <DelegatedSupportBanner />
      <SupportTargetPickerOverlay />
    </>
  )
}

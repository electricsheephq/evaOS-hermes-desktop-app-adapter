import { atom } from 'nanostores'

// Open/closed state of the in-app support target picker (sc#540). Renderer-
// owned presentation state: the banner's Switch button and the native menu's
// push both flip it; the picker owns everything else about its session.
export const $supportPickerOpen = atom(false)

export function setSupportPickerOpen(open: boolean) {
  $supportPickerOpen.set(open)
}

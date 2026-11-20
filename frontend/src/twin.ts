import { color, value } from './heat'
import type { Mode, Room } from './types'

// 3D 트윈(iframe) 연동 규약: docs/human/reference/twin-embed.md
export const TWIN_URL = import.meta.env.VITE_TWIN_URL as string | undefined

export function postState(frame: HTMLIFrameElement | null, floor: string, mode: Mode, rooms: Room[], highlight: string[]) {
  if (!frame?.contentWindow || !TWIN_URL) return
  frame.contentWindow.postMessage(
    {
      source: 'maestro', type: 'state', floor, mode, highlight,
      rooms: rooms.map((r) => ({ id: r.id, color: color(mode, r), label: value(mode, r), onOff: r.onOff, anomaly: r.anomaly })),
    },
    new URL(TWIN_URL).origin,
  )
}

export function onRoomSelected(handler: (roomId: string) => void) {
  const listener = (e: MessageEvent) => {
    if (!TWIN_URL || e.origin !== new URL(TWIN_URL).origin) return
    if (e.data?.source === 'twin' && e.data.type === 'roomSelected') handler(String(e.data.roomId))
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

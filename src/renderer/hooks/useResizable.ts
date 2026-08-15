import { useCallback, useEffect, useRef, useState } from 'react'

type Axis = 'x' | 'y'

/**
 * A draggable panel dimension with bounds + persistence. Returns the current size (px) and a pointer-down
 * handler to attach to a divider element.
 *
 * - `containerRef` supplies the LIVE container size, so the upper bound (= container − `reserve`) tracks window
 *   resizes instead of being frozen at mount. `reserve` is the space kept for the sibling panel(s).
 * - `invert` is for dividers on the LEADING edge of the resized panel (left of a right-docked panel, top of a
 *   bottom-docked panel): the panel grows as the pointer moves toward it.
 * - The size persists to localStorage under `storageKey`, so the layout survives reloads.
 */
export function useResizable<T extends HTMLElement>(opts: {
  axis: Axis
  initial: number
  min: number
  reserve: number
  storageKey: string
  invert?: boolean
  containerRef: React.RefObject<T | null>
}): { size: number; dragging: boolean; onPointerDown: (e: React.PointerEvent) => void } {
  const { axis, initial, min, reserve, storageKey, invert, containerRef } = opts
  const [size, setSize] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return Number.isFinite(saved) && saved >= min ? saved : initial
  })
  const [dragging, setDragging] = useState(false)
  const sizeRef = useRef(size)
  sizeRef.current = size

  useEffect(() => {
    localStorage.setItem(storageKey, String(Math.round(size)))
  }, [size, storageKey])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startPos = axis === 'x' ? e.clientX : e.clientY
      const startSize = sizeRef.current
      setDragging(true)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      const move = (ev: PointerEvent): void => {
        const cur = axis === 'x' ? ev.clientX : ev.clientY
        const delta = (cur - startPos) * (invert ? -1 : 1)
        const el = containerRef.current
        const containerSize = el ? (axis === 'x' ? el.clientWidth : el.clientHeight) : Infinity
        const max = Math.max(min, containerSize - reserve)
        setSize(Math.min(max, Math.max(min, startSize + delta)))
      }
      const up = (): void => {
        setDragging(false)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [axis, min, reserve, invert, containerRef]
  )

  return { size, dragging, onPointerDown }
}

import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import { useEffect, useRef } from '../../lib/preact'
import type { SchemaComponentProps } from '../../types'

export function Image({ ymap }: SchemaComponentProps) {
  const src = String(useYAttr(ymap, 'src') || '')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Offscreen canvas for double-buffering — never clear the visible canvas
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!src) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const drawCanvas = canvas
    const drawCtx = ctx

    let stopped = false
    let currentW = 0, currentH = 0

    function paint() {
      if (stopped) return
      const img = new window.Image()
      img.onload = () => {
        if (stopped) return
        const w = img.naturalWidth
        const h = img.naturalHeight

        // Only resize if dimensions actually changed
        if (w !== currentW || h !== currentH) {
          currentW = w
          currentH = h
          drawCanvas.width = w
          drawCanvas.height = h
        }

        // Draw directly — no clear needed, drawImage overwrites all pixels
        drawCtx.drawImage(img, 0, 0)
        timerRef.current = setTimeout(paint, 1000)
      }
      img.onerror = () => {
        if (!stopped) timerRef.current = setTimeout(paint, 2000)
      }
      img.src = src + (src.includes('?') ? '&' : '?') + '_t=' + Date.now()
    }

    paint()
    return () => {
      stopped = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [src])

  if (!src) return null

  return html`<canvas ref=${canvasRef} class="schema-image"
    style="flex:1;min-height:0;width:100%;height:100%" />`
}

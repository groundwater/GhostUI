import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import type { SchemaComponentProps } from '../../types'

export function Slider({ ymap }: SchemaComponentProps) {
  const label = String(useYAttr(ymap, 'label') || '')
  const value = String(useYAttr(ymap, 'value') || useYAttr(ymap, 'detail') || '')

  // Parse numeric value for the track fill (0-100 range assumed)
  const numVal = parseFloat(value)
  const pct = isNaN(numVal) ? 50 : Math.max(0, Math.min(100, numVal * 100))

  return html`<div class="n-slider">
    <span class="n-slider-label">${label}</span>
    <div class="n-slider-track">
      <div class="n-slider-fill" style=${{ width: pct + '%' }}></div>
      <div class="n-slider-thumb" style=${{ left: pct + '%' }}></div>
    </div>
    ${value && html`<span class="n-slider-value">${value}</span>`}
  </div>`
}

import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import type { SchemaComponentProps } from '../../types'

export function Toggle({ ymap }: SchemaComponentProps) {
  const label = String(useYAttr(ymap, 'label') || '')
  const checked = useYAttr(ymap, 'checked')
  return html`<div class="n-toggle">
    <div class=${'n-toggle-track' + (checked ? ' on' : '')}>
      <div class="n-toggle-knob"></div>
    </div>
    ${label && html`<span class="n-toggle-label">${label}</span>`}
  </div>`
}

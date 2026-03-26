import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import { iconClass } from '../icons'
import type { SchemaComponentProps } from '../../types'

export function Tab({ ymap }: SchemaComponentProps) {
  const label = String(useYAttr(ymap, 'label') || '')
  const active = useYAttr(ymap, 'active')
  const icon = String(useYAttr(ymap, 'icon') || '')
  const closable = useYAttr(ymap, 'closable')

  return html`<div class=${'n-tab' + (active ? ' active' : '')} title=${label}>
    ${icon && html`<span class=${'n-tab-icon ' + iconClass(icon)}></span>`}
    <span>${label}</span>
    ${closable && html`<span class="n-tab-close">✕</span>`}
  </div>`
}

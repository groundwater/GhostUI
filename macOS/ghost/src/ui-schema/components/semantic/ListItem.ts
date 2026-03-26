import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import { iconClass } from '../icons'
import type { SchemaComponentProps } from '../../types'

export function ListItem({ ymap }: SchemaComponentProps) {
  const label = String(useYAttr(ymap, 'label') || '')
  const icon = String(useYAttr(ymap, 'icon') || '')
  const selected = useYAttr(ymap, 'selected')
  const detail = useYAttr(ymap, 'detail')
  const chevron = useYAttr(ymap, 'chevron')

  return html`<div class=${'n-listitem' + (selected ? ' selected' : '')}>
    ${icon && html`<span class=${'n-listitem-icon ' + iconClass(icon)}></span>`}
    <span class="n-listitem-label">${label}</span>
    ${detail && html`<span class="n-listitem-detail">${detail}</span>`}
    ${chevron && html`<span class="n-listitem-chevron codicon codicon-chevron-right"></span>`}
  </div>`
}

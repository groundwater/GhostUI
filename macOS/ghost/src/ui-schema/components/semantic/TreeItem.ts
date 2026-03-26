import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import { iconClass } from '../icons'
import type { SchemaComponentProps } from '../../types'

export function TreeItem({ ymap }: SchemaComponentProps) {
  const label = String(useYAttr(ymap, 'label') || '')
  const icon = String(useYAttr(ymap, 'icon') || '')
  const expanded = useYAttr(ymap, 'expanded')
  const depth = Number(useYAttr(ymap, 'depth') || 0)
  const selected = useYAttr(ymap, 'selected')

  return html`<div class=${'n-treeitem' + (selected ? ' selected' : '')} style=${{ paddingLeft: (8 + depth * 16) + 'px' }}>
    ${expanded != null && html`<span class=${'n-treeitem-arrow' + (expanded ? ' expanded' : '')}>\u25B6</span>`}
    ${icon && html`<span class=${'n-treeitem-icon ' + iconClass(icon)}></span>`}
    <span class="n-treeitem-label">${label}</span>
  </div>`
}

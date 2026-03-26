import { html } from '../../lib/preact'
import { useYAttr, useYChildren } from '../../hooks/useYMap'
import { SchemaNode } from '../SchemaNode'
import type { SchemaComponentProps, StyleMap } from '../../types'

export function Split({ ymap }: SchemaComponentProps) {
  const direction = useYAttr(ymap, 'direction') || 'h'
  const sizes = useYAttr(ymap, 'sizes')
  const children = useYChildren(ymap)

  const isRow = direction === 'h'
  const sizeArr = Array.isArray(sizes) ? sizes : []

  return html`<div class=${'n-split n-split-' + direction} style=${{
    display: 'flex',
    flexDirection: isRow ? 'row' : 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  }}>
    ${children.map((c, i) => {
      const size = sizeArr[i]
      const style: StyleMap = {
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }
      if (size != null) {
        style.flexBasis = size + 'px'
        style.flexShrink = 0
        style.flexGrow = 0
      } else {
        style.flex = '1'
      }
      return html`<div key=${c.get?.('id') || i} class="n-split-pane" style=${style}>
        <${SchemaNode} ymap=${c} />
      </div>`
    })}
  </div>`
}

import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import { SchemaChildren } from '../SchemaNode'
import type { SchemaComponentProps, StyleMap } from '../../types'

export function Scroll({ ymap }: SchemaComponentProps) {
  const axis = useYAttr(ymap, 'axis') || 'v'
  const style: StyleMap = {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  }
  if (axis === 'v') style.overflowY = 'auto'
  else if (axis === 'h') style.overflowX = 'auto'
  else { style.overflowY = 'auto'; style.overflowX = 'auto' }

  return html`<div class="n-scroll" style=${style}><${SchemaChildren} ymap=${ymap} /></div>`
}

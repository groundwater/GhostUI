import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import { SchemaChildren } from '../SchemaNode'
import type { SchemaComponentProps, StyleMap } from '../../types'

export function VStack({ ymap }: SchemaComponentProps) {
  const gap = useYAttr(ymap, 'gap')
  const style: StyleMap = {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  }
  if (gap != null) style.gap = gap + 'px'
  return html`<div class="n-vstack" style=${style}><${SchemaChildren} ymap=${ymap} /></div>`
}

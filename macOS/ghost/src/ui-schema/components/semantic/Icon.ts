import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import { iconClass } from '../icons'
import type { SchemaComponentProps } from '../../types'

export function Icon({ ymap }: SchemaComponentProps) {
  const name = String(useYAttr(ymap, 'name') || '')
  const size = useYAttr(ymap, 'size')
  const style = size ? { fontSize: size + 'px' } : {}
  return html`<span class=${iconClass(name)} title=${name} style=${style}></span>`
}

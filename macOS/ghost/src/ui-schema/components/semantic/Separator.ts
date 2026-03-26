import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import type { SchemaComponentProps } from '../../types'

export function Separator({ ymap }: SchemaComponentProps) {
  const direction = String(useYAttr(ymap, 'direction') || 'h')
  return html`<div class=${'n-separator n-separator-' + direction}></div>`
}

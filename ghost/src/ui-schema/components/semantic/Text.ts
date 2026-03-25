import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import type { SchemaComponentProps } from '../../types'

export function Text({ ymap }: SchemaComponentProps) {
  const value = String(useYAttr(ymap, 'value') || '')
  if (!value) return null
  return html`<span class="n-text">${value}</span>`
}

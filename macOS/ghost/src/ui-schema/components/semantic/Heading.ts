import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import type { SchemaComponentProps } from '../../types'

export function Heading({ ymap }: SchemaComponentProps) {
  const value = String(useYAttr(ymap, 'value') || '')
  const level = Number(useYAttr(ymap, 'level') || 1)
  if (!value) return null
  return html`<div class=${'n-heading n-heading-' + level}>${value}</div>`
}

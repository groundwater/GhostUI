import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import type { SchemaComponentProps } from '../../types'

export function TextField({ ymap }: SchemaComponentProps) {
  const value = String(useYAttr(ymap, 'value') || '')
  const placeholder = String(useYAttr(ymap, 'placeholder') || '')
  return html`<div class="n-textfield">
    ${value || html`<span class="n-placeholder">${placeholder}</span>`}
  </div>`
}

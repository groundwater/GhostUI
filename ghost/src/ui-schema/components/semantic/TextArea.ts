import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import type { SchemaComponentProps } from '../../types'

export function TextArea({ ymap }: SchemaComponentProps) {
  const value = String(useYAttr(ymap, 'value') || '')
  const language = String(useYAttr(ymap, 'language') || '')
  return html`<div class=${'n-textarea' + (language ? ' lang-' + language : '')}>
    <pre>${value}</pre>
  </div>`
}

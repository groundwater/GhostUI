import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import { SchemaChildren } from '../SchemaNode'
import type { SchemaComponentProps } from '../../types'

export function SectionHeader({ ymap }: SchemaComponentProps) {
  const label = String(useYAttr(ymap, 'label') || '')
  return html`<div class="n-section-header">
    <span>${label}</span>
    <${SchemaChildren} ymap=${ymap} />
  </div>`
}

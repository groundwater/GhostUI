import { html } from '../../lib/preact'
import { SchemaChildren } from '../SchemaNode'
import type { SchemaComponentProps } from '../../types'

export function Toolbar({ ymap }: SchemaComponentProps) {
  return html`<div class="n-toolbar"><${SchemaChildren} ymap=${ymap} /></div>`
}

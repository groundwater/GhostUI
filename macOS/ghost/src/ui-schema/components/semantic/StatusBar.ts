import { html } from '../../lib/preact'
import { SchemaChildren } from '../SchemaNode'
import type { SchemaComponentProps } from '../../types'

export function StatusBar({ ymap }: SchemaComponentProps) {
  return html`<div class="n-statusbar"><${SchemaChildren} ymap=${ymap} /></div>`
}

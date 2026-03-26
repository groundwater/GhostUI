import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import type { SchemaComponentProps } from '../../types'

export function Titlebar({ ymap }: SchemaComponentProps) {
  const title = String(useYAttr(ymap, 'title') || '')
  const searchField = useYAttr(ymap, 'searchField')

  return html`<div class="n-titlebar">
    <div class="traffic-lights">
      <div class="traffic-light close"></div>
      <div class="traffic-light minimize"></div>
      <div class="traffic-light maximize"></div>
    </div>
    <div class="n-titlebar-title">${title}</div>
    ${searchField && html`<div class="n-titlebar-search">
      <span class="icon-placeholder"></span>
      <span>Search</span>
    </div>`}
  </div>`
}

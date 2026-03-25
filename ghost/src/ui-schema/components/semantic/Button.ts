import { html } from '../../lib/preact'
import { useYAttr } from '../../hooks/useYMap'
import { iconClass } from '../icons'
import type { SchemaComponentProps } from '../../types'

export function Button({ ymap }: SchemaComponentProps) {
  const label = String(useYAttr(ymap, 'label') || '')
  const icon = String(useYAttr(ymap, 'icon') || '')
  const disabled = useYAttr(ymap, 'disabled')

  const classes = ['n-button']
  if (disabled) classes.push('disabled')
  if (icon && !label) classes.push('icon-only')

  return html`<div class=${classes.join(' ')} title=${label}>
    ${icon && html`<span class=${iconClass(icon)}></span>`}
    ${label && html`<span>${label}</span>`}
  </div>`
}

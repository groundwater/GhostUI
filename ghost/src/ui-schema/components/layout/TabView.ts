import { html, useMemo } from '../../lib/preact'
import { useYAttr, useYChildren } from '../../hooks/useYMap'
import { SchemaNode } from '../SchemaNode'
import type { SchemaComponentProps, YNode } from '../../types'

export function TabView({ ymap }: SchemaComponentProps) {
  const activeTab = useYAttr(ymap, 'activeTab')
  const children = useYChildren(ymap)

  const { tabs, content } = useMemo(() => {
    const tabs: YNode[] = []
    const content: YNode[] = []
    for (const c of children) {
      const type = c.get('type')
      if (type === 'Tab') tabs.push(c)
      else content.push(c)
    }
    return { tabs, content }
  }, [children])

  return html`<div class="n-tabview" style=${{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
    ${tabs.length > 0 && html`<div class="n-tabstrip">
      ${tabs.map((c, i) => html`<${SchemaNode} ymap=${c} key=${c.get?.('id') || i} />`)}
    </div>`}
    <div class="n-tabcontent" style=${{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      ${content.map((c, i) => {
        const id = c.get('id')
        const key = typeof id === 'string' || typeof id === 'number' ? id : i
        return html`<${SchemaNode} ymap=${c} key=${key} />`
      })}
    </div>
  </div>`
}

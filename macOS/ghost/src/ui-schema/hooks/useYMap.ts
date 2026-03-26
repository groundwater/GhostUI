import { useState, useEffect, useRef } from '../lib/preact'
import type { YMapEvent, YNode, YNodeArray } from '../types'

/** Shallow structural equality — handles primitives, arrays, and plain objects like {_tuple: [x,y]} */
function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null || typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!stableEqual(a[i], b[i])) return false
    return true
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const ka = Object.keys(aObj), kb = Object.keys(bObj)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!stableEqual(aObj[k], bObj[k])) return false
  return true
}

/**
 * Subscribe to a single attribute on a Y.Map.
 * Reads 'type' key (new schema convention).
 */
export function useYAttr<T = unknown>(ymap: YNode, key: string): T | undefined {
  const [val, setVal] = useState<T | undefined>(() => ymap.get(key) as T | undefined)
  const prevRef = useRef<T | undefined>(val)

  useEffect(() => {
    function update() {
      const next = ymap.get(key) as T | undefined
      if (stableEqual(prevRef.current, next)) return
      prevRef.current = next
      setVal(next)
    }
    update()
    const handler = (event: YMapEvent) => {
      if (event.keysChanged.has(key)) update()
    }
    ymap.observe(handler)
    return () => ymap.unobserve(handler)
  }, [ymap, key])

  return val
}

/**
 * Subscribe to the _children Y.Array of a Y.Map.
 */
export function useYChildren(ymap: YNode): YNode[] {
  const [children, setChildren] = useState<YNode[]>(() => getChildArray(ymap))
  const prevRef = useRef<YNode[]>(children)

  useEffect(() => {
    function sync() {
      const next = getChildArray(ymap)
      const prev = prevRef.current
      if (prev.length === next.length && prev.every((m, i) => m === next[i])) return
      prevRef.current = next
      setChildren(next)
    }

    sync()

    let observedArr: YNodeArray | null = null
    let arrHandler: (() => void) | null = null
    function bindArrayObserver(nextArr: YNodeArray | null | undefined) {
      if (observedArr && arrHandler) observedArr.unobserve(arrHandler)
      observedArr = nextArr || null
      if (!observedArr) {
        arrHandler = null
        return
      }
      arrHandler = () => sync()
      observedArr.observe(arrHandler)
    }

    const handler = (event: YMapEvent) => {
      if (event.keysChanged.has('_children')) {
        bindArrayObserver(ymap.get('_children') as YNodeArray | undefined)
        sync()
      }
    }
    ymap.observe(handler)
    bindArrayObserver(ymap.get('_children') as YNodeArray | undefined)

    return () => {
      ymap.unobserve(handler)
      if (observedArr && arrHandler) observedArr.unobserve(arrHandler)
    }
  }, [ymap])

  return children
}

function getChildArray(ymap: YNode): YNode[] {
  const c = ymap.get('_children') as YNodeArray | undefined
  if (!c || c.length === 0) return []
  const arr: YNode[] = []
  for (let i = 0; i < c.length; i++) arr.push(c.get(i) as YNode)
  return arr
}

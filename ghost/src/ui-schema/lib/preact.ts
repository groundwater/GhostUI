export {
  h,
  render,
  Component,
  Fragment,
  createContext,
  toChildArray,
} from "preact";

export {
  useState,
  useEffect,
  useRef,
  useMemo,
  useContext,
  useCallback,
  useReducer,
} from "preact/hooks";

export { html } from "htm/preact";

import { Component as PreactComponent, type ComponentChildren } from "preact";

type PropsRecord = Record<string, unknown>;

function shallowEqualProps(a: PropsRecord, b: PropsRecord): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function memo<P extends object>(
  fn: ((props: P) => ComponentChildren) & { displayName?: string },
  compare?: (prev: P, next: P) => boolean,
) {
  const cmp = compare ?? ((a: P, b: P) => shallowEqualProps(a as PropsRecord, b as PropsRecord));

  class Memo extends PreactComponent<PropsRecord> {
    override shouldComponentUpdate(nextProps: PropsRecord): boolean {
      return !cmp(this.props as P, nextProps as P);
    }

    override render(): ComponentChildren {
      return fn(this.props as P);
    }
  }

  Memo.displayName = `Memo(${fn.displayName || fn.name || "Anonymous"})`;
  return Memo;
}

/** Plain JSON node as returned by daemon query and snapshot endpoints. */
export interface PlainNode {
  _tag: string;
  _text?: string;
  _children?: PlainNode[];
  [key: string]: unknown;
}

/** Generic accessor so filterTree can work on any tree shape. */
export interface NodeAccessor<T> {
  tag(n: T): string;
  children(n: T): T[] | undefined;
  attr(n: T, name: string): string | undefined;
  id(n: T): string | undefined;
  attrs(n: T): Record<string, string>;
}

export interface Predicate {
  attr: string;          // attribute name, e.g. "label", "icon"
  op: "=" | "!=" | "~=" | "exists";
  value?: string;        // undefined when op is "exists"
  suppress?: boolean;    // @prefix — filter by this attr but hide from output
  as?: string;           // rename attr in output: [x@y] → as="x", attr="y"
  transform?: (value: string) => string;  // programmatic only, not parsed from string
}

/** Parsed query node */
export interface QueryNode {
  tag: string;           // e.g. "Button", "Window", "*"
  omitWrapper?: boolean;  // leading @Foo — match Foo but omit wrapper from output
  omitAncestors?: boolean; // leading @@Foo — omit wrapper and ancestor path from output
  elide?: boolean;        // backslash-delimited segment — match Foo but elide all matching wrappers from output
  as?: string;           // rename tag in output: foo@bar → as="foo", tag="bar"
  id?: string;           // e.g. "com.apple.Terminal" from Application#com.apple.Terminal
  index?: number;        // e.g. 0 in "Button:0" — nth matching sibling
  indexEnd?: number;     // e.g. 10 in "Button:3:10" — slice [3,10)
  predicates?: Predicate[]; // e.g. [label=Explorer], [icon]
  children?: QueryNode[]; // scoped sub-queries inside { }
  directChild?: boolean;  // true when this node must be an immediate child of parent scope (via >)
  introspect?: "*" | "**"; // [*] list attr names, [**] list key=values per node
  introspectRemainder?: boolean; // [title, *] or [title, **] keeps named attrs first, then the rest
}

import { html, useEffect, useRef } from "../lib/preact";
import { useYAttr, useYChildren } from "../hooks/useYMap";
import { AppContext } from "./AppContext";
import type { ComponentType } from "preact";
import type { SchemaComponentProps, YNode } from "../types";

import { VStack } from "./layout/VStack";
import { HStack } from "./layout/HStack";
import { Split } from "./layout/Split";
import { Scroll } from "./layout/Scroll";
import { TabView } from "./layout/TabView";
import { Spacer } from "./layout/Spacer";
import { SchemaWindow } from "./layout/SchemaWindow";

import { Titlebar } from "./semantic/Titlebar";
import { Toolbar } from "./semantic/Toolbar";
import { StatusBar } from "./semantic/StatusBar";
import { Tab } from "./semantic/Tab";
import { Button } from "./semantic/Button";
import { Icon } from "./semantic/Icon";
import { Text } from "./semantic/Text";
import { Heading } from "./semantic/Heading";
import { TextField } from "./semantic/TextField";
import { TextArea } from "./semantic/TextArea";
import { Toggle } from "./semantic/Toggle";
import { ListItem } from "./semantic/ListItem";
import { SectionHeader } from "./semantic/SectionHeader";
import { TreeItem } from "./semantic/TreeItem";
import { Separator } from "./semantic/Separator";
import { Image } from "./semantic/Image";
import { Slider } from "./semantic/Slider";

const hiddenTypes = new Set(["MenuBar", "MenuBarItem", "Menu", "MenuItem", "ContextMenu"]);

function nodeType(node: YNode): string {
  return String(node.get("type") || node.get("_tag") || "");
}

function System({ ymap, windowDocs, commandRoot, windowLeases, onWindowFocusCommand, onWindowDragStart }: SchemaComponentProps) {
  const screenW = Number(useYAttr(ymap, "screenW") || 1440);
  const screenH = Number(useYAttr(ymap, "screenH") || 900);
  const frontApp = String(useYAttr(ymap, "frontApp") || "");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;

    const obs = new ResizeObserver(() => {
      const cw = container.clientWidth || 1;
      const ch = container.clientHeight || 1;
      const scale = Math.min(1, cw / screenW, ch / screenH);
      inner.style.transform = `scale(${scale})`;
    });

    obs.observe(container);
    return () => obs.disconnect();
  }, [screenW, screenH]);

  const wallpaper = useYAttr(ymap, "wallpaper");
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || !wallpaper) return;
    inner.style.backgroundImage = `url(${wallpaper})`;
  }, [wallpaper]);

  return html`<${AppContext.Provider} value=${frontApp}>
    <div class="virtual-screen" ref=${containerRef}>
      <div class="virtual-screen-inner"
           ref=${innerRef}
           style=${{ width: `${screenW}px`, height: `${screenH}px` }}>
        <${SchemaChildren}
          ymap=${ymap}
          windowDocs=${windowDocs}
          commandRoot=${commandRoot}
          windowLeases=${windowLeases}
          onWindowFocusCommand=${onWindowFocusCommand}
          onWindowDragStart=${onWindowDragStart}
        />
      </div>
    </div>
  </${AppContext.Provider}>`;
}

function Application({ ymap, windowDocs, commandRoot, windowLeases, onWindowFocusCommand, onWindowDragStart }: SchemaComponentProps) {
  const bundleId = String(useYAttr(ymap, "bundleId") || "");
  const foreground = String(useYAttr(ymap, "foreground") || "");
  const slug = bundleId.toLowerCase().replace(/\./g, "-");
  const children = useYChildren(ymap);
  const hasWindows = children.some((child) => nodeType(child) === "Window");
  const bg = foreground === "false";

  return html`<${AppContext.Provider} value=${bundleId}>
    ${hasWindows
      ? html`<div class=${"app-" + slug + (bg ? " app-background" : "")} style=${{ display: "contents" }}>
        <${SchemaChildren}
          ymap=${ymap}
          windowDocs=${windowDocs}
          commandRoot=${commandRoot}
          windowLeases=${windowLeases}
          onWindowFocusCommand=${onWindowFocusCommand}
          onWindowDragStart=${onWindowDragStart}
        />
      </div>`
      : null}
  </${AppContext.Provider}>`;
}

const renderers: Record<string, ComponentType<SchemaComponentProps>> = {
  System,
  Display: System,
  Application,
  Window: SchemaWindow,
  VStack,
  HStack,
  Split,
  Scroll,
  TabView,
  Spacer,
  Titlebar,
  Toolbar,
  StatusBar,
  Tab,
  Button,
  Icon,
  Text,
  Heading,
  TextField,
  TextArea,
  Toggle,
  ListItem,
  SectionHeader,
  TreeItem,
  Separator,
  Image,
  Slider,
};

export function SchemaNode({ ymap, windowDocs, commandRoot, windowLeases, onWindowFocusCommand, onWindowDragStart }: SchemaComponentProps) {
  const type = String(useYAttr(ymap, "type") || useYAttr(ymap, "_tag") || "");
  if (!type) return null;
  if (hiddenTypes.has(type)) return null;

  const Component = renderers[type];
  if (!Component) {
    return html`<${SchemaChildren}
      ymap=${ymap}
      windowDocs=${windowDocs}
      commandRoot=${commandRoot}
      windowLeases=${windowLeases}
      onWindowFocusCommand=${onWindowFocusCommand}
      onWindowDragStart=${onWindowDragStart}
    />`;
  }

  return html`<${Component}
    ymap=${ymap}
    windowDocs=${windowDocs}
    commandRoot=${commandRoot}
    windowLeases=${windowLeases}
    onWindowFocusCommand=${onWindowFocusCommand}
    onWindowDragStart=${onWindowDragStart}
  />`;
}

function getNumericZ(node: YNode): number | undefined {
  const z = Number(node.get("z"));
  return Number.isFinite(z) ? z : undefined;
}

function getApplicationZ(node: YNode): number | undefined {
  const type = String(node.get("type") || node.get("_tag") || "");
  if (type !== "Application") return undefined;
  const children = node.get("_children") as { length: number; get(index: number): YNode } | undefined;
  if (!children || typeof children.length !== "number") return undefined;
  let best: number | undefined;
  for (let i = 0; i < children.length; i++) {
    const child = children.get(i) as YNode;
    const childType = String(child.get("type") || child.get("_tag") || "");
    if (childType !== "Window") continue;
    const z = getNumericZ(child);
    if (z == null) continue;
    if (best == null || z < best) best = z;
  }
  return best;
}

function getRenderOrderKey(parentType: string, node: YNode): number | undefined {
  const type = String(node.get("type") || node.get("_tag") || "");
  if (parentType === "Display" && type === "Application") {
    return getApplicationZ(node);
  }
  if (parentType === "Application" && type === "Window") {
    return getNumericZ(node);
  }
  return undefined;
}

export function SchemaChildren({ ymap, windowDocs, commandRoot, windowLeases, onWindowFocusCommand, onWindowDragStart }: SchemaComponentProps) {
  const children = useYChildren(ymap);
  const parentType = String(useYAttr(ymap, "type") || useYAttr(ymap, "_tag") || "");
  const orderedChildren = children
    .map((child, i) => ({ child, i, orderKey: getRenderOrderKey(parentType, child) }))
    .sort((a, b) => {
      if (a.orderKey == null || b.orderKey == null || a.orderKey === b.orderKey) {
        return a.i - b.i;
      }
      return a.orderKey - b.orderKey;
    });

  return orderedChildren.map(({ child, i }) => {
    const id = child.get("id");
    const key = typeof id === "string" || typeof id === "number" ? id : i;
    return html`<${SchemaNode}
      ymap=${child}
      windowDocs=${windowDocs}
      commandRoot=${commandRoot}
      windowLeases=${windowLeases}
      onWindowFocusCommand=${onWindowFocusCommand}
      onWindowDragStart=${onWindowDragStart}
      key=${key}
    />`;
  });
}

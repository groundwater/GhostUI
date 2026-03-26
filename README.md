# GhostUI

<p align="center">
  <img src="macOS/GhostUI/Resources/Icon/GhostUIIcon-final.png" width="256" alt="GhostUI Icon">
</p>

GhostUI is a macOS GUI automation system with two runtime pieces:

- A Swift app in `macOS/GhostUI/` that captures accessibility data and handles local UI/input surfaces.
- A Bun/TypeScript daemon in `macOS/ghost/src/` that maintains the live CRDT document and serves the display UI.

## Build

```bash
make debug
make release
```

The app bundle is written to `.build/GhostUI.app`.

## Run

Launch the app bundle first:

```bash
open .build/GhostUI.app
```

Run the daemon separately when you want the browser display:

```bash
cd macOS/ghost
bun run src/daemon.ts
```

Open the display UI at `http://localhost:7861/display/0`.

## Repo Layout

- `macOS/GhostUI/` - Swift app, overlays, services, and resources.
- `macOS/ghost/` - daemon runtime, native module, and display UI source.
- `Package.swift` - Swift package definition for app builds.

## Notes

- The canonical icon source is `macOS/GhostUI/Resources/Icon/GhostUIIcon-final.png`.
- The app bundle is built as `.build/GhostUI.app` from this repo root.
- Runtime resources are bundled into `GhostUI.app/Contents/Resources/ghost/`.

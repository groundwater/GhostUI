# GhostUI

<p align="center">
  <img src="macOS/GhostUI/Resources/Icon/GhostUIIcon-final.png" width="256" alt="GhostUI Icon">
</p>

GhostUI is a macOS GUI automation system with two runtime pieces:

- A Swift app in `macOS/GhostUI/` that captures accessibility data and handles local UI/input surfaces.
- A Bun/TypeScript daemon in `macOS/ghost/src/` that maintains the live daemon-backed document and CLI/operator backend.

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

Run the daemon separately when you want the CLI/operator backend:

```bash
cd macOS/ghost
bun run src/daemon.ts
```

## Repo Layout

- `macOS/GhostUI/` - Swift app, overlays, services, and resources.
- `macOS/ghost/` - daemon runtime and native module.
- `Package.swift` - Swift package definition for app builds.

## Notes

- The canonical icon source is `macOS/GhostUI/Resources/Icon/GhostUIIcon-final.png`.
- The app bundle is built as `.build/GhostUI.app` from this repo root.
- Runtime resources are bundled into `GhostUI.app/Contents/Resources/ghost/`.

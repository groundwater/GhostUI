# ghost

TypeScript runtime for the GhostUI daemon.

## What Lives Here

- `src/daemon.ts` starts the daemon process.
- `src/cli/` contains the `gui` CLI implementation.
- `src/server/` serves HTTP routes and operator endpoints.
- `native/` contains the macOS native AX module.

## Run From The Repo Root

```sh
cd macOS/ghost
bun run src/daemon.ts
```

Type-check and targeted tests:

```sh
bun x tsc --noEmit
bun test src/server/routes.test.ts src/cli/filter.test.ts src/ax-event-policy.test.ts
```

## Bundled Resources

The source tree lives under `macOS/ghost/`, but the built app still copies daemon
resources into `GhostUI.app/Contents/Resources/ghost/`. That bundled path is what
the shipped app launches at runtime.

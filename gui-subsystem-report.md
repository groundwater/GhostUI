# GhostUI GUI Subsystem Sweep Report

## Setup

- Date: `2026-03-19` to `2026-03-20`
- Target app: `TextEdit`
- Bundled app: `/Users/bender/Desktop/GhostUI/GhostUI/.build/GhostUI.app`
- Bundled CLI: `/Users/bender/Desktop/GhostUI/GhostUI/.build/GhostUI.app/Contents/MacOS/gui`
- Artifact root: `/tmp/gui-subsystem-sweep`

This report summarizes the live CLI sweep across `ca`, `ax`, `rec`, `window`, `ws`, `cg`, and `pb` using the subsystem artifacts captured under `/tmp/gui-subsystem-sweep`. The sweep used the bundled app flow and TextEdit as the primary live target.

## Key Callouts

- Port ownership on `7861` was a real issue during the session. [`window-lsof.txt`](/tmp/gui-subsystem-sweep/window-lsof.txt) showed `bun` listening on `7861`, and both [`/tmp/daemon.log`](/tmp/daemon.log) and [`/tmp/daemon-err.log`](/tmp/daemon-err.log) captured `EADDRINUSE`. The healthy bundled run is visible in [`/tmp/ghostui-daemon.log`](/tmp/ghostui-daemon.log), which shows `trusted: true` and `accessibility trusted — starting window sync`.
- AX itself was not dead. The weak point is selector resolution. `ax tree`, `ax snapshot`, `ax at`, and `ax events` all worked, but selector-based commands often failed to match nodes that were visibly present in the tree.
- `gui cg doubleclick` is a concrete product failure. It returned `Pointer event failed: doubleclick`.
- `gui rec video` is surfaced but unshipped in this build. The command failed with `native recorder is not implemented`.
- `gui pb read --type` was attempted with malformed quoted type input, so that failure is not clean evidence of a pasteboard bug.
- Some commands only have weak verification:
  - `ca script` succeeded, but normal macOS full-screen screenshots did not show the overlay layer.
  - `cg scroll` returned success without strong visual proof in the artifact set.
  - modifier-only `cg` commands returned `ok`, but the delta pass did not capture a strong external effect.

## Subsystem Summary

| Subsystem | Verdict | What worked | What did not | Evidence |
|---|---|---|---|---|
| `ws` | Good | `apps`, `frontmost`, `screen` | None observed | [ws.json](/tmp/gui-subsystem-sweep/ws.json) |
| `window` | Good | `focus`, `drag` | None observed | [window.json](/tmp/gui-subsystem-sweep/window.json) |
| `pb` | Mostly good | `types`, `read`, `write`, `clear`, restore | `read --type` attempt was malformed; `read` after `clear` returned expected empty state | [pb.json](/tmp/gui-subsystem-sweep/pb.json) |
| `ca` | Works with weak proof | `script` accepted both `rect_line` and `xray` payloads | Overlay visibility was not captured by macOS full-screen screenshots | [ca.json](/tmp/gui-subsystem-sweep/ca.json) |
| `rec` | Good except unshipped video | `image --rect`, `image --window`, `filmstrip --rect`, `filmstrip --window` | `video` is not implemented | [rec.json](/tmp/gui-subsystem-sweep/rec.json) |
| `ax` | Mixed | `snapshot`, `tree`, `at`, `menu-at`, `events` | `query`/`q` returned exit `0` with blank stdout; `actions`, `focus`, `perform`, `hover`, `click`, `set`, `type`, and more specific selector queries failed | [ax.json](/tmp/gui-subsystem-sweep/ax.json) |
| `cg` | Mostly good with weakly verified modifier input | `windows`, `window-at`, `mousepos`, `mousestate`, `move`, `click`, `drag`, `key` | `keydown`, `keyup`, `moddown`, and `modup` returned `ok` but were only weakly verified; `doubleclick` failed; `type` failed on AX selector resolution; `scroll` weakly verified | [cg.json](/tmp/gui-subsystem-sweep/cg.json) |

## Detailed Command Table

| Subsystem | Command | Status | Verification | Notes |
|---|---|---|---|---|
| `ws` | `gui ws apps` | Works | Returned running app list including `TextEdit` and `GhostUI` | Read-only and clean. |
| `ws` | `gui ws frontmost` | Works | Returned `TextEdit` PID `14770` | Good frontmost signal. |
| `ws` | `gui ws screen` | Works | Returned `1491x764` screen bounds at origin `(0,0)` | Read-only and clean. |
| `window` | `gui window focus 14571` | Works | Frontmost app after focus was `TextEdit` | Verified through workspace state. |
| `window` | `gui window drag 14571 620 180` | Works | Bounds changed from `520,140,1121,631` to `620,180,1221,671` | Directly verified in [window.json](/tmp/gui-subsystem-sweep/window.json). |
| `pb` | `gui pb types` | Works | Returned expected clipboard UTIs before mutation | Also worked again after restore. |
| `pb` | `gui pb read` | Works | Returned original clipboard text | Also worked again after restore. |
| `pb` | `gui pb write ghostui-pb-test-2026-03-19T00:00:00Z` | Works | Returned `ok` | Wrote known UTF-8 payload. |
| `pb` | `gui pb read --type '\"public.utf8-plain-text\",'` | Failed test input | Returned `(empty clipboard)` | Attempt used malformed quoted type string from discovery output; not clean product evidence. |
| `pb` | `gui pb clear` | Works | Returned `ok` | Clipboard mutation succeeded. |
| `pb` | `gui pb read` after clear | Expected empty | Returned `(empty clipboard)` | This is the expected post-clear state, not a bug. |
| `pb` | `gui pb types` after clear | Works | Returned `[]` | Confirms clear state. |
| `pb` | Clipboard restore via `pbcopy` | Works | Original text restored | Restore mode was text-only via `pbcopy`. |
| `ca` | `gui ca script -` with `rect_line` payload | Works | Exit `0`, no stderr | Visual overlay not visible in macOS full-screen screenshots. |
| `ca` | `gui ca script -` with `xray` payload | Works | Exit `0`, no stderr | Same screen-capture limitation as above. |
| `rec` | `gui rec image --rect 156,191,300,200 --frame-size 300x200 --out /tmp/gui-subsystem-sweep/rec-image-rect.png` | Works | Output image visibly contains TextEdit toolbar and text region | See [rec-image-rect.png](/tmp/gui-subsystem-sweep/rec-image-rect.png). |
| `rec` | `gui rec image --window 14571 --frame-size 300x200 --out /tmp/gui-subsystem-sweep/rec-image-window.png` | Works | Output image visibly contains full TextEdit window | See [rec-image-window.png](/tmp/gui-subsystem-sweep/rec-image-window.png). |
| `rec` | `gui rec filmstrip --rect 156,191,300,200 --grid 2x2 --every 1s --frame-size 300x200 --out /tmp/gui-subsystem-sweep/rec-filmstrip-rect.png` | Works | Output filmstrip contains expected TextEdit region | See [rec-filmstrip-rect.png](/tmp/gui-subsystem-sweep/rec-filmstrip-rect.png). |
| `rec` | `gui rec filmstrip --window 14571 --grid 2x2 --every 1s --frame-size 300x200 --out /tmp/gui-subsystem-sweep/rec-filmstrip-window.png` | Works | Output filmstrip contains expected TextEdit window | See [rec-filmstrip-window.png](/tmp/gui-subsystem-sweep/rec-filmstrip-window.png). |
| `rec` | `gui rec video --window 14571 --fps 1 --duration 1s --out /tmp/gui-subsystem-sweep/rec-video.mov` | Fails | stderr says `gui rec video is not shipped yet; native recorder is not implemented` | Product is explicitly unshipped here. |
| `ax` | `gui ax snapshot --pid 14770 --depth 3` | Works | Returned live AX JSON for TextEdit | Confirms AX snapshot path is alive. |
| `ax` | `gui ax tree --pid 14770 --depth 3` | Works | Returned live AX tree including `AXWindow`, `AXScrollArea`, and `AXTextArea` | Confirms tree path is alive. |
| `ax` | `gui ax query 'AXWindow' --pid 14770 --first 5` | Ambiguous | Exit `0` with blank stdout | Query path did not emit rows in the artifact. |
| `ax` | `gui ax q 'AXWindow' --pid 14770 --first 5` | Ambiguous | Exit `0` with blank stdout | Alias also did not emit rows. |
| `ax` | `gui ax at 200 250 --pid 14770` | Works | Resolved a live node at coordinate | First probe landed on a ruler node. |
| `ax` | `gui ax actions 'AXWindow' --pid 14770` | Fails | `No AX match for: AXWindow` | Selector-driven resolution failure. |
| `ax` | `gui ax focus 'AXWindow' --pid 14770` | Fails | `No AX match for: AXWindow` | Selector-driven resolution failure. |
| `ax` | `gui ax perform 'AXWindow' AXRaise --pid 14770` | Fails | `No AX match for: AXWindow` | Selector-driven resolution failure. |
| `ax` | `gui ax hover 'AXWindow'` | Fails | `No AX match for: AXWindow` | Selector-driven resolution failure. |
| `ax` | `gui ax menu-at 200 250 --pid 14770` | Works | Returned `null` cleanly | Command path works even without a menu target. |
| `ax` | `gui ax click 'AXButton[subrole=AXCloseButton]'` | Fails | `No AX match for: AXButton[subrole=AXCloseButton]` | Tree shows a close button, but selector failed to resolve it. |
| `ax` | `gui ax set 'AXTextArea' 'AX set value from GhostUI'` | Fails | Text did not change; stderr `No AX match for: AXTextArea` | Selector issue, not a dead AX tree. |
| `ax` | `gui ax type 'AXTextArea' ' AX type value from GhostUI' --pid 14770` | Fails | Text did not change; stderr `No AX match for: AXTextArea` | Same selector issue. |
| `ax` | `gui ax events --pid 14770` | Works | Bounded 3s stream emitted `selected-text-changed` and `value-changed` | Strong signal that AX observation path works. |
| `ax` | `gui ax at 400 320 --pid 14770` | Works | Resolved live `AXTextArea` with identifier `First Text View` | Strong proof that the node exists. |
| `ax` | `gui ax q 'AXWindow#_NS:34' --pid 14770 --first 5` | Fails silently | Blank stdout | Specific selector failed despite visible tree node. |
| `ax` | `gui ax q 'AXTextArea#First Text View' --pid 14770 --first 5` | Fails silently | Blank stdout | Specific selector failed despite `ax at` resolving the node. |
| `ax` | `gui ax q 'AXScrollArea' --pid 14770 --first 5` | Fails silently | Blank stdout | Same brittle selector behavior. |
| `cg` | `gui cg windows --layer 0` | Works | Listed CG windows including the TextEdit target | Good baseline discovery surface. |
| `cg` | `gui cg window-at 580 260 --layer 0` | Works | Resolved the correct TextEdit window | Good coordinate hit test. |
| `cg` | `gui cg mousepos` | Works | Returned mouse coordinates | Used to verify `move`. |
| `cg` | `gui cg mousestate` | Works | Returned mouse coordinates and button state | Read-only signal. |
| `cg` | `gui cg move 580 260` | Works | Follow-up `mousepos` changed to requested coordinates | Strong verification. |
| `cg` | `gui cg click 580 260` | Works | Follow-up `ax at` resolved a live node | Good verification. |
| `cg` | `gui cg doubleclick 580 260` | Fails | `/api/cg/doubleclick failed (502): {"ok":false,"error":"Pointer event failed: doubleclick"}` | Concrete product failure. |
| `cg` | `gui cg drag 660 160 720 160` | Works | Window bounds changed | Strong verification via window geometry. |
| `cg` | `gui cg scroll 580 260 --dx 0 --dy -120` | Weak success | Returned `ok` | No strong visual proof captured in the artifact set. |
| `cg` | `gui cg key return` | Works | Returned `ok` | Input accepted; not the strongest standalone proof row. |
| `cg` | `gui cg key cgsubsystemtest` | Works | TextEdit document text changed | Strong verification via document content. |
| `cg` | `gui cg key cmd+n` | Works | TextEdit window count increased | Strong verification via window count. |
| `cg` | `gui cg keydown a --mods cmd` | Weak success | Returned `ok` | Minimal verification in the main pass. |
| `cg` | `gui cg keyup a` | Weak success | Returned `ok` | Minimal verification in the main pass. |
| `cg` | `gui cg moddown cmd` | Weak success | Returned `ok` | No strong external proof captured. |
| `cg` | `gui cg modup cmd` | Weak success | Returned `ok` | No strong external proof captured. |
| `cg` | `gui cg moddown shift` | Weak success | Returned `ok` | Delta pass explicitly notes weak verification. |
| `cg` | `gui cg keydown a` | Weak success | Returned `ok` | Delta pass only. |
| `cg` | `gui cg keyup a` | Weak success | Returned `ok` | Delta pass only. |
| `cg` | `gui cg modup shift` | Weak success | Returned `ok` | Delta pass explicitly notes weak verification. |
| `cg` | `gui cg type 'AXTextArea' 'cg-type-test'` | Fails | `No AX match for: AXTextArea` | Fails on the same AX selector brittleness seen in `ax`. |

## Representative Evidence

- [rec-image-window.png](/tmp/gui-subsystem-sweep/rec-image-window.png)
- [rec-filmstrip-window.png](/tmp/gui-subsystem-sweep/rec-filmstrip-window.png)
- [window-after-drag.png](/tmp/gui-subsystem-sweep/window-after-drag.png)
- [window-lsof.txt](/tmp/gui-subsystem-sweep/window-lsof.txt)
- [ghostui-daemon.log](/tmp/ghostui-daemon.log)
- [rec-video.stderr](/tmp/gui-subsystem-sweep/rec-video.stderr)
- [ax.json](/tmp/gui-subsystem-sweep/ax.json)
- [cg-finish.md](/tmp/gui-subsystem-sweep/cg-finish.md)

## Bottom Line

The healthy parts of the CLI are `ws`, `window`, most of `rec`, the broad non-selector AX surfaces, and most of raw `cg` input. The two recurring failure themes are:

1. Selector resolution in the AX-backed paths is brittle enough that `ax` and selector-backed `cg type` routinely fail even when the nodes are visibly present in the AX tree.
2. `cg doubleclick` is explicitly broken in this sweep and should be treated as a real defect.

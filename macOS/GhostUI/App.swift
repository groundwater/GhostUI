import AppKit
import ScreenCaptureKit
import Foundation

/// GhostUI version
let kGhostUIVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"

/// Pure AppKit entry point — avoids SwiftUI's opaque startup that can block on WindowServer.
/// Strong reference to the AppDelegate — NSApplication.delegate is weak,
/// so without this the delegate can be deallocated by ARC before the run loop fires.
private var _appDelegate: AppDelegate?
private let kGhostUIAppLogPath = "/tmp/ghostui-app.log"

private func redirectStandardIOToAppLog() {
    FileManager.default.createFile(atPath: kGhostUIAppLogPath, contents: nil)
    guard let handle = FileHandle(forWritingAtPath: kGhostUIAppLogPath) else { return }
    handle.seekToEndOfFile()
    dup2(handle.fileDescriptor, STDOUT_FILENO)
    dup2(handle.fileDescriptor, STDERR_FILENO)
    setbuf(stdout, nil)
    setbuf(stderr, nil)
}

@main
enum GhostUIMain {
    static func main() {
        // Ignore SIGPIPE — write() returns -1/EPIPE instead of killing the process
        signal(SIGPIPE, SIG_IGN)

        redirectStandardIOToAppLog()

        // Single-instance guard: if another instance is already running, activate it and exit
        let bundleID = Bundle.main.bundleIdentifier ?? "org.ghostvm.GhostUI"
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        let others = running.filter { $0 != NSRunningApplication.current }
        if let existing = others.first {
            print("[GhostUI] Another instance is already running (pid \(existing.processIdentifier)), activating it")
            existing.activate()
            exit(0)
        }

        print("[GhostUI] Starting…")

        let app = NSApplication.shared
        // GhostUI is a tool/overlay app — it must never steal frontmost from
        // the user's real app. Accessory policy keeps the menu bar extra and
        // overlay windows but removes GhostUI from the Dock and from
        // NSWorkspace.frontmostApplication, so the native AX layer always
        // reports the real user-facing app as frontmost.
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        _appDelegate = delegate          // prevent ARC from releasing before run()
        app.delegate = delegate
        app.run()
    }
}

/// App delegate handles menu bar setup and server lifecycle
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var daemonProcess: Process?
    private var isTerminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        print("[GhostUI] Application launched")
        print("[GhostUI] Version: \(kGhostUIVersion)")

        // Register with TCC so the app appears in System Settings.
        // CGRequestScreenCaptureAccess() is a no-op on macOS 15 — use ScreenCaptureKit instead.
        Task {
            _ = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        }
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        AXIsProcessTrustedWithOptions(opts)

        setupMainMenu()
        setupMenuBar()
        PermissionsWindow.shared.showIfNeeded()

        // Restore overlay states
        if UserDefaults.standard.bool(forKey: "showA11yTree") {
            A11yTreeOverlay.shared.start()
        }

        // Listen for overlay notifications from daemon (via NSDistributedNotification)
        registerOverlayNotifications()

        // Launch bun daemon as subprocess
        startDaemon()
        InputMonitor.shared.start()

        updateMenu()
    }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        InputMonitor.shared.stop()
        stopDaemon()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            PermissionsWindow.shared.showIfNeeded()
        }
        return true
    }

    // MARK: - Main Menu

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // App menu
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "About GhostUI", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "Services")
        servicesItem.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        appMenu.addItem(servicesItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Hide GhostUI", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(NSMenuItem(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Quit GhostUI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu

        // Edit menu
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editMenuItem.submenu = editMenu

        // Window menu
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        windowMenu.addItem(NSMenuItem.separator())
        windowMenu.addItem(NSMenuItem(title: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: ""))
        windowMenu.addItem(NSMenuItem.separator())
        let cpItem = NSMenuItem(title: "Control Panel", action: #selector(showControlPanel), keyEquivalent: "C")
        cpItem.keyEquivalentModifierMask = [.command, .shift]
        windowMenu.addItem(cpItem)
        windowMenuItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    // MARK: - Status Bar

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if statusItem?.button != nil {
            updateStatusIcon(connected: true)
        }

        updateMenu()
    }

    private func updateStatusIcon(connected: Bool) {
        guard let button = statusItem?.button else { return }
        if let image = NSImage(systemSymbolName: "cursorarrow.click.2", accessibilityDescription: "GhostUI") {
            let sizeConfig = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
            button.image = image.withSymbolConfiguration(sizeConfig)
        } else {
            button.title = "●"
        }
        button.alphaValue = connected ? 1.0 : 0.5
    }

    private func updateMenu() {
        let menu = NSMenu()

        let titleItem = NSMenuItem(title: "GhostUI v\(kGhostUIVersion)", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        menu.addItem(NSMenuItem.separator())

        let statusMenuItem = NSMenuItem(title: "Status: Running (N-API)", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)

        menu.addItem(NSMenuItem.separator())

        menu.addItem(NSMenuItem(title: "Control Panel", action: #selector(showControlPanel), keyEquivalent: ""))

        menu.addItem(NSMenuItem.separator())

        let a11yItem = NSMenuItem(title: "Show A11y Tree", action: #selector(toggleA11yOverlay), keyEquivalent: "")
        a11yItem.state = A11yTreeOverlay.shared.isActive ? .on : .off
        menu.addItem(a11yItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit GhostUI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quitItem)

        statusItem?.menu = menu
    }

    @objc private func showControlPanel() {
        ControlPanelWindow.shared.show()
    }

    @objc private func toggleA11yOverlay() {
        A11yTreeOverlay.shared.toggle()
        UserDefaults.standard.set(A11yTreeOverlay.shared.isActive, forKey: "showA11yTree")
        updateMenu()
    }

    // MARK: - Overlay Notifications (from daemon via NSDistributedNotification)

    private func registerOverlayNotifications() {
        let center = DistributedNotificationCenter.default()

        center.addObserver(
            self,
            selector: #selector(handleOverlayScanNotification(_:)),
            name: NSNotification.Name("org.ghostvm.GhostUI.overlay.scan"),
            object: nil
        )

        center.addObserver(
            self,
            selector: #selector(handleOverlayFlashNotification(_:)),
            name: NSNotification.Name("org.ghostvm.GhostUI.overlay.flash"),
            object: nil
        )

        center.addObserver(
            self,
            selector: #selector(handleOverlayDrawNotification(_:)),
            name: NSNotification.Name("org.ghostvm.GhostUI.overlay.draw"),
            object: nil
        )

        center.addObserver(
            self,
            selector: #selector(handleActorOverlayNotification(_:)),
            name: NSNotification.Name("org.ghostvm.GhostUI.overlay.actor"),
            object: nil
        )

        print("[GhostUI] Registered overlay notification observers")
    }

    @objc private func handleOverlayScanNotification(_ notification: Notification) {
        guard let payload = notification.userInfo?["payload"] as? String,
              let data = payload.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rectsArray = json["rects"] as? [[String: Any]] else {
            return
        }

        var rects: [CGRect] = []
        for r in rectsArray {
            guard let x = r["x"] as? Double,
                  let y = r["y"] as? Double,
                  let w = r["width"] as? Double,
                  let h = r["height"] as? Double else { continue }
            rects.append(CGRect(x: x, y: y, width: w, height: h))
        }

        var outlineRects: [CGRect] = []
        if let outlineArray = json["outlineRects"] as? [[String: Any]] {
            for r in outlineArray {
                guard let x = r["x"] as? Double,
                      let y = r["y"] as? Double,
                      let w = r["width"] as? Double,
                      let h = r["height"] as? Double else { continue }
                outlineRects.append(CGRect(x: x, y: y, width: w, height: h))
            }
        }

        let durationMs = json["durationMs"] as? Int ?? 500
        let direction = (json["direction"] as? String) ?? "top-to-bottom"
        ScanOverlayService.shared.playScan(
            rects: rects,
            outlineRects: outlineRects,
            durationMs: durationMs,
            direction: direction
        )
    }

    @objc private func handleOverlayDrawNotification(_ notification: Notification) {
        guard let payload = notification.userInfo?["payload"] as? String,
              let data = payload.data(using: .utf8) else {
            return
        }

        DrawOverlayService.shared.playDraw(jsonData: data)
    }

    @objc private func handleOverlayFlashNotification(_ notification: Notification) {
        guard let payload = notification.userInfo?["payload"] as? String,
              let data = payload.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let r = json["rect"] as? [String: Any],
              let x = r["x"] as? Double,
              let y = r["y"] as? Double,
              let w = r["width"] as? Double,
              let h = r["height"] as? Double else {
            return
        }

        FlashOverlayService.shared.playFlash(rect: CGRect(x: x, y: y, width: w, height: h))
    }

    @objc private func handleActorOverlayNotification(_ notification: Notification) {
        guard let payload = notification.userInfo?["payload"] as? String,
              let data = payload.data(using: .utf8) else {
            return
        }

        ActorOverlayService.shared.handle(jsonData: data)
    }

    // MARK: - Daemon (bun subprocess)

    private func startDaemon() {
        let bundle = Bundle.main
        let helpers = bundle.bundlePath + "/Contents/Helpers"
        let bunPath = helpers + "/bun"
        let daemonScript = bundle.bundlePath + "/Contents/Resources/ghost/src/daemon.ts"

        guard FileManager.default.fileExists(atPath: bunPath) else {
            print("[GhostUI] No embedded bun at \(bunPath), skipping daemon launch")
            return
        }
        guard FileManager.default.fileExists(atPath: daemonScript) else {
            print("[GhostUI] No daemon script at \(daemonScript), skipping daemon launch")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: bunPath)
        process.arguments = [daemonScript]
        process.environment = ProcessInfo.processInfo.environment
        do {
            process.environment?["GHOSTUI_AUTH_SECRET"] = try DaemonAuthService.shared.sharedSecret()
        } catch {
            print("[GhostUI] Failed to prepare daemon auth secret: \(error)")
            print("[GhostUI] Refusing to start daemon without an auth secret")
            NSApp.terminate(nil)
            return
        }
        // Tell daemon our PID so it can exit if we die
        process.environment?["GHOSTUI_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)

        // Log daemon output to /tmp/ghostui-daemon.log
        let logPath = "/tmp/ghostui-daemon.log"
        FileManager.default.createFile(atPath: logPath, contents: nil)
        let logHandle = FileHandle(forWritingAtPath: logPath)
        logHandle?.seekToEndOfFile()
        process.standardOutput = logHandle
        process.standardError = logHandle

        process.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                let code = proc.terminationStatus
                guard let self, !self.isTerminating else {
                    print("[GhostUI] Daemon stopped (code \(code))")
                    return
                }
                if code != 0 && code != 15 { // 15 = SIGTERM (normal shutdown)
                    print("[GhostUI] Daemon exited with code \(code), restarting...")
                    self.startDaemon()
                } else {
                    print("[GhostUI] Daemon stopped (code \(code))")
                }
            }
        }

        do {
            try process.run()
            daemonProcess = process
            print("[GhostUI] Daemon started (pid \(process.processIdentifier))")
        } catch {
            print("[GhostUI] Failed to start daemon: \(error)")
        }
    }

    private func stopDaemon() {
        guard let process = daemonProcess, process.isRunning else { return }
        print("[GhostUI] Stopping daemon (pid \(process.processIdentifier))")
        process.terminate()
        daemonProcess = nil
    }

}

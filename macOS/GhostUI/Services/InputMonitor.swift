import AppKit
import Foundation

/// Monitors global user input events and notifies the ghost daemon to refresh
/// the accessibility tree immediately, replacing old interval-based scans.
///
/// Uses NSEvent global monitor (works under Accessibility permission) plus
/// NSWorkspace notifications for app activation.
final class InputMonitor {
    static let shared = InputMonitor()

    private let triggerURL = URL(string: "http://localhost:7861/api/trigger")!
    private let debounceInterval: TimeInterval = 0.15

    private var globalMonitors: [Any] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    private var debounceWorkItem: DispatchWorkItem?
    private var isRunning = false

    private let queue = DispatchQueue(label: "org.ghostvm.InputMonitor", qos: .userInitiated)

    private init() {}

    func start() {
        guard !isRunning else { return }
        isRunning = true
        print("[InputMonitor] Starting input-driven trigger")

        installEventMonitors()
        observeAppActivation()
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false
        print("[InputMonitor] Stopping")

        removeEventMonitors()
        removeWorkspaceObservers()
        debounceWorkItem?.cancel()
        debounceWorkItem = nil
    }

    // MARK: - Event Monitors

    private func installEventMonitors() {
        let eventMask: NSEvent.EventTypeMask = [
            .leftMouseDown, .leftMouseUp, .leftMouseDragged,
            .rightMouseDown, .rightMouseUp,
            .keyDown, .keyUp,
            .scrollWheel,
            .flagsChanged,
        ]

        // Global monitor: catches events in other apps (requires Accessibility)
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: eventMask, handler: { [weak self] event in
            self?.onInputEvent(event)
        }) {
            globalMonitors.append(monitor)
            print("[InputMonitor] Installed global event monitor")
        } else {
            print("[InputMonitor] Failed to install global event monitor — check Accessibility permission")
        }

        // Local monitor: catches events in our own app
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: eventMask, handler: { [weak self] event in
            self?.onInputEvent(event)
            return event
        }) {
            globalMonitors.append(monitor)
        }
    }

    private func removeEventMonitors() {
        for monitor in globalMonitors {
            NSEvent.removeMonitor(monitor)
        }
        globalMonitors.removeAll()
    }

    // MARK: - App Activation

    private func observeAppActivation() {
        let center = NSWorkspace.shared.notificationCenter
        let names: [NSNotification.Name] = [
            NSWorkspace.didActivateApplicationNotification,
            NSWorkspace.activeSpaceDidChangeNotification,
            NSWorkspace.didTerminateApplicationNotification,
        ]
        for name in names {
            let obs = center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                self?.debounceWorkItem?.cancel()
                self?.debounceWorkItem = nil
                self?.sendTrigger()
            }
            workspaceObservers.append(obs)
        }
    }

    private func removeWorkspaceObservers() {
        let center = NSWorkspace.shared.notificationCenter
        for obs in workspaceObservers {
            center.removeObserver(obs)
        }
        workspaceObservers.removeAll()
    }

    // MARK: - Debounce & Trigger

    private func onInputEvent(_ event: NSEvent) {
        if event.type == .leftMouseUp || event.type == .rightMouseUp || event.type == .keyUp {
            debounceWorkItem?.cancel()
            debounceWorkItem = nil
            sendTrigger()
            return
        }
        debounceWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.sendTrigger()
        }
        debounceWorkItem = work
        queue.asyncAfter(deadline: .now() + debounceInterval, execute: work)
    }

    private func sendTrigger() {
        guard isRunning else { return }
        var request = URLRequest(url: triggerURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 1
        if let secret = try? DaemonAuthService.shared.sharedSecret() {
            request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        }
        URLSession.shared.dataTask(with: request).resume()
    }
}

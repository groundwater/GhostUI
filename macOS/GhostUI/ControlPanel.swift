import SwiftUI
import AppKit

// MARK: - Window Manager

final class ControlPanelWindow {
    static let shared = ControlPanelWindow()
    private var window: NSWindow?

    func show() {
        if let w = window {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let view = ControlPanelView()
        let hostingController = NSHostingController(rootView: view)
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 600),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        win.title = "GhostUI Control Panel"
        win.contentViewController = hostingController
        win.center()
        win.isReleasedWhenClosed = false
        win.setFrameAutosaveName("ControlPanel")
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window = win
    }
}

// MARK: - Main View

struct ControlPanelView: View {
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            TreeTab()
                .tabItem { Label("Tree", systemImage: "list.bullet.indent") }
                .tag(0)
            ElementsTab()
                .tabItem { Label("Elements", systemImage: "square.grid.2x2") }
                .tag(1)
            FocusedTab()
                .tabItem { Label("Focused", systemImage: "scope") }
                .tag(2)
            ActionsTab()
                .tabItem { Label("Actions", systemImage: "play.circle") }
                .tag(3)
            PermissionsTab()
                .tabItem { Label("Permissions", systemImage: "lock.shield") }
                .tag(4)
        }
        .frame(minWidth: 600, minHeight: 400)
    }
}

// MARK: - Tree Tab

struct TreeTab: View {
    @State private var depth = 3
    @State private var target: TargetOption = .front
    @State private var output = ""
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Picker("Target", selection: $target) {
                    ForEach(TargetOption.allCases) { t in
                        Text(t.label).tag(t)
                    }
                }
                .frame(width: 200)

                Stepper("Depth: \(depth)", value: $depth, in: 1...20)
                    .frame(width: 140)

                Spacer()

                Button(action: { output = "" }) {
                    Label("Clear", systemImage: "xmark.circle")
                }
                .disabled(output.isEmpty)

                Button(action: fetchTree) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .keyboardShortcut("r")
                .disabled(isLoading)
            }
            .padding(.horizontal)
            .padding(.top, 8)

            ScrollView {
                Text(output.isEmpty ? "Press Refresh to load the accessibility tree." : output)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .padding(.horizontal)
            .padding(.bottom, 8)
        }
    }

    private func fetchTree() {
        isLoading = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = buildTreeOutput()
            DispatchQueue.main.async {
                output = result
                isLoading = false
            }
        }
    }

    private func buildTreeOutput() -> String {
        let axTarget = target.axTarget
        do {
            let trees = try AccessibilityService.shared.getTree(maxDepth: depth, target: axTarget)
            if trees.isEmpty { return "No trees returned." }

            var out = ""
            for (i, tree) in trees.enumerated() {
                if trees.count > 1 {
                    out += "[\(i + 1)] \(tree.app) (\(tree.bundleId))\n"
                } else {
                    out += "\(tree.app) (\(tree.bundleId))\n"
                }
                if let w = tree.window { out += "Window: \(w)\n" }
                if let f = tree.frame {
                    out += "Frame: (\(Int(f.x)), \(Int(f.y)), \(Int(f.width))x\(Int(f.height)))\n"
                }
                out += "\n"
                if let node = tree.tree {
                    out += formatNode(node, prefix: "", isLast: true)
                } else {
                    out += "(no tree data)\n"
                }
                if i < trees.count - 1 { out += "\n" }
            }
            return out
        } catch {
            return "Error: \(error.localizedDescription)"
        }
    }

    private func formatNode(_ node: AccessibilityService.AXNode, prefix: String, isLast: Bool) -> String {
        var out = ""
        let connector = isLast ? "└─ " : "├─ "
        let childPrefix = isLast ? "   " : "│  "

        var line = "\(prefix)\(connector)\(node.role ?? "?")"
        if let l = node.label, !l.isEmpty { line += " \"\(l)\"" }
        else if let t = node.title, !t.isEmpty { line += " \"\(t)\"" }
        if let v = node.value, !v.isEmpty { line += " = \"\(v)\"" }
        out += line + "\n"

        if let children = node.children {
            for (i, child) in children.enumerated() {
                out += formatNode(child, prefix: prefix + childPrefix, isLast: i == children.count - 1)
            }
        }
        return out
    }
}

// MARK: - Elements Tab

struct ElementsTab: View {
    @State private var elements: [AccessibilityService.InteractiveElement] = []
    @State private var scrollState: AccessibilityService.ScrollState?
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("\(elements.count) interactive elements")
                    .foregroundStyle(.secondary)
                Spacer()
                if let ss = scrollState {
                    let dirs = [
                        ss.canScrollUp ? "up" : nil,
                        ss.canScrollDown ? "down" : nil,
                        ss.canScrollLeft ? "left" : nil,
                        ss.canScrollRight ? "right" : nil
                    ].compactMap { $0 }
                    if !dirs.isEmpty {
                        Text("Scroll: \(dirs.joined(separator: ", "))")
                            .foregroundStyle(.secondary)
                    }
                }
                Button(action: { elements = []; scrollState = nil }) {
                    Label("Clear", systemImage: "xmark.circle")
                }
                .disabled(elements.isEmpty)

                Button(action: fetchElements) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .keyboardShortcut("r")
                .disabled(isLoading)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            Table(elements, columns: {
                TableColumn("ID") { e in
                    Text("\(e.id)").monospacedDigit()
                }
                .width(min: 30, ideal: 40, max: 50)

                TableColumn("Role") { e in
                    Text(e.role.replacingOccurrences(of: "AX", with: ""))
                        .font(.system(.body, design: .monospaced))
                }
                .width(min: 60, ideal: 90, max: 120)

                TableColumn("Label") { e in
                    Text(e.label ?? e.title ?? "")
                }
                .width(min: 100, ideal: 200)

                TableColumn("Value") { e in
                    Text(e.value ?? "")
                        .foregroundStyle(.secondary)
                }
                .width(min: 60, ideal: 100)

                TableColumn("Frame") { e in
                    Text("(\(Int(e.frame.x)), \(Int(e.frame.y))) \(Int(e.frame.width))x\(Int(e.frame.height))")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .width(min: 100, ideal: 140)
            })
        }
    }

    private func fetchElements() {
        isLoading = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = AccessibilityService.shared.getInteractiveElements()
            DispatchQueue.main.async {
                elements = result.elements
                scrollState = result.scrollState
                isLoading = false
            }
        }
    }
}

// MARK: - Focused Tab

struct FocusedTab: View {
    @State private var output = ""
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Spacer()
                Button(action: { output = "" }) {
                    Label("Clear", systemImage: "xmark.circle")
                }
                .disabled(output.isEmpty)

                Button(action: fetchFocused) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .keyboardShortcut("r")
                .disabled(isLoading)
            }
            .padding(.horizontal)
            .padding(.top, 8)

            ScrollView {
                Text(output.isEmpty ? "Press Refresh to inspect the focused element." : output)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .padding(.horizontal)
            .padding(.bottom, 8)
        }
    }

    private func fetchFocused() {
        isLoading = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = buildFocusedOutput()
            DispatchQueue.main.async {
                output = result
                isLoading = false
            }
        }
    }

    private func buildFocusedOutput() -> String {
        do {
            let info = try AccessibilityService.shared.getFocusedElement()
            var lines: [String] = []
            if let role = info["role"] as? String {
                lines.append("Role:    \(role)")
            }
            if let title = info["title"] as? String {
                lines.append("Title:   \"\(title)\"")
            }
            if let label = info["label"] as? String {
                lines.append("Label:   \"\(label)\"")
            }
            if let value = info["value"] as? String {
                lines.append("Value:   \"\(value)\"")
            }
            if let focused = info["focused"] as? Bool {
                lines.append("Focused: \(focused)")
            }
            if let actions = info["actions"] as? [String] {
                lines.append("Actions: \(actions.joined(separator: ", "))")
            }
            return lines.isEmpty ? "No focused element" : lines.joined(separator: "\n")
        } catch {
            return "Error: \(error.localizedDescription)"
        }
    }
}

// MARK: - Actions Tab

struct ActionsTab: View {
    @State private var label = ""
    @State private var role = ""
    @State private var value = ""
    @State private var axAction = "AXPress"
    @State private var menuPath = ""
    @State private var output = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            GroupBox("Click / Action") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        TextField("Label", text: $label)
                            .textFieldStyle(.roundedBorder)
                        TextField("Role (optional)", text: $role)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 140)
                    }
                    HStack {
                        TextField("AX Action", text: $axAction)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 140)
                        Button("Click (AXPress)") { performAction("AXPress") }
                            .disabled(label.isEmpty)
                        Button("Custom Action") { performAction(axAction) }
                            .disabled(label.isEmpty)
                    }
                }
                .padding(4)
            }

            GroupBox("Set Value") {
                HStack {
                    TextField("Value to set", text: $value)
                        .textFieldStyle(.roundedBorder)
                    Button("Set on Focused") { setValueOnElement(targetLabel: nil) }
                        .disabled(value.isEmpty)
                    Button("Set on Label") { setValueOnElement(targetLabel: label.isEmpty ? nil : label) }
                        .disabled(value.isEmpty || label.isEmpty)
                }
                .padding(4)
            }

            GroupBox("Menu") {
                HStack {
                    TextField("Menu path (e.g. File > New Window)", text: $menuPath)
                        .textFieldStyle(.roundedBorder)
                    Button("Trigger") { triggerMenu() }
                        .disabled(menuPath.isEmpty)
                }
                .padding(4)
            }

            HStack {
                Spacer()
                Button(action: { output = "" }) {
                    Label("Clear", systemImage: "xmark.circle")
                }
                .disabled(output.isEmpty)
            }

            ScrollView {
                Text(output.isEmpty ? "Action results will appear here." : output)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .padding()
    }

    private func performAction(_ action: String) {
        let l = label, r = role.isEmpty ? nil : role
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try AccessibilityService.shared.performAction(label: l, role: r, action: action)
                DispatchQueue.main.async { output = "OK — \(action) on \"\(l)\"" }
            } catch {
                DispatchQueue.main.async { output = "Error: \(error.localizedDescription)" }
            }
        }
    }

    private func setValueOnElement(targetLabel: String?) {
        let v = value, r = role.isEmpty ? nil : role
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try AccessibilityService.shared.setValue(v, label: targetLabel, role: r)
                DispatchQueue.main.async { output = "OK — set value to \"\(v)\"" }
            } catch {
                DispatchQueue.main.async { output = "Error: \(error.localizedDescription)" }
            }
        }
    }

    private func triggerMenu() {
        let parts = menuPath.components(separatedBy: ">").map { $0.trimmingCharacters(in: .whitespaces) }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try AccessibilityService.shared.triggerMenuItem(path: parts)
                DispatchQueue.main.async { output = "OK — menu: \(parts.joined(separator: " > "))" }
            } catch {
                DispatchQueue.main.async { output = "Error: \(error.localizedDescription)" }
            }
        }
    }
}

// MARK: - Permissions Tab

struct PermissionsTab: View {
    @State private var axGranted = false
    @State private var screenGranted = false
    @State private var timer: Timer?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Circle()
                    .fill(axGranted ? Color.green : Color.red)
                    .frame(width: 12, height: 12)
                Text("Accessibility")
                    .font(.headline)
                Spacer()
                Text(axGranted ? "Granted" : "Denied")
                    .foregroundStyle(axGranted ? .green : .red)
            }

            HStack(spacing: 12) {
                Circle()
                    .fill(screenGranted ? Color.green : Color.red)
                    .frame(width: 12, height: 12)
                Text("Screen Recording")
                    .font(.headline)
                Spacer()
                Text(screenGranted ? "Granted" : "Denied")
                    .foregroundStyle(screenGranted ? .green : .red)
            }

            Spacer()

            Text("Permissions are checked every 2 seconds.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .onAppear { startPermissionChecks() }
        .onDisappear { timer?.invalidate(); timer = nil }
    }

    private func startPermissionChecks() {
        checkNow()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
            checkNow()
        }
    }

    private func checkNow() {
        axGranted = AccessibilityService.hasAccessibilityPermission()
        screenGranted = ScreenshotService.hasScreenRecordingPermission()
    }
}

// MARK: - Target Option

enum TargetOption: String, CaseIterable, Identifiable {
    case front, visible, all
    var id: String { rawValue }

    var label: String {
        switch self {
        case .front: return "Frontmost App"
        case .visible: return "Visible Apps"
        case .all: return "All Apps"
        }
    }

    var axTarget: AccessibilityService.AXTarget {
        switch self {
        case .front: return .front
        case .visible: return .visible
        case .all: return .all
        }
    }
}

// MARK: - Table Conformance

extension AccessibilityService.InteractiveElement: Identifiable {}

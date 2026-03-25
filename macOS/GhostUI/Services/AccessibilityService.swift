import AppKit
import ApplicationServices

extension String {
    var xmlEscaped: String {
        self.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}

/// Service for reading the accessibility tree of the focused application
final class AccessibilityService {
    static let shared = AccessibilityService()
    private init() {}

    // MARK: - Element Cache (persists between screenshot and click/scroll/read)

    struct CachedElement {
        let axElement: AXUIElement
        let frame: AXFrame
        let role: String
        let label: String?
        let title: String?
    }

    private var elementCache: [Int: CachedElement] = [:]

    func lookupCachedElement(index: Int) -> CachedElement? {
        return elementCache[index]
    }

    struct AXNode: Codable {
        struct AXValueRange: Codable {
            let min: Double?
            let max: Double?
            let step: Double?
        }

        struct AXSettable: Codable {
            let enabled: Bool?
            let selected: Bool?
            let value: Bool?
            let position: Bool?
            let size: Bool?
            let focused: Bool?
            let expanded: Bool?
        }

        struct AXInteractionHints: Codable {
            let primaryAction: String?
            let clickPoint: String?
            let dragStartPoint: String?
            let selectLength: Int?
            let editable: Bool?
            let confidence: String?
        }

        struct AXCapabilities: Codable {
            let enabled: Bool?
            let selected: Bool?
            let focused: Bool?
            let expanded: Bool?
            let checked: Bool?
            let mixed: Bool?
            let canClick: Bool
            let canSelect: Bool
            let canHover: Bool?
            let canFocus: Bool?
            let canType: Bool?
            let canScroll: Bool?
            let scrollAxis: String?
            let scrollDirections: [String]?
            let scrollValueV: Double?
            let scrollValueH: Double?
            let canExpand: Bool?
            let canOpenMenu: Bool?
            let canContextMenu: Bool?
            let canIncrement: Bool?
            let canDecrement: Bool?
            let canConfirm: Bool?
            let canDismiss: Bool?
            let canToggle: Bool?
            let canSetValue: Bool?
            let canDrag: Bool?
            let dragType: String?
            let valueType: String?
            let range: AXValueRange?
            let actions: [String]?
            let settable: AXSettable?
            let interactionHints: AXInteractionHints?
        }

        let role: String?
        let subrole: String?
        let title: String?
        let label: String?
        let value: String?
        let identifier: String?
        let placeholder: String?
        let frame: AXFrame?
        let visible: Bool?
        let capabilities: AXCapabilities?
        let children: [AXNode]?

        /// Roles that represent interactive UI elements (buttons, inputs, toggles, etc.)
        static let interactivePruneRoles: Set<String> = [
            "AXButton", "AXPopUpButton", "AXMenuButton", "AXComboBox",
            "AXTextField", "AXTextArea", "AXSearchField",
            "AXCheckBox", "AXRadioButton", "AXSwitch",
            "AXLink", "AXTab", "AXMenuItem", "AXMenuBarItem",
            "AXSlider", "AXIncrementor",
            "AXDisclosureTriangle",
            "AXColorWell", "AXDateField",
            "AXSegmentedControl",
            "AXScrollArea", "AXScrollBar",
        ]

        /// True when this node is a menu separator (non-actionable divider line).
        /// Detected by: AXMenuItem with no title/label/value and <=12px height,
        /// or explicit AXSeparatorMenuItem subrole.
        var isMenuSeparator: Bool {
            guard role == "AXMenuItem" else { return false }
            if subrole == "AXSeparatorMenuItem" { return true }
            // Anonymous MenuItem with tiny height = separator
            if title == nil, label == nil, (value == nil || value?.isEmpty == true) {
                if let f = frame, f.height <= 12 { return true }
            }
            return false
        }

        /// Best display tag for this node. Groups use subrole or inferred layout direction.
        var displayTag: String {
            let r = role ?? "Unknown"
            // Menu separators → "Separator"
            if isMenuSeparator { return "Separator" }
            if r == "AXGroup" {
                if let sr = subrole, !sr.isEmpty {
                    return sr.hasPrefix("AX") ? String(sr.dropFirst(2)) : sr
                }
                // Infer HStack/VStack from children layout
                if let kids = children, kids.count >= 2 {
                    let frames = kids.compactMap { $0.frame }
                    if frames.count >= 2 {
                        let pairs = zip(frames, frames.dropFirst())
                        var hScore = 0, vScore = 0
                        for (a, b) in pairs {
                            if abs(a.y - b.y) < min(a.height, b.height) * 0.5 {
                                hScore += 1
                            } else {
                                vScore += 1
                            }
                        }
                        return hScore > vScore ? "HStack" : "VStack"
                    }
                }
                return "Group"
            }
            return r.hasPrefix("AX") ? String(r.dropFirst(2)) : r
        }

        /// Prune this tree: drop branches with no interactive leaves,
        /// collapse single-child non-interactive intermediaries.
        func pruned(includeText: Bool = false) -> AXNode? {
            // Menu separators are non-actionable dividers — drop them entirely
            if isMenuSeparator { return nil }

            let effectiveRoles = includeText ? Self.interactivePruneRoles.union(["AXStaticText"]) : Self.interactivePruneRoles
            let isInteractive = role.map { effectiveRoles.contains($0) } ?? false

            // Recursively prune children
            let prunedChildren = (children ?? []).compactMap { $0.pruned(includeText: includeText) }

            // Leaf with no interactive role: drop
            if prunedChildren.isEmpty && !isInteractive {
                return nil
            }

            // Non-interactive node with exactly 1 child: collapse
            if !isInteractive && prunedChildren.count == 1 {
                return prunedChildren[0]
            }

            return AXNode(
                role: role, subrole: subrole, title: title, label: label, value: value,
                identifier: identifier, placeholder: placeholder,
                frame: frame, visible: visible,
                capabilities: capabilities,
                children: prunedChildren.isEmpty ? nil : prunedChildren
            )
        }

        /// Serialize this node (and children) to XML
        func toXML(
            indent: String = "",
            includeFrame: Bool = false,
            includeVisibility: Bool = false,
            includeRole: Bool = false,
            includeSubrole: Bool = false,
            runningAppNames: Set<String>? = nil
        ) -> String {
            let tag = displayTag
            let collapsibleStructuralTags: Set<String> = ["Group", "HStack", "VStack"]
            var hiddenTrimmedCount = 0
            let serializedChildren: [AXNode]? = {
                guard let children else { return nil }
                // Menu bar items expose AXMenu children even when closed; hide them unless selected/open.
                var filteredChildren = children
                if role == "AXMenuBarItem", capabilities?.selected != true {
                    filteredChildren = filteredChildren.filter { $0.role != "AXMenu" }
                }

                // Trim hidden descendants from XML output and summarize count.
                if includeVisibility {
                    filteredChildren = filteredChildren.filter { child in
                        if child.visible == false {
                            hiddenTrimmedCount += 1
                            return false
                        }
                        return true
                    }
                }

                return filteredChildren.isEmpty ? nil : filteredChildren
            }()
            let hasChildren = !(serializedChildren?.isEmpty ?? true)
            let inlineStaticText = (tag == "StaticText") && !hasChildren && (value?.isEmpty == false)
            var xml = indent + "<\(tag)"
            var hasAnyAttributes = false
            if let title = title {
                xml += " title=\"\(title.xmlEscaped)\""
                hasAnyAttributes = true
            }
            if let label = label {
                xml += " label=\"\(label.xmlEscaped)\""
                hasAnyAttributes = true
            }
            if let value = value, !value.isEmpty, !inlineStaticText {
                xml += " value=\"\(value.xmlEscaped)\""
                hasAnyAttributes = true
            }
            if includeRole, let role = role {
                xml += " role=\"\(role.xmlEscaped)\""
                hasAnyAttributes = true
            }
            if includeSubrole, let subrole = subrole {
                let typeValue = subrole.hasPrefix("AX") ? String(subrole.dropFirst(2)) : subrole
                xml += " type=\"\(typeValue.xmlEscaped)\""
                hasAnyAttributes = true
            }
            if includeVisibility, let visible = visible {
                if !visible {
                    xml += " hidden"
                    hasAnyAttributes = true
                }
            }
            if let caps = capabilities {
                let layoutOnlyTags: Set<String> = ["Group", "HStack", "VStack"]
                if let enabled = caps.enabled {
                    if !enabled {
                        xml += " disabled"
                        hasAnyAttributes = true
                    }
                }
                if let selected = caps.selected {
                    if selected {
                        xml += " selected"
                        hasAnyAttributes = true
                    }
                }
                if caps.canClick, let frame = frame, !layoutOnlyTags.contains(tag) {
                    let cx = Int(frame.x + (frame.width / 2.0))
                    let cy = Int(frame.y + (frame.height / 2.0))
                    xml += " click=(\(cx),\(cy))"
                    hasAnyAttributes = true
                }
                if caps.canContextMenu == true, let frame = frame, !layoutOnlyTags.contains(tag) {
                    let cx = Int(frame.x + (frame.width / 2.0))
                    let cy = Int(frame.y + (frame.height / 2.0))
                    xml += " rightClick=(\(cx),\(cy))"
                    hasAnyAttributes = true
                }
                if caps.canDrag == true, let frame = frame, !layoutOnlyTags.contains(tag) {
                    let cx = Int(frame.x + (frame.width / 2.0))
                    let cy = Int(frame.y + (frame.height / 2.0))
                    xml += " drag=(\(cx),\(cy))"
                    hasAnyAttributes = true
                }
                if let axis = caps.scrollAxis, !axis.isEmpty {
                    xml += " scroll=\"\(axis.xmlEscaped)\""
                    hasAnyAttributes = true
                }
                if let dirs = caps.scrollDirections, !dirs.isEmpty {
                    xml += " scrollDir=\"\(dirs.joined(separator: ",").xmlEscaped)\""
                    hasAnyAttributes = true
                }
                let textSelectableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]
                if caps.canSelect, let role = role, textSelectableRoles.contains(role) {
                    let selectCount = value?.count ?? 0
                    if selectCount > 0 {
                        xml += " select=\(selectCount)"
                        hasAnyAttributes = true
                    }
                }
            }
            if includeFrame, let frame = frame {
                xml += " frame=\"\(Int(frame.x)),\(Int(frame.y)),\(Int(frame.width))x\(Int(frame.height))\""
                hasAnyAttributes = true
            }

            // Collapse/omit noisy structural wrappers that add no information.
            if collapsibleStructuralTags.contains(tag), !hasAnyAttributes, hiddenTrimmedCount == 0, serializedChildren == nil {
                return ""
            }
            if collapsibleStructuralTags.contains(tag), !hasAnyAttributes, hiddenTrimmedCount == 0, let children = serializedChildren {
                let renderedAtSameLevel = children.compactMap { child -> String? in
                    let childXML = child.toXML(
                        indent: indent,
                        includeFrame: includeFrame,
                        includeVisibility: includeVisibility,
                        includeRole: includeRole,
                        includeSubrole: includeSubrole,
                        runningAppNames: runningAppNames
                    )
                    return childXML.isEmpty ? nil : childXML
                }
                if renderedAtSameLevel.count == 1 {
                    return renderedAtSameLevel[0]
                }
                if renderedAtSameLevel.isEmpty {
                    return ""
                }
            }

            if hasChildren {
                let renderedChildren = serializedChildren!.compactMap { child -> String? in
                    let childXML = child.toXML(
                        indent: indent + "  ",
                        includeFrame: includeFrame,
                        includeVisibility: includeVisibility,
                        includeRole: includeRole,
                        includeSubrole: includeSubrole,
                        runningAppNames: runningAppNames
                    )
                    return childXML.isEmpty ? nil : childXML
                }

                if renderedChildren.isEmpty && hiddenTrimmedCount == 0 {
                    return ""
                }

                xml += ">\n"
                for childXML in renderedChildren {
                    xml += childXML
                }
                if hiddenTrimmedCount > 0 {
                    xml += indent + "  <Hidden count=\(hiddenTrimmedCount) />\n"
                }
                xml += indent + "</\(tag)>\n"
            } else if inlineStaticText, let text = value {
                xml += ">\(text.xmlEscaped)</\(tag)>\n"
            } else {
                xml += " />\n"
            }
            return xml
        }

        /// Serialize this tree to a complete XML document
        func toXMLDocument(
            includeFrame: Bool = false,
            includeVisibility: Bool = false,
            includeRole: Bool = false,
            includeSubrole: Bool = false
        ) -> String {
            let runningNames = Set(
                NSWorkspace.shared.runningApplications.compactMap { $0.localizedName }
            )
            return toXML(
                includeFrame: includeFrame,
                includeVisibility: includeVisibility,
                includeRole: includeRole,
                includeSubrole: includeSubrole,
                runningAppNames: runningNames
            )
        }
    }

    /// Trim a pruned tree to target depth
    func limitDepth(_ node: AXNode?, maxDepth: Int, currentDepth: Int = 0) -> AXNode? {
        guard let node = node else { return nil }

        if currentDepth >= maxDepth {
            // At maxDepth: return node without children
            return AXNode(
                role: node.role, subrole: node.subrole, title: node.title, label: node.label,
                value: node.value, identifier: node.identifier, placeholder: node.placeholder,
                frame: node.frame, visible: node.visible, capabilities: node.capabilities,
                children: nil
            )
        }

        // Recursively limit children
        let limitedChildren = node.children?.compactMap {
            limitDepth($0, maxDepth: maxDepth, currentDepth: currentDepth + 1)
        }

        return AXNode(
            role: node.role, subrole: node.subrole, title: node.title, label: node.label,
            value: node.value, identifier: node.identifier, placeholder: node.placeholder,
            frame: node.frame, visible: node.visible, capabilities: node.capabilities,
            children: limitedChildren?.isEmpty == true ? nil : limitedChildren
        )
    }

    struct AXFrame: Codable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    struct AXTreeResponse: Codable {
        let app: String
        let bundleId: String
        let pid: Int32
        let window: String?
        let frame: AXFrame?
        let tree: AXNode?
        let menuBar: AXNode?

        enum CodingKeys: String, CodingKey {
            case app, bundleId, pid, window, frame, tree, menuBar
        }
    }

    struct ActionResult: Codable {
        let ok: Bool
        let message: String?
    }

    /// Lightweight snapshot for detecting a11y tree changes
    struct A11ySnapshot {
        let elementCount: Int
        let windowTitle: String?
        let hasWebAreaWithChildren: Bool
        let timestamp: Date

        func hasLargeChangeTo(_ other: A11ySnapshot) -> Bool {
            // Element count changed by 5+ OR
            // Web area with children appeared OR
            // Window title changed (different app/page)
            let countDelta = abs(other.elementCount - self.elementCount)
            return countDelta >= 5
                || (other.hasWebAreaWithChildren && !self.hasWebAreaWithChildren)
                || other.windowTitle != self.windowTitle
        }

        func hasAnyChangeTo(_ other: A11ySnapshot) -> Bool {
            return other.elementCount != self.elementCount
                || other.windowTitle != self.windowTitle
                || other.hasWebAreaWithChildren != self.hasWebAreaWithChildren
        }
    }

    /// Expected type of change after an action
    enum ExpectChange {
        case navigation  // Large change + stabilization (launch, navigate URL, etc.)
        case update      // Any change (type text, click button)
        case none        // No wait (queries, mouse move)
    }

    /// Specifies which process(es) to target for accessibility queries/actions.
    enum AXTarget: Equatable {
        case front
        case visible
        case all
        case pid(pid_t)
        case app(String)

        init?(queryValue: String) {
            switch queryValue {
            case "front": self = .front
            case "visible": self = .visible
            case "all": self = .all
            default:
                if queryValue.hasPrefix("pid:"), let p = Int32(queryValue.dropFirst(4)) {
                    self = .pid(p)
                } else if queryValue.hasPrefix("app:") {
                    self = .app(String(queryValue.dropFirst(4)))
                } else {
                    return nil
                }
            }
        }

        var isMulti: Bool { self == .visible || self == .all }
    }

    enum AXServiceError: Error, LocalizedError {
        case permissionDenied
        case noFocusedApp
        case noWindow
        case elementNotFound(String)
        case actionFailed(String)
        case menuNotFound(String)
        case appNotFound(String)
        case multiTargetNotAllowed

        var errorDescription: String? {
            switch self {
            case .permissionDenied: return "Accessibility permission denied"
            case .noFocusedApp: return "No focused application"
            case .noWindow: return "No focused window"
            case .elementNotFound(let label): return "Element not found: \(label)"
            case .actionFailed(let msg): return "Action failed: \(msg)"
            case .menuNotFound(let path): return "Menu item not found: \(path)"
            case .appNotFound(let id): return "Application not found: \(id)"
            case .multiTargetNotAllowed: return "Multi-target (--all/--visible) not allowed for actions"
            }
        }
    }

    /// Reliable accessibility permission check.
    /// Queries Finder's AXRoleAttribute — Finder is always running and
    /// responsive, so this gives a stable, definitive answer. Returns true
    /// only if we can actually read cross-process AX data.
    static func hasAccessibilityPermission() -> Bool {
        guard let finder = NSRunningApplication.runningApplications(
            withBundleIdentifier: "com.apple.finder"
        ).first else {
            return AXIsProcessTrusted()
        }
        let appElement = AXUIElementCreateApplication(finder.processIdentifier)
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(
            appElement, kAXRoleAttribute as CFString, &value
        )
        return result == .success && (value as? String) == "AXApplication"
    }

    // MARK: - Target Resolution

    /// Check for system dialog windows (Gatekeeper, crash reporters, TCC prompts)
    /// that sit above normal apps at layer 8. Returns AX-accessible system dialog
    /// PIDs if any are on screen, empty otherwise.
    /// Bundle IDs of system UI processes that have non-zero layer windows
    /// but are NOT blocking alerts (Notification Center, etc.)
    private static let nonAlertSystemBundleIDs: Set<String> = [
        "com.apple.notificationcenterui",
        "com.apple.controlcenter",
        "com.apple.WindowManager",
        "com.apple.launchpad.launcher",
        "com.apple.Spotlight",
    ]

    /// Bundle IDs of system chrome that should never appear in visible targets.
    /// These processes have on-screen windows but no useful a11y content for users.
    private static let systemChromeBundleIDs: Set<String> = [
        "com.apple.notificationcenterui",
        "com.apple.controlcenter",
        "com.apple.WindowManager",
    ]

    private func detectSystemDialogs() -> [(pid: pid_t, app: NSRunningApplication?)] {
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] else {
            return []
        }

        var seen = Set<pid_t>()
        var results: [(pid: pid_t, app: NSRunningApplication?)] = []

        for info in windowList {
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t else { continue }
            let layer = info[kCGWindowLayer as String] as? Int ?? 0

            // System dialogs live at layer 8 (above normal windows at 0, below menu bar at 25)
            guard layer > 0 && layer < 25 else { continue }

            // Must have a visible-sized window
            if let bounds = info[kCGWindowBounds as String] as? [String: Any] {
                let w = bounds["Width"] as? Int ?? 0
                let h = bounds["Height"] as? Int ?? 0
                if w < 20 || h < 20 { continue }
            }

            guard seen.insert(pid).inserted else { continue }

            // Skip known system UI processes that aren't blocking alerts
            let app = NSRunningApplication(processIdentifier: pid)
            if let bundleId = app?.bundleIdentifier,
               Self.nonAlertSystemBundleIDs.contains(bundleId) {
                continue
            }

            // Verify AX-accessible before including
            let appElement = AXUIElementCreateApplication(pid)
            var roleValue: CFTypeRef?
            let roleResult = AXUIElementCopyAttributeValue(appElement, kAXRoleAttribute as CFString, &roleValue)
            if roleResult == .cannotComplete || roleResult == .notImplemented { continue }

            results.append((pid, app))
        }

        return results
    }

    /// Detect if there's a modal dialog in the specified application
    /// Returns (hasModal, modalWindow, modalInfo) tuple
    func detectAppModal(for pid: pid_t) -> (hasModal: Bool, modalWindow: AXUIElement?, modalInfo: String?) {
        let appElement = AXUIElementCreateApplication(pid)

        let modalRoles: Set<String> = ["AXSheet", "AXDialog", "AXPopover"]

        // Get focused window
        var focusedWindowValue: CFTypeRef?
        let focusedResult = AXUIElementCopyAttributeValue(
            appElement,
            kAXFocusedWindowAttribute as CFString,
            &focusedWindowValue
        )

        guard focusedResult == .success, let focusedWindow = focusedWindowValue else {
            return (false, nil, nil)
        }

        let windowElement = focusedWindow as! AXUIElement

        // Check if the focused window itself is a modal (e.g. AXSheet can be
        // reported as the focused "window" rather than a child of the window)
        if let windowRole = getStringAttribute(windowElement, kAXRoleAttribute),
           modalRoles.contains(windowRole) {
            let label = getStringAttribute(windowElement, kAXDescriptionAttribute)
                     ?? getStringAttribute(windowElement, kAXTitleAttribute) ?? ""
            let modalInfo = "\(windowRole)\(label.isEmpty ? "" : ": \"\(label)\"")"
            return (true, windowElement, modalInfo)
        }

        // Get window children
        var childrenValue: CFTypeRef?
        let childrenResult = AXUIElementCopyAttributeValue(
            windowElement,
            kAXChildrenAttribute as CFString,
            &childrenValue
        )

        guard childrenResult == .success, let children = childrenValue as? [AXUIElement] else {
            return (false, nil, nil)
        }

        // Check children for modal overlay roles
        for child in children {
            if let role = getStringAttribute(child, kAXRoleAttribute) {
                if modalRoles.contains(role) {
                    // Get modal title if available
                    let title = getStringAttribute(child, kAXTitleAttribute) ?? ""
                    let modalInfo = "\(role)\(title.isEmpty ? "" : ": \"\(title)\"")"
                    // Return the window element, not the child sheet, so we can search all children
                    return (true, windowElement, modalInfo)
                }
            }
        }

        return (false, nil, nil)
    }

    /// Detect if there's a system alert currently displayed
    /// Returns (hasAlert, alertInfo) tuple
    func detectSystemAlert() -> (hasAlert: Bool, alertInfo: String?) {
        let dialogs = detectSystemDialogs()

        if let first = dialogs.first {
            let processName = first.app?.localizedName ?? "Unknown"
            let alertInfo = "\(processName) (PID: \(first.pid))"
            return (true, alertInfo)
        }

        return (false, nil)
    }

    /// More reliable foreground app detection than NSWorkspace alone.
    /// Uses AX system focus first (kAXFocusedApplicationAttribute), then falls back.
    func getFrontmostApplication() -> NSRunningApplication? {
        let systemWide = AXUIElementCreateSystemWide()
        var focusedAppValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(systemWide, kAXFocusedApplicationAttribute as CFString, &focusedAppValue)
        if result == .success, let focusedApp = focusedAppValue {
            let appElement = focusedApp as! AXUIElement
            var pid: pid_t = 0
            AXUIElementGetPid(appElement, &pid)
            if pid != 0, let app = NSRunningApplication(processIdentifier: pid) {
                return app
            }
        }
        return NSWorkspace.shared.frontmostApplication
    }

    /// Capture AX trees for system-level alert/dialog processes (TCC, Gatekeeper, etc.)
    /// regardless of frontmost app.
    func getSystemAlertTrees(maxDepth: Int = 200) -> [AXTreeResponse] {
        let targets = detectSystemDialogs()
        var results: [AXTreeResponse] = []

        for (pid, app) in targets {
            let appElement = AXUIElementCreateApplication(pid)

            // Skip non-AX-accessible processes
            var roleValue: CFTypeRef?
            let roleResult = AXUIElementCopyAttributeValue(appElement, kAXRoleAttribute as CFString, &roleValue)
            if roleResult == .cannotComplete || roleResult == .notImplemented {
                continue
            }

            // Fetch menu bar if present
            var menuBarValue: CFTypeRef?
            let menuBarResult = AXUIElementCopyAttributeValue(appElement, kAXMenuBarAttribute as CFString, &menuBarValue)
            let menuBarNode: AXNode? = (menuBarResult == .success && menuBarValue != nil)
                ? buildNode(element: menuBarValue as! AXUIElement, depth: 0, maxDepth: maxDepth)
                : nil

            // Prefer focused window; fallback to main window; fallback to app root
            var windowValue: CFTypeRef?
            let focusedResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
            if focusedResult == .success, let focusedWindow = windowValue {
                results.append(
                    buildResponse(
                        pid: pid,
                        app: app,
                        windowElement: focusedWindow as! AXUIElement,
                        menuBar: menuBarNode,
                        maxDepth: maxDepth,
                        includeCapabilities: false
                    )
                )
                continue
            }

            let mainResult = AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &windowValue)
            if mainResult == .success, let mainWindow = windowValue {
                results.append(
                    buildResponse(
                        pid: pid,
                        app: app,
                        windowElement: mainWindow as! AXUIElement,
                        menuBar: menuBarNode,
                        maxDepth: maxDepth,
                        includeCapabilities: false
                    )
                )
                continue
            }

            results.append(
                buildResponse(
                    pid: pid,
                    app: app,
                    windowElement: appElement,
                    menuBar: menuBarNode,
                    maxDepth: maxDepth,
                    includeCapabilities: false
                )
            )
        }

        return results
    }

    /// Resolve an AXTarget to a list of (pid, app) pairs.
    /// System dialogs (Gatekeeper, crash reporters, TCC prompts) steal focus —
    /// if one is on screen, it is returned instead of the requested target.
    private func resolveTarget(_ target: AXTarget) throws -> [(pid: pid_t, app: NSRunningApplication?)] {
        // System dialogs steal focus for front/visible/app targets
        switch target {
        case .front, .visible, .app(_):
            let systemDialogs = detectSystemDialogs()
            if !systemDialogs.isEmpty {
                return systemDialogs
            }
        case .pid(_), .all:
            break  // explicit PID and .all bypass system dialog stealing
        }

        switch target {
        case .front:
            guard let frontApp = getFrontmostApplication() else {
                throw AXServiceError.noFocusedApp
            }
            return [(frontApp.processIdentifier, frontApp)]
        case .pid(let pid):
            let app = NSRunningApplication(processIdentifier: pid)
            return [(pid, app)]
        case .app(let bundleId):
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            guard !apps.isEmpty else {
                throw AXServiceError.appNotFound(bundleId)
            }
            return apps.map { ($0.processIdentifier, $0) }
        case .visible:
            guard let frontApp = getFrontmostApplication() else {
                throw AXServiceError.noFocusedApp
            }
            let frontPID = frontApp.processIdentifier

            guard let windowList = CGWindowListCopyWindowInfo(
                [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
            ) as? [[String: Any]] else {
                return [(frontPID, frontApp)]
            }

            let ownPID = ProcessInfo.processInfo.processIdentifier
            var seen = Set<pid_t>()
            var results: [(pid: pid_t, app: NSRunningApplication?)] = []

            // Window list is front-to-back. Collect overlays in front of the
            // frontmost app (system dialogs, TCC prompts), then the frontmost
            // app itself, then stop — everything behind it is background noise.
            for info in windowList {
                guard let pid = info[kCGWindowOwnerPID as String] as? pid_t else { continue }

                // Skip our own windows (overlays, A11y Tree panel)
                if pid == ownPID { continue }

                let layer = info[kCGWindowLayer as String] as? Int ?? 0
                // Skip high-layer system chrome (menu bar extras, notification center)
                if layer >= 25 && pid != frontPID { continue }

                if seen.insert(pid).inserted {
                    let app = NSRunningApplication(processIdentifier: pid)
                    results.append((pid, app))
                }

                // Stop after the frontmost app — don't include background windows
                if pid == frontPID { break }
            }

            // Second pass: find overlay apps at any layer (e.g. Launchpad,
            // Spotlight) that were skipped by the layer >= 25 filter above.
            // These are full-screen or large overlays that sit above normal
            // windows and should be visible to the user.
            for info in windowList {
                guard let pid = info[kCGWindowOwnerPID as String] as? pid_t else { continue }
                if pid == ownPID { continue }
                guard !seen.contains(pid) else { continue }

                let layer = info[kCGWindowLayer as String] as? Int ?? 0
                // Only interested in high-layer windows we previously skipped
                guard layer >= 25 else { continue }

                // Must have a reasonably sized window (not a tiny status item)
                if let bounds = info[kCGWindowBounds as String] as? [String: Any] {
                    let w = bounds["Width"] as? Int ?? 0
                    let h = bounds["Height"] as? Int ?? 0
                    if w < 200 || h < 200 { continue }
                } else {
                    continue
                }

                // Skip known system chrome
                let app = NSRunningApplication(processIdentifier: pid)
                if let bundleId = app?.bundleIdentifier,
                   Self.systemChromeBundleIDs.contains(bundleId) {
                    continue
                }

                // Verify AX-accessible
                let appElement = AXUIElementCreateApplication(pid)
                var roleValue: CFTypeRef?
                let roleResult = AXUIElementCopyAttributeValue(appElement, kAXRoleAttribute as CFString, &roleValue)
                if roleResult == .cannotComplete || roleResult == .notImplemented { continue }

                if seen.insert(pid).inserted {
                    results.insert((pid, app), at: 0) // overlay goes in front
                }
            }

            // Ensure frontmost app is always included
            if seen.insert(frontPID).inserted {
                results.append((frontPID, frontApp))
            }

            return results
        case .all:
            return NSWorkspace.shared.runningApplications
                .filter { $0.activationPolicy == .regular }
                .map { ($0.processIdentifier, $0) }
        }
    }

    /// Collect right-side menu bar extras (Clock, Control Center, Spotlight, etc.)
    /// by querying all running apps for the AXExtrasMenuBar attribute.
    /// Returns items grouped by owning process bundleId.
    func getMenuExtras(maxDepth: Int = 5) -> [(bundleId: String, items: [AXNode])] {
        var groups: [(bundleId: String, items: [AXNode])] = []
        for app in NSWorkspace.shared.runningApplications {
            let appElement = AXUIElementCreateApplication(app.processIdentifier)
            var extrasValue: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(appElement, "AXExtrasMenuBar" as CFString, &extrasValue)
            guard result == .success, let menuBar = extrasValue else { continue }

            var childrenValue: CFTypeRef?
            let childResult = AXUIElementCopyAttributeValue(menuBar as! AXUIElement, kAXChildrenAttribute as CFString, &childrenValue)
            guard childResult == .success, let kids = childrenValue as? [AXUIElement] else { continue }

            var items: [AXNode] = []
            for kid in kids {
                let node = buildNode(element: kid, depth: 0, maxDepth: maxDepth, capabilitiesMode: .basic)
                items.append(node)
            }
            if !items.isEmpty {
                let bid = app.bundleIdentifier ?? "pid:\(app.processIdentifier)"
                groups.append((bundleId: bid, items: items))
            }
        }
        return groups
    }

    /// Get the accessibility tree. Returns one response per resolved target.
    func getTree(maxDepth: Int = 5, target: AXTarget = .front, includeCapabilities: Bool = false, capabilitiesMode: CapabilitiesMode? = nil) throws -> [AXTreeResponse] {
        let mode = capabilitiesMode ?? (includeCapabilities ? .full : .none)
        let targets = try resolveTarget(target)
        let frontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        var results: [AXTreeResponse] = []

        for (pid, app) in targets {
            let appElement = AXUIElementCreateApplication(pid)

            var roleValue: CFTypeRef?
            let roleResult = AXUIElementCopyAttributeValue(appElement, kAXRoleAttribute as CFString, &roleValue)
            if roleResult == .cannotComplete || roleResult == .notImplemented {
                continue
            }

            var menuBarValue: CFTypeRef?
            let menuBarResult = AXUIElementCopyAttributeValue(appElement, kAXMenuBarAttribute as CFString, &menuBarValue)
            let menuBarNode: AXNode? = (menuBarResult == .success && menuBarValue != nil)
                ? buildNode(element: menuBarValue as! AXUIElement, depth: 0, maxDepth: maxDepth, capabilitiesMode: mode)
                : nil

            // For the frontmost app, capture ALL windows so that secondary
            // panels (e.g. NSFontPanel, color picker) are included in the tree.
            if pid == frontPID {
                var windowsValue: CFTypeRef?
                if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsValue) == .success,
                   let windows = windowsValue as? [AXUIElement], !windows.isEmpty {
                    // Focused window gets the menu bar; additional windows do not
                    var focusedWindowValue: CFTypeRef?
                    let focusedOK = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedWindowValue) == .success
                    let focusedWindow = focusedOK ? (focusedWindowValue as! AXUIElement?) : nil

                    // Emit focused window first so it's always items[0] in the response.
                    // This ensures the daemon's CRDT builder finds the menuBar on the first item.
                    var emittedFocused = false
                    if let focusedWindow = focusedWindow,
                       let focusedIdx = windows.firstIndex(where: { CFEqual($0, focusedWindow) }) {
                        results.append(
                            buildResponse(
                                pid: pid,
                                app: app,
                                windowElement: windows[focusedIdx],
                                menuBar: menuBarNode,
                                maxDepth: maxDepth,
                                capabilitiesMode: mode
                            )
                        )
                        emittedFocused = true
                        for (i, window) in windows.enumerated() where i != focusedIdx {
                            results.append(
                                buildResponse(
                                    pid: pid,
                                    app: app,
                                    windowElement: window,
                                    menuBar: nil,
                                    maxDepth: maxDepth,
                                    capabilitiesMode: mode
                                )
                            )
                        }
                    } else {
                        for window in windows {
                            results.append(
                                buildResponse(
                                    pid: pid,
                                    app: app,
                                    windowElement: window,
                                    menuBar: nil,
                                    maxDepth: maxDepth,
                                    capabilitiesMode: mode
                                )
                            )
                        }
                    }

                    // If no window matched as focused, attach menu bar to the first result
                    if !emittedFocused && menuBarNode != nil, let first = results.last(where: { $0.pid == pid }) {
                        // Already emitted without menu bar — replace the first entry for this pid
                        if let idx = results.firstIndex(where: { $0.pid == pid }) {
                            results[idx] = AXTreeResponse(
                                app: first.app, bundleId: first.bundleId, pid: first.pid,
                                window: first.window, frame: first.frame,
                                tree: first.tree, menuBar: menuBarNode
                            )
                        }
                    }
                } else {
                    // No windows array — fall back to app element
                    results.append(
                        buildResponse(
                            pid: pid,
                            app: app,
                            windowElement: appElement,
                            menuBar: menuBarNode,
                            maxDepth: maxDepth,
                            capabilitiesMode: mode
                        )
                    )
                }
            } else {
                // Non-frontmost app: focused or main window only (fast path)
                var windowValue: CFTypeRef?
                let windowResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)

                if windowResult == .success, let windowElement = windowValue {
                    results.append(
                        buildResponse(
                            pid: pid,
                            app: app,
                            windowElement: windowElement as! AXUIElement,
                            menuBar: menuBarNode,
                            maxDepth: maxDepth,
                            capabilitiesMode: mode
                        )
                    )
                } else {
                    let mainResult = AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &windowValue)
                    if mainResult == .success, let mainWindow = windowValue {
                        results.append(
                            buildResponse(
                                pid: pid,
                                app: app,
                                windowElement: mainWindow as! AXUIElement,
                                menuBar: menuBarNode,
                                maxDepth: maxDepth,
                                capabilitiesMode: mode
                            )
                        )
                    } else {
                        results.append(
                            buildResponse(
                                pid: pid,
                                app: app,
                                windowElement: appElement,
                                menuBar: menuBarNode,
                                maxDepth: maxDepth,
                                capabilitiesMode: mode
                            )
                        )
                    }
                }
            }
        }

        return results
    }

    /// Find an element by its accessibility label and return its center point (screen-absolute)
    func findElementCenter(label: String, target: AXTarget = .front, searchVisible: Bool = true) throws -> (x: Double, y: Double)? {
        // For multi-target modes, search each resolved process
        let targets: [(pid: pid_t, app: NSRunningApplication?)]
        if target.isMulti {
            targets = try resolveTarget(target)
        } else {
            targets = try resolveTarget(target)
        }

        for (pid, _) in targets {
            let appElement = AXUIElementCreateApplication(pid)

            // Skip AX-inaccessible processes
            var roleCheck: CFTypeRef?
            let roleResult = AXUIElementCopyAttributeValue(appElement, kAXRoleAttribute as CFString, &roleCheck)
            if roleResult == .cannotComplete || roleResult == .notImplemented { continue }

            var windowValue: CFTypeRef?
            let windowResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)

            var foundElement: AXUIElement?

            if windowResult == .success, let windowElement = windowValue {
                foundElement = findElement(in: windowElement as! AXUIElement, label: label, depth: 0, maxDepth: 10)
            }

            // If not found in window, also search app-level elements (catches popup menus)
            if foundElement == nil {
                foundElement = findElement(in: appElement, label: label, depth: 0, maxDepth: 10)
            }

            if let element = foundElement, let frame = getFrame(element) {
                let centerX = frame.x + frame.width / 2.0
                let centerY = frame.y + frame.height / 2.0
                return (centerX, centerY)
            }
        }

        // If not found in front app and searchVisible is enabled, try visible processes
        if searchVisible && !target.isMulti && target != .visible {
            return try findElementCenter(label: label, target: .visible, searchVisible: false)
        }

        return nil
    }

    /// Find element center within a specific window (for modal scope)
    func findElementCenterInWindow(label: String, window: AXUIElement) throws -> (x: Double, y: Double)? {
        // Search for element in the specified window's children
        guard let element = findElement(in: window, label: label, depth: 0, maxDepth: 10) else {
            return nil
        }

        // Get element frame
        guard let frame = getFrame(element) else {
            return nil
        }

        let centerX = frame.x + frame.width / 2.0
        let centerY = frame.y + frame.height / 2.0

        return (centerX, centerY)
    }

    // MARK: - Floating Context Detection

    /// Detect transient floating UI (context menus) that live
    /// outside any window. Returns an AXTreeResponse for the first floating
    /// context found, or nil if none is present.
    func getFloatingContext(maxDepth: Int = .max) -> AXTreeResponse? {
        // Context menus appear as layer-101 CGWindows. They're not reachable via
        // kAXChildrenAttribute, but ARE accessible via AXUIElementCopyElementAtPosition.
        // Strategy: find the CGWindow, hit-test its center, walk up to the AXMenu root.
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }

        for info in windowList {
            let layer = info[kCGWindowLayer as String] as? Int ?? 0
            guard layer == 101 else { continue }

            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t else { continue }
            let owner = info[kCGWindowOwnerName as String] as? String ?? ""

            let bounds = info[kCGWindowBounds as String] as? [String: Any]
            let wx = bounds?["X"] as? Double ?? 0
            let wy = bounds?["Y"] as? Double ?? 0
            let ww = bounds?["Width"] as? Double ?? 0
            let wh = bounds?["Height"] as? Double ?? 0

            // Skip tiny windows (status bar extras are also layer 101)
            guard ww > 50 && wh > 50 else { continue }

            // Hit-test the center of the menu window to find an AX element
            let appElement = AXUIElementCreateApplication(pid)
            let app = NSRunningApplication(processIdentifier: pid)
            let appName = app?.localizedName ?? owner

            var hitElement: AXUIElement?
            let cx = Float(wx + ww / 2)
            let cy = Float(wy + wh / 2)
            let hitResult = AXUIElementCopyElementAtPosition(appElement, cx, cy, &hitElement)

            guard hitResult == .success, let hit = hitElement else { continue }

            // Walk up from the hit element to find the AXMenu root
            var menuRoot: AXUIElement? = nil
            let hitRole = getStringAttribute(hit, kAXRoleAttribute)
            if hitRole == "AXMenu" {
                menuRoot = hit
            } else {
                var current = hit
                for _ in 0..<20 {
                    var parentValue: CFTypeRef?
                    let pResult = AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentValue)
                    guard pResult == .success, let parent = parentValue else { break }
                    let parentElement = parent as! AXUIElement
                    let parentRole = getStringAttribute(parentElement, kAXRoleAttribute)
                    if parentRole == "AXMenu" {
                        menuRoot = parentElement
                        // Keep walking — there might be a higher AXMenu (nested submenus)
                    }
                    if parentRole == "AXWindow" || parentRole == "AXApplication" { break }
                    current = parentElement
                }
            }

            guard let menu = menuRoot else { continue }

            let tree = buildNode(element: menu, depth: 0, maxDepth: maxDepth, capabilitiesMode: .basic)
            return AXTreeResponse(
                app: appName, bundleId: app?.bundleIdentifier ?? "",
                pid: pid, window: nil,
                frame: AXFrame(x: wx, y: wy, width: ww, height: wh),
                tree: tree, menuBar: nil
            )
        }

        // Check for an open menu bar dropdown (File, Edit, etc.) via the
        // frontmost app's AXMenuBar. When a menu bar item is clicked, its
        // AXSelected attribute is true and it gains an AXMenu child containing
        // the dropdown items. This is more reliable than hit-testing since the
        // menu is part of the AX hierarchy.
        if let frontApp = NSWorkspace.shared.frontmostApplication {
            let frontPid = frontApp.processIdentifier
            let frontAppElement = AXUIElementCreateApplication(frontPid)
            var menuBarValue: CFTypeRef?
            let mbResult = AXUIElementCopyAttributeValue(frontAppElement, kAXMenuBarAttribute as CFString, &menuBarValue)
            if mbResult == .success, let menuBar = menuBarValue {
                var mbChildrenValue: CFTypeRef?
                if AXUIElementCopyAttributeValue(menuBar as! AXUIElement, kAXChildrenAttribute as CFString, &mbChildrenValue) == .success,
                   let mbChildren = mbChildrenValue as? [AXUIElement] {
                    for barItem in mbChildren {
                        let role = getStringAttribute(barItem, kAXRoleAttribute)
                        guard role == "AXMenuBarItem" else { continue }

                        // Check if this menu bar item is selected (menu is open)
                        var selectedValue: CFTypeRef?
                        let selResult = AXUIElementCopyAttributeValue(barItem, kAXSelectedAttribute as CFString, &selectedValue)
                        guard selResult == .success, let sel = selectedValue as? Bool, sel else { continue }

                        // Found a selected menu bar item — get its AXMenu child
                        var barItemChildren: CFTypeRef?
                        if AXUIElementCopyAttributeValue(barItem, kAXChildrenAttribute as CFString, &barItemChildren) == .success,
                           let children = barItemChildren as? [AXUIElement] {
                            for child in children {
                                let childRole = getStringAttribute(child, kAXRoleAttribute)
                                if childRole == "AXMenu" {
                                    let barItemTitle = getStringAttribute(barItem, kAXTitleAttribute)
                                    let tree = buildNode(element: child, depth: 0, maxDepth: maxDepth, capabilitiesMode: .basic)
                                    let frame = getFrame(child)
                                    return AXTreeResponse(
                                        app: frontApp.localizedName ?? "",
                                        bundleId: frontApp.bundleIdentifier ?? "",
                                        pid: frontPid, window: barItemTitle,
                                        frame: frame,
                                        tree: tree, menuBar: nil
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        return nil
    }

    // MARK: - Private

    private func buildResponse(
        pid: pid_t,
        app: NSRunningApplication?,
        windowElement: AXUIElement,
        menuBar: AXNode?,
        maxDepth: Int,
        includeCapabilities: Bool = false,
        capabilitiesMode: CapabilitiesMode? = nil
    ) -> AXTreeResponse {
        let mode = capabilitiesMode ?? (includeCapabilities ? .full : .none)
        let windowTitle = getStringAttribute(windowElement, kAXTitleAttribute)
        let windowFrame = getFrame(windowElement)

        let tree = buildNode(element: windowElement, depth: 0, maxDepth: maxDepth, capabilitiesMode: mode)

        return AXTreeResponse(
            app: app?.localizedName ?? app?.bundleIdentifier ?? "PID \(pid)",
            bundleId: app?.bundleIdentifier ?? "",
            pid: pid,
            window: windowTitle,
            frame: windowFrame,
            tree: tree,
            menuBar: menuBar
        )
    }

    enum CapabilitiesMode {
        case none
        case basic   // Only state booleans + scroll values (~6 AX calls)
        case full    // Everything including actions, interaction hints (~30+ AX calls)
    }

    private func buildNode(
        element: AXUIElement,
        depth: Int,
        maxDepth: Int,
        clipRect: AXFrame? = nil,
        includeCapabilities: Bool = false,
        capabilitiesMode: CapabilitiesMode? = nil
    ) -> AXNode {
        let mode = capabilitiesMode ?? (includeCapabilities ? .full : .none)

        let role = getStringAttribute(element, kAXRoleAttribute)
        let subrole = getStringAttribute(element, kAXSubroleAttribute)
        let title = Self.humanizeIfSFSymbol(getStringAttribute(element, kAXTitleAttribute))
        var label = Self.humanizeIfSFSymbol(getStringAttribute(element, kAXDescriptionAttribute))
        if role == "AXImage", label == nil {
            label = getStringAttribute(element, kAXHelpAttribute)
                ?? title
                ?? imageNameOrFileHint(element)
        }
        // Map annotation buttons (e.g. Apple Maps pins) often lack title/label
        // but expose the place name via AXHelp.
        if role == "AXButton", title == nil, label == nil {
            label = Self.humanizeIfSFSymbol(getStringAttribute(element, kAXHelpAttribute))
        }
        let value = getValueString(element)
        // Filter out auto-generated AppKit identifiers (e.g. "_NS:9") — they are
        // unstable across sessions and break element targeting.
        let rawIdentifier = getStringAttribute(element, kAXIdentifierAttribute)
        let identifier = rawIdentifier?.hasPrefix("_NS:") == true ? nil : rawIdentifier
        let placeholder = getStringAttribute(element, "AXPlaceholderValue")
        let frame = getFrame(element)
        let capabilities: AXNode.AXCapabilities? = {
            switch mode {
            case .none: return nil
            case .basic:
                // Only compute capabilities for roles that actually use state attributes
                let stateRoles: Set<String> = [
                    "AXRadioButton", "AXCheckBox", "AXTab", "AXMenuItem", "AXMenuBarItem",
                    "AXDisclosureTriangle", "AXOutlineRow", "AXRow",
                    "AXScrollArea", "AXWebArea", "AXTextField", "AXTextArea",
                    "AXButton", "AXToolbar",
                ]
                guard let r = role, stateRoles.contains(r) else { return nil }
                return getBasicCapabilities(element)
            case .full: return getCapabilities(element)
            }
        }()

        // Compute visibility relative to scroll area clip rect
        let visible: Bool?
        if let clip = clipRect, let f = frame {
            visible = frameIntersectsClip(f, clipRect: clip)
        } else {
            visible = nil
        }

        // Update clip rect when entering a scroll area
        var childClipRect = clipRect
        if role == "AXScrollArea", let f = frame {
            childClipRect = intersectFrames(clipRect, f)
        }

        // Set clip rect for scroll containers — clips off-screen children
        let clipRoles: Set<String> = ["AXScrollArea", "AXWebArea", "AXList", "AXOutline", "AXTable"]
        if let r = role, clipRoles.contains(r), let f = frame {
            childClipRect = childClipRect != nil ? intersectFrames(childClipRect, f) : f
        }

        var children: [AXNode]? = nil
        if depth < maxDepth {
            let childElements = resolveChildren(element, role: role)
            if !childElements.isEmpty {
                children = childElements.compactMap { child -> AXNode? in
                    // Skip children entirely outside the clip rect
                    if let clip = childClipRect {
                        let childFrame = getFrame(child)
                        if let cf = childFrame, !frameIntersectsClip(cf, clipRect: clip) {
                            return nil
                        }
                    }
                    return buildNode(
                        element: child,
                        depth: depth + 1,
                        maxDepth: maxDepth,
                        clipRect: childClipRect,
                        capabilitiesMode: mode
                    )
                }
                if children?.isEmpty == true { children = nil }
            }
        }

        return AXNode(
            role: role,
            subrole: subrole,
            title: title,
            label: label,
            value: value,
            identifier: identifier,
            placeholder: placeholder,
            frame: frame,
            visible: visible,
            capabilities: capabilities,
            children: children
        )
    }

    /// Resolve children of an AX element, trying fallback attributes when
    /// kAXChildrenAttribute returns empty for container roles like AXPopover.
    /// Some macOS controls (e.g. Reminders detail popover) don't expose their
    /// contents via kAXChildrenAttribute but do via AXVisibleChildren or AXContents.
    private func resolveChildren(_ element: AXUIElement, role: String?) -> [AXUIElement] {
        var childrenValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        if result == .success, let childElements = childrenValue as? [AXUIElement], !childElements.isEmpty {
            return childElements
        }

        // For container/overlay roles, try fallback attributes when kAXChildren is empty
        let fallbackRoles: Set<String> = ["AXPopover", "AXSheet", "AXDialog", "AXGroup", "AXScrollArea"]
        guard let r = role, fallbackRoles.contains(r) else { return [] }

        // Try AXVisibleChildren
        var visibleValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, "AXVisibleChildren" as CFString, &visibleValue) == .success,
           let visibleElements = visibleValue as? [AXUIElement], !visibleElements.isEmpty {
            return visibleElements
        }

        // Try AXContents (used by some container controls)
        var contentsValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, "AXContents" as CFString, &contentsValue) == .success,
           let contentsElements = contentsValue as? [AXUIElement], !contentsElements.isEmpty {
            return contentsElements
        }

        // Last resort: hit-test the center of the element's frame to discover children
        // This works for popovers whose children aren't exposed through any child attribute
        if let frame = getFrame(element), frame.width > 0, frame.height > 0 {
            let cx = Float(frame.x + frame.width / 2)
            let cy = Float(frame.y + frame.height / 2)

            // Try hit-testing from the app that owns this element
            var pid: pid_t = 0
            AXUIElementGetPid(element, &pid)
            let appElement = AXUIElementCreateApplication(pid)

            var hitElement: AXUIElement?
            if AXUIElementCopyElementAtPosition(appElement, cx, cy, &hitElement) == .success,
               let hit = hitElement {
                // Walk up from the hit element to find the direct child of our popover
                var current = hit
                for _ in 0..<20 {
                    var parentValue: CFTypeRef?
                    let pResult = AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentValue)
                    guard pResult == .success, let parent = parentValue else { break }
                    let parentElement = parent as! AXUIElement

                    // If the parent is our element, we found a direct child
                    if CFEqual(parentElement, element) {
                        // Now collect all siblings at this level by querying parent's children again
                        // (The initial query may have failed due to timing; the element may be ready now)
                        var retryValue: CFTypeRef?
                        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &retryValue) == .success,
                           let retryElements = retryValue as? [AXUIElement], !retryElements.isEmpty {
                            return retryElements
                        }
                        // If still empty, return just the hit element
                        return [current]
                    }

                    let parentRole = getStringAttribute(parentElement, kAXRoleAttribute)
                    if parentRole == "AXWindow" || parentRole == "AXApplication" { break }
                    current = parentElement
                }
            }
        }

        return []
    }

    // MARK: – SF Symbol name detection & humanisation

    /// Decorative SF Symbol suffixes that carry no semantic meaning for users.
    private static let sfSymbolDecoSuffixes: Set<String> = [
        "fill", "circle", "square", "rectangle", "slash",
        "badge", "rtl", "ltr", "ar", "he", "hi", "ja", "ko",
        "th", "zh", "trianglebadge", "exclamationmark",
    ]

    /// Returns true when `name` looks like an SF Symbol asset name
    /// (e.g. "calculator.fill", "square.and.arrow.up.fill").
    /// Heuristic: two or more dot-separated segments, all lowercase/digits,
    /// no spaces, no path separators, and at least one segment is a known
    /// SF Symbol keyword or suffix.
    private static func looksLikeSFSymbolName(_ name: String) -> Bool {
        guard !name.isEmpty,
              !name.contains(" "),
              !name.contains("/"),
              name == name.lowercased()
        else { return false }

        let segments = name.split(separator: ".")
        guard segments.count >= 2 else { return false }

        // All segments must be purely lowercase letters + digits
        let valid = CharacterSet.lowercaseLetters.union(.decimalDigits)
        for seg in segments {
            if seg.isEmpty { return false }
            if seg.unicodeScalars.contains(where: { !valid.contains($0) }) { return false }
        }

        // At least one segment matches a known decorative suffix
        return segments.contains { sfSymbolDecoSuffixes.contains(String($0)) }
    }

    /// Convert an SF Symbol name like "calculator.fill" → "Calculator"
    /// or "square.and.arrow.up.fill" → "Square And Arrow Up".
    /// Strips decorative suffixes and title-cases the remaining words.
    private static func humanizeSFSymbolName(_ name: String) -> String {
        let segments = name.split(separator: ".").map(String.init)
        let meaningful = segments.filter { !sfSymbolDecoSuffixes.contains($0) }
        let words = meaningful.isEmpty ? segments : meaningful
        return words.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    /// If `text` is an SF Symbol asset name, return a humanised version;
    /// otherwise return the original string unchanged.
    private static func humanizeIfSFSymbol(_ text: String?) -> String? {
        guard let t = text, looksLikeSFSymbolName(t) else { return text }
        return humanizeSFSymbolName(t)
    }

    /// Best-effort filename/name hint for AXImage nodes.
    /// Not all apps expose these attributes.
    private func imageNameOrFileHint(_ element: AXUIElement) -> String? {
        if let filename = getStringAttribute(element, "AXFilename"), !filename.isEmpty {
            return (filename as NSString).lastPathComponent
        }

        if let rawURL = getRawAttribute(element, "AXURL") {
            if let url = rawURL as? URL {
                return url.lastPathComponent.isEmpty ? nil : url.lastPathComponent
            }
            if let str = rawURL as? String, !str.isEmpty {
                if let url = URL(string: str), let host = url.host {
                    let name = url.lastPathComponent.isEmpty ? host : url.lastPathComponent
                    return name
                }
                return (str as NSString).lastPathComponent
            }
        }

        return nil
    }

    private func findElement(in element: AXUIElement, label: String, depth: Int, maxDepth: Int) -> AXUIElement? {
        // Check this element
        let title = getStringAttribute(element, kAXTitleAttribute)
        let desc = getStringAttribute(element, kAXDescriptionAttribute)
        let value = getValueString(element)
        let placeholder = getStringAttribute(element, "AXPlaceholderValue")

        if title == label || desc == label || value == label || placeholder == label {
            return element
        }

        guard depth < maxDepth else { return nil }

        // Search children
        var childrenValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        if result == .success, let children = childrenValue as? [AXUIElement] {
            for child in children {
                if let found = findElement(in: child, label: label, depth: depth + 1, maxDepth: maxDepth) {
                    return found
                }
            }
        }

        return nil
    }

    private func getStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard result == .success, let str = value as? String, !str.isEmpty else { return nil }
        return str
    }

    private func getValueString(_ element: AXUIElement) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
        guard result == .success else { return nil }
        if let str = value as? String, !str.isEmpty { return str }
        if let num = value as? NSNumber { return num.stringValue }
        return nil
    }

    private func getRawAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard result == .success else { return nil }
        return value
    }

    private func getBoolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        guard let raw = getRawAttribute(element, attribute) else { return nil }
        if let b = raw as? Bool { return b }
        if let n = raw as? NSNumber { return n.boolValue }
        return nil
    }

    private func getDoubleAttribute(_ element: AXUIElement, _ attribute: String) -> Double? {
        guard let raw = getRawAttribute(element, attribute) else { return nil }
        if let n = raw as? NSNumber { return n.doubleValue }
        return nil
    }

    private func isAttributeSettable(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var settable: DarwinBoolean = false
        let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        guard result == .success else { return nil }
        return settable.boolValue
    }

    private func getScrollBarValue(_ element: AXUIElement, _ scrollBarAttribute: String) -> Double? {
        guard let raw = getRawAttribute(element, scrollBarAttribute) else { return nil }
        guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        let scrollBar = raw as! AXUIElement
        return getDoubleAttribute(scrollBar, kAXValueAttribute)
    }

    /// Lightweight capabilities: only state booleans + scroll values.
    /// Only called for roles in the stateRoles set (tabs, outline rows, scroll areas, etc.)
    private func getBasicCapabilities(_ element: AXUIElement) -> AXNode.AXCapabilities? {
        let selected = getBoolAttribute(element, "AXSelected")
        let expanded = getBoolAttribute(element, "AXExpanded")
        let focused = getBoolAttribute(element, kAXFocusedAttribute)

        let vScrollValue = getScrollBarValue(element, "AXVerticalScrollBar")
        let hScrollValue = getScrollBarValue(element, "AXHorizontalScrollBar")
        let scrollAxis: String? = {
            if vScrollValue != nil && hScrollValue != nil { return "xy" }
            if vScrollValue != nil { return "y" }
            if hScrollValue != nil { return "x" }
            return nil
        }()
        let canScroll = vScrollValue != nil || hScrollValue != nil

        if selected == nil && focused == nil && expanded == nil && !canScroll {
            return nil
        }

        return AXNode.AXCapabilities(
            enabled: nil,
            selected: selected,
            focused: focused,
            expanded: expanded,
            checked: nil,
            mixed: nil,
            canClick: false,
            canSelect: false,
            canHover: nil,
            canFocus: nil,
            canType: nil,
            canScroll: canScroll ? true : nil,
            scrollAxis: scrollAxis,
            scrollDirections: nil,
            scrollValueV: vScrollValue,
            scrollValueH: hScrollValue,
            canExpand: nil,
            canOpenMenu: nil,
            canContextMenu: nil,
            canIncrement: nil,
            canDecrement: nil,
            canConfirm: nil,
            canDismiss: nil,
            canToggle: nil,
            canSetValue: nil,
            canDrag: nil,
            dragType: nil,
            valueType: nil,
            range: nil,
            actions: nil,
            settable: nil,
            interactionHints: nil
        )
    }

    private func getCapabilities(_ element: AXUIElement) -> AXNode.AXCapabilities? {
        var actions: [String]? = nil
        var actionsValue: CFArray?
        if AXUIElementCopyActionNames(element, &actionsValue) == .success {
            actions = actionsValue as? [String]
        }

        let enabled = getBoolAttribute(element, kAXEnabledAttribute)
        let selected = getBoolAttribute(element, "AXSelected")
        let focused = getBoolAttribute(element, kAXFocusedAttribute)
        let expanded = getBoolAttribute(element, "AXExpanded")
        let role = getStringAttribute(element, kAXRoleAttribute)
        let title = getStringAttribute(element, kAXTitleAttribute)
        let valueRaw = getRawAttribute(element, kAXValueAttribute)

        let settable = AXNode.AXSettable(
            enabled: isAttributeSettable(element, kAXEnabledAttribute),
            selected: isAttributeSettable(element, "AXSelected"),
            value: isAttributeSettable(element, kAXValueAttribute),
            position: isAttributeSettable(element, kAXPositionAttribute),
            size: isAttributeSettable(element, kAXSizeAttribute),
            focused: isAttributeSettable(element, kAXFocusedAttribute),
            expanded: isAttributeSettable(element, "AXExpanded")
        )
        let isSelectedSettable = settable.selected ?? false
        let isPositionSettable = settable.position ?? false
        let isValueSettable = settable.value ?? false

        let dragActionNames: Set<String> = ["AXGrab", "AXPressAndHold"]
        let draggableRoles: Set<String> = ["AXSplitter", "AXSlider", "AXScrollBar", "AXValueIndicator"]
        let nonDraggableRoles: Set<String> = ["AXMenu", "AXMenuItem", "AXMenuBarItem"]
        let textInputRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]
        let scrollRoles: Set<String> = ["AXScrollArea", "AXScrollBar"]
        let menuRoles: Set<String> = ["AXMenuButton", "AXPopUpButton", "AXMenuBarItem", "AXMenuItem", "AXMenu"]
        let toggleRoles: Set<String> = ["AXCheckBox", "AXSwitch", "AXRadioButton", "AXDisclosureTriangle", "AXTab"]

        let hasPress = actions?.contains("AXPress") == true
        let hasShowMenu = actions?.contains("AXShowMenu") == true
        let hasDragAction = actions?.contains(where: { dragActionNames.contains($0) }) == true
        let hasIncrement = actions?.contains("AXIncrement") == true
        let hasDecrement = actions?.contains("AXDecrement") == true
        let hasCancel = actions?.contains("AXCancel") == true
        let hasConfirm = actions?.contains("AXConfirm") == true
        let hasScrollToVisible = actions?.contains("AXScrollToVisible") == true
        let hasRaise = actions?.contains("AXRaise") == true

        var checked: Bool? = nil
        var mixed: Bool? = nil
        if toggleRoles.contains(role ?? "") {
            if let rawBool = valueRaw as? Bool {
                checked = rawBool
            } else if let rawNum = valueRaw as? NSNumber {
                let intValue = rawNum.intValue
                if intValue == 2 {
                    mixed = true
                } else {
                    checked = (intValue != 0)
                }
            }
        }

        let valueType: String? = {
            guard let raw = valueRaw else { return nil }
            if raw is String { return "string" }
            if raw is NSNumber {
                let cft = CFGetTypeID(raw)
                if cft == CFBooleanGetTypeID() { return "bool" }
                return "number"
            }
            return "unknown"
        }()

        let range = AXNode.AXValueRange(
            min: getDoubleAttribute(element, "AXMinValue"),
            max: getDoubleAttribute(element, "AXMaxValue"),
            step: getDoubleAttribute(element, "AXValueIncrement")
        )
        let hasRange = range.min != nil || range.max != nil || range.step != nil

        let vScrollValue = getScrollBarValue(element, "AXVerticalScrollBar")
        let hScrollValue = getScrollBarValue(element, "AXHorizontalScrollBar")
        let canScrollUp = (vScrollValue != nil) && ((vScrollValue ?? 0.0) > 0.001)
        let canScrollDown = (vScrollValue != nil) && ((vScrollValue ?? 1.0) < 0.999)
        let canScrollLeft = (hScrollValue != nil) && ((hScrollValue ?? 0.0) > 0.001)
        let canScrollRight = (hScrollValue != nil) && ((hScrollValue ?? 1.0) < 0.999)
        var scrollDirections: [String] = []
        if canScrollUp { scrollDirections.append("up") }
        if canScrollDown { scrollDirections.append("down") }
        if canScrollLeft { scrollDirections.append("left") }
        if canScrollRight { scrollDirections.append("right") }
        let hasVerticalScroll = canScrollUp || canScrollDown
        let hasHorizontalScroll = canScrollLeft || canScrollRight
        let scrollAxis: String? = {
            if hasVerticalScroll && hasHorizontalScroll { return "xy" }
            if hasVerticalScroll { return "y" }
            if hasHorizontalScroll { return "x" }
            return nil
        }()

        let canClick = (hasPress || hasShowMenu) && (enabled ?? true)
        let canSelect = (selected != nil) || isSelectedSettable
        let canHover = getFrame(element) != nil
        let canFocus = (settable.focused ?? false) || hasRaise
        let canType = textInputRoles.contains(role ?? "") && (isValueSettable || (enabled ?? true))
        let canScroll = (scrollRoles.contains(role ?? "") || hasScrollToVisible || scrollAxis != nil)
        let canExpand = expanded != nil || (settable.expanded ?? false) || (role == "AXDisclosureTriangle")
        let canOpenMenu = hasShowMenu || menuRoles.contains(role ?? "")
        let canContextMenu = hasShowMenu
        let canIncrement = hasIncrement
        let canDecrement = hasDecrement
        let canConfirm = hasConfirm || ((title == "OK" || title == "Save" || title == "Open") && hasPress)
        let canDismiss = hasCancel || ((title == "Cancel" || title == "Close" || title == "No") && hasPress)
        let canToggle = toggleRoles.contains(role ?? "") || checked != nil || mixed == true
        let canSetValue = isValueSettable
        let canDrag =
            !nonDraggableRoles.contains(role ?? "")
            && (hasDragAction || isPositionSettable || draggableRoles.contains(role ?? ""))
            && (enabled ?? true)
        let dragType: String? =
            canDrag
            ? (hasDragAction ? "action" : (isPositionSettable ? "position" : "role"))
            : nil

        let clickPoint: String? = {
            guard canClick, let f = getFrame(element) else { return nil }
            return "\(Int(f.x + (f.width / 2.0))),\(Int(f.y + (f.height / 2.0)))"
        }()
        let dragStartPoint: String? = {
            guard canDrag, let f = getFrame(element) else { return nil }
            return "\(Int(f.x + (f.width / 2.0))),\(Int(f.y + (f.height / 2.0)))"
        }()
        let selectLength: Int? = {
            guard canType, let value = getValueString(element) else { return nil }
            return value.count
        }()
        let primaryAction: String? = {
            if canType { return "type" }
            if canClick { return "click" }
            if canDrag { return "drag" }
            if canScroll { return "scroll" }
            if canExpand { return "expand" }
            if canOpenMenu { return "menu" }
            if canSelect { return "select" }
            return nil
        }()
        let confidence: String? = {
            if hasPress || hasShowMenu || hasDragAction || hasIncrement || hasDecrement { return "high" }
            if canSetValue || isSelectedSettable || isPositionSettable { return "medium" }
            return primaryAction == nil ? nil : "low"
        }()
        let hints = AXNode.AXInteractionHints(
            primaryAction: primaryAction,
            clickPoint: clickPoint,
            dragStartPoint: dragStartPoint,
            selectLength: selectLength,
            editable: canType || canSetValue,
            confidence: confidence
        )
        let hasSettable = [
            settable.enabled, settable.selected, settable.value,
            settable.position, settable.size, settable.focused, settable.expanded
        ].contains(where: { $0 != nil })

        let hasAnyDerivedCapability =
            canClick || canSelect || canHover || canFocus || canType || canScroll
            || canExpand || canOpenMenu || canContextMenu || canIncrement || canDecrement
            || canConfirm || canDismiss || canToggle || canSetValue || canDrag

        if actions == nil && enabled == nil && selected == nil && focused == nil && expanded == nil
            && !isSelectedSettable && !hasRange && !hasSettable && !hasAnyDerivedCapability {
            return nil
        }

        return AXNode.AXCapabilities(
            enabled: enabled,
            selected: selected,
            focused: focused,
            expanded: expanded,
            checked: checked,
            mixed: mixed,
            canClick: canClick,
            canSelect: canSelect,
            canHover: canHover,
            canFocus: canFocus,
            canType: canType,
            canScroll: canScroll,
            scrollAxis: scrollAxis,
            scrollDirections: scrollDirections.isEmpty ? nil : scrollDirections,
            scrollValueV: vScrollValue,
            scrollValueH: hScrollValue,
            canExpand: canExpand,
            canOpenMenu: canOpenMenu,
            canContextMenu: canContextMenu,
            canIncrement: canIncrement,
            canDecrement: canDecrement,
            canConfirm: canConfirm,
            canDismiss: canDismiss,
            canToggle: canToggle,
            canSetValue: canSetValue,
            canDrag: canDrag,
            dragType: dragType,
            valueType: valueType,
            range: hasRange ? range : nil,
            actions: actions,
            settable: hasSettable ? settable : nil,
            interactionHints: hints
        )
    }

    private func getFrame(_ element: AXUIElement) -> AXFrame? {
        var posValue: CFTypeRef?
        var sizeValue: CFTypeRef?

        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success else {
            return nil
        }

        var point = CGPoint.zero
        var size = CGSize.zero

        guard AXValueGetValue(posValue as! AXValue, .cgPoint, &point),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else {
            return nil
        }

        return AXFrame(x: Double(point.x), y: Double(point.y), width: Double(size.width), height: Double(size.height))
    }

    private func getWindowTitle(target: AXTarget) -> String? {
        guard case .front = target,
              let frontApp = NSWorkspace.shared.frontmostApplication else {
            return nil
        }

        let appElement = AXUIElementCreateApplication(frontApp.processIdentifier)
        var windowValue: CFTypeRef?

        if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue) == .success
            || AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &windowValue) == .success {
            let windowElement = windowValue as! AXUIElement
            return getStringAttribute(windowElement, kAXTitleAttribute)
        }

        return nil
    }

    private func treeHasWebAreaWithChildren(_ node: AXNode?) -> Bool {
        guard let node = node else { return false }

        if node.role == "AXWebArea",
           let children = node.children,
           !children.isEmpty {
            return true
        }

        if let children = node.children {
            for child in children {
                if treeHasWebAreaWithChildren(child) {
                    return true
                }
            }
        }

        return false
    }

    // MARK: - Interactive Elements

    /// How an interactive element was detected
    enum DetectionSource: String {
        case role   // matched the static interactiveRoles whitelist
        case action // had a meaningful AX action (AXPress, AXIncrement, etc.)
    }

    /// Roles considered interactive (buttons, fields, links, etc.)
    static let interactiveRoles: Set<String> = [
        // Buttons
        "AXButton", "AXPopUpButton", "AXMenuButton", "AXComboBox",
        // Text input
        "AXTextField", "AXTextArea", "AXSearchField",
        // Toggles & selection
        "AXCheckBox", "AXRadioButton", "AXSwitch",
        // Links & navigation
        "AXLink", "AXTab", "AXMenuItem", "AXMenuBarItem",
        // Sliders & steppers
        "AXSlider", "AXIncrementor",
        // Disclosure
        "AXDisclosureTriangle",
        // Pickers
        "AXColorWell", "AXDateField",
        // Segmented controls
        "AXSegmentedControl",
    ]

    /// Roles that are structural containers — never query actions on these
    private static let containerRoles: Set<String> = [
        "AXWindow", "AXGroup", "AXScrollArea", "AXSplitGroup",
        "AXTabGroup", "AXToolbar", "AXList", "AXOutline",
        "AXTable", "AXBrowser", "AXLayoutArea", "AXLayoutItem",
        "AXApplication", "AXMenuBar", "AXMenu",
    ]

    /// AX actions that indicate an element is interactive
    private static let meaningfulActions: Set<String> = [
        "AXPress", "AXIncrement", "AXDecrement", "AXConfirm", "AXPick", "AXOpen",
    ]

    /// Maximum number of elements to return (prevents noise from table-heavy apps)
    private static let maxElementCount = 80

    struct InteractiveElement {
        let id: Int
        let role: String
        let label: String?
        let title: String?
        let value: String?
        let frame: AXFrame  // screen-absolute, in points
        let source: DetectionSource
        let parentPath: [String]  // ancestor roles from root to immediate parent
        var appName: String?
        var windowTitle: String?
    }

    struct ScrollState: Codable {
        let canScrollUp: Bool
        let canScrollDown: Bool
        let canScrollLeft: Bool
        let canScrollRight: Bool
    }

    /// Detect scroll state of the frontmost scroll area in a window.
    func detectScrollState(window: AXUIElement) -> ScrollState {
        guard let scrollArea = findScrollArea(in: window, depth: 0, maxDepth: 5) else {
            return ScrollState(canScrollUp: false, canScrollDown: false, canScrollLeft: false, canScrollRight: false)
        }

        var canScrollUp = false
        var canScrollDown = false
        var canScrollLeft = false
        var canScrollRight = false

        // Check vertical scroll bar
        var vScrollValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(scrollArea, "AXVerticalScrollBar" as CFString, &vScrollValue) == .success,
           let vScrollBar = vScrollValue {
            var val: CFTypeRef?
            if AXUIElementCopyAttributeValue(vScrollBar as! AXUIElement, kAXValueAttribute as CFString, &val) == .success,
               let num = val as? NSNumber {
                let v = num.doubleValue
                canScrollUp = v > 0.001
                canScrollDown = v < 0.999
            }
        }

        // Check horizontal scroll bar
        var hScrollValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(scrollArea, "AXHorizontalScrollBar" as CFString, &hScrollValue) == .success,
           let hScrollBar = hScrollValue {
            var val: CFTypeRef?
            if AXUIElementCopyAttributeValue(hScrollBar as! AXUIElement, kAXValueAttribute as CFString, &val) == .success,
               let num = val as? NSNumber {
                let v = num.doubleValue
                canScrollLeft = v > 0.001
                canScrollRight = v < 0.999
            }
        }

        return ScrollState(canScrollUp: canScrollUp, canScrollDown: canScrollDown, canScrollLeft: canScrollLeft, canScrollRight: canScrollRight)
    }

    private func findScrollArea(in element: AXUIElement, depth: Int, maxDepth: Int) -> AXUIElement? {
        let role = getStringAttribute(element, kAXRoleAttribute)
        if role == "AXScrollArea" { return element }
        guard depth < maxDepth else { return nil }

        var childrenValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        if result == .success, let children = childrenValue as? [AXUIElement] {
            for child in children {
                if let found = findScrollArea(in: child, depth: depth + 1, maxDepth: maxDepth) {
                    return found
                }
            }
        }
        return nil
    }

    /// Returns a flat list of interactive elements from visible windows.
    /// Frames are screen-absolute in points.
    struct InteractiveElementsResult {
        let elements: [InteractiveElement]
        let scrollState: ScrollState
    }

    func getInteractiveElements(maxDepth: Int = 15, target: AXTarget = .visible) -> InteractiveElementsResult {
        let noResult = InteractiveElementsResult(
            elements: [],
            scrollState: ScrollState(canScrollUp: false, canScrollDown: false, canScrollLeft: false, canScrollRight: false)
        )

        // Get screen bounds for clipping
        let screenBounds: (width: Double, height: Double)?
        if let screen = NSScreen.main {
            screenBounds = (width: Double(screen.frame.width), height: Double(screen.frame.height))
        } else {
            screenBounds = nil
        }

        var elements: [InteractiveElement] = []
        var nextId = 1

        // Resolve target PIDs
        let targets: [(pid: pid_t, app: NSRunningApplication?)]
        do {
            targets = try resolveTarget(target)
        } catch {
            print("[GhostUI] getInteractiveElements: resolveTarget failed: \(error)")
            return noResult
        }

        let frontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier

        print("[GhostUI] getInteractiveElements: resolved \(targets.count) target(s), front=\(frontPID ?? -1)")

        // Collect elements from each target
        for (pid, app) in targets {
            let appElement = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(appElement, 0.5)

            let beforeCount = elements.count
            let isFront = (pid == frontPID)
            let appName = app?.localizedName

            if isFront {
                // Frontmost app: walk ALL its windows for thorough detection
                var windowsValue: CFTypeRef?
                if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsValue) == .success,
                   let windows = windowsValue as? [AXUIElement], !windows.isEmpty {
                    for window in windows {
                        let winTitle = getStringAttribute(window, kAXTitleAttribute)
                        let winStart = elements.count
                        collectInteractiveElements(
                            element: window, depth: 0, maxDepth: maxDepth,
                            screenBounds: screenBounds, clipRect: nil,
                            elements: &elements, nextId: &nextId
                        )
                        // Tag new elements with app/window context
                        for i in winStart..<elements.count {
                            elements[i].appName = appName
                            elements[i].windowTitle = winTitle
                        }
                    }
                } else {
                    collectInteractiveElements(
                        element: appElement, depth: 0, maxDepth: maxDepth,
                        screenBounds: screenBounds, clipRect: nil,
                        elements: &elements, nextId: &nextId
                    )
                    for i in beforeCount..<elements.count {
                        elements[i].appName = appName
                    }
                }
            } else {
                // Background app: walk focused or main window only (fast)
                var windowValue: CFTypeRef?
                if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue) == .success
                    || AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &windowValue) == .success,
                   let window = windowValue {
                    let winTitle = getStringAttribute(window as! AXUIElement, kAXTitleAttribute)
                    collectInteractiveElements(
                        element: window as! AXUIElement, depth: 0, maxDepth: maxDepth,
                        screenBounds: screenBounds, clipRect: nil,
                        elements: &elements, nextId: &nextId
                    )
                    for i in beforeCount..<elements.count {
                        elements[i].appName = appName
                        elements[i].windowTitle = winTitle
                    }
                }
            }

            let contributed = elements.count - beforeCount
            if contributed > 0 {
                print("[GhostUI] getInteractiveElements: \(app?.localizedName ?? "pid \(pid)") contributed \(contributed) elements")
            }
        }

        // Cap element count to prevent noise from table-heavy apps
        if elements.count > AccessibilityService.maxElementCount {
            // Prioritize whitelisted-role elements, fill remaining with action-detected
            let roleElements = elements.filter { $0.source == .role }
            let actionElements = elements.filter { $0.source == .action }
            let remaining = AccessibilityService.maxElementCount - roleElements.count
            if remaining > 0 {
                elements = roleElements + Array(actionElements.prefix(remaining))
            } else {
                elements = Array(roleElements.prefix(AccessibilityService.maxElementCount))
            }
            // Re-number IDs sequentially
            nextId = 1
            elements = elements.map { elem in
                let newElem = InteractiveElement(
                    id: nextId,
                    role: elem.role,
                    label: elem.label,
                    title: elem.title,
                    value: elem.value,
                    frame: elem.frame,
                    source: elem.source,
                    parentPath: elem.parentPath
                )
                nextId += 1
                return newElem
            }
            print("[GhostUI] getInteractiveElements: capped from \(roleElements.count + actionElements.count) to \(elements.count) elements")
        }

        // Scroll state always queries frontmost window
        let scrollState: ScrollState
        if let frontApp = NSWorkspace.shared.frontmostApplication {
            let frontAppElement = AXUIElementCreateApplication(frontApp.processIdentifier)
            var frontWindowValue: CFTypeRef?
            if AXUIElementCopyAttributeValue(frontAppElement, kAXFocusedWindowAttribute as CFString, &frontWindowValue) == .success
                || AXUIElementCopyAttributeValue(frontAppElement, kAXMainWindowAttribute as CFString, &frontWindowValue) == .success,
               let fw = frontWindowValue {
                scrollState = detectScrollState(window: fw as! AXUIElement)
            } else {
                scrollState = ScrollState(canScrollUp: false, canScrollDown: false, canScrollLeft: false, canScrollRight: false)
            }
        } else {
            scrollState = ScrollState(canScrollUp: false, canScrollDown: false, canScrollLeft: false, canScrollRight: false)
        }

        return InteractiveElementsResult(elements: elements, scrollState: scrollState)
    }

    /// Returns interactive elements derived from the pruned a11y tree.
    /// IDs match DFS pre-order positions in `gui a11y --prune --xml` output,
    /// providing a single unified ID space for screenshots, elements, and click-id.
    func getInteractiveElementsFromTree(maxDepth: Int = 100) -> InteractiveElementsResult {
        let noScrollState = ScrollState(canScrollUp: false, canScrollDown: false, canScrollLeft: false, canScrollRight: false)
        let noResult = InteractiveElementsResult(elements: [], scrollState: noScrollState)

        guard let frontApp = NSWorkspace.shared.frontmostApplication else {
            return noResult
        }

        let pid = frontApp.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, 0.5)

        // Get the window element (same logic as findElementByIndex)
        var windowValue: CFTypeRef?
        var windowResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
        if windowResult != .success {
            windowResult = AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &windowValue)
        }
        let rootElement: AXUIElement = (windowResult == .success && windowValue != nil) ? (windowValue as! AXUIElement) : appElement

        // Build and prune the tree (no menus, matching default click-id behavior)
        let treeRef = buildNodeRef(element: rootElement, depth: 0, maxDepth: maxDepth)
        guard let pruned = treeRef.pruned() else {
            return noResult
        }

        // Screen bounds for clipping
        let screenBounds: (width: Double, height: Double)?
        if let screen = NSScreen.main {
            screenBounds = (width: Double(screen.frame.width), height: Double(screen.frame.height))
        } else {
            screenBounds = nil
        }

        // Walk pruned tree in DFS pre-order, collecting interactive elements
        // Counter increments for every node (matching renderNodeXML ID assignment)
        var elements: [InteractiveElement] = []
        var counter = 0
        var newCache: [Int: CachedElement] = [:]
        collectTreeElements(
            node: pruned, counter: &counter, elements: &elements,
            cacheEntries: &newCache,
            screenBounds: screenBounds, maxElements: AccessibilityService.maxElementCount
        )
        elementCache = newCache

        // Scroll state from frontmost window
        let scrollState: ScrollState
        if windowResult == .success, let win = windowValue {
            scrollState = detectScrollState(window: win as! AXUIElement)
        } else {
            scrollState = noScrollState
        }

        return InteractiveElementsResult(elements: elements, scrollState: scrollState)
    }

    /// Derive interactive elements from already-built AXNode trees.
    /// Walks in DFS pre-order with IDs matching `renderNodeXML` in the CLI,
    /// so overlay badge numbers correspond to `id=` attributes in XML output.
    func interactiveElementsFromAXNodes(
        _ nodePairs: [(menuBar: AXNode?, tree: AXNode?)],
        screenBounds: (width: Double, height: Double)?,
        includeText: Bool = false
    ) -> [InteractiveElement] {
        let interactiveRoles = includeText
            ? AXNode.interactivePruneRoles.union(["AXStaticText"])
            : AXNode.interactivePruneRoles

        var elements: [InteractiveElement] = []
        var counter = 0

        for pair in nodePairs {
            // Menu bar first, matching formatA11yTreeXML ordering
            if let mb = pair.menuBar {
                collectFromAXNode(
                    mb, counter: &counter, elements: &elements,
                    interactiveRoles: interactiveRoles,
                    screenBounds: screenBounds,
                    maxElements: AccessibilityService.maxElementCount
                )
            }
            if let tree = pair.tree {
                collectFromAXNode(
                    tree, counter: &counter, elements: &elements,
                    interactiveRoles: interactiveRoles,
                    screenBounds: screenBounds,
                    maxElements: AccessibilityService.maxElementCount
                )
            }
        }

        return elements
    }

    /// Recursive DFS helper for interactiveElementsFromAXNodes.
    /// Counter increments for EVERY node (not just interactive), matching renderNodeXML.
    private func collectFromAXNode(
        _ node: AXNode,
        counter: inout Int,
        elements: inout [InteractiveElement],
        interactiveRoles: Set<String>,
        screenBounds: (width: Double, height: Double)?,
        maxElements: Int
    ) {
        counter += 1
        let currentId = counter

        if let role = node.role, interactiveRoles.contains(role),
           elements.count < maxElements,
           let frame = node.frame,
           frame.width > 0, frame.height > 0 {
            var onScreen = true
            if let sb = screenBounds {
                onScreen = frame.x + frame.width > 0
                    && frame.y + frame.height > 0
                    && frame.x < sb.width
                    && frame.y < sb.height
            }
            if onScreen {
                let elem = InteractiveElement(
                    id: currentId,
                    role: role,
                    label: node.label,
                    title: node.title,
                    value: node.value,
                    frame: frame,
                    source: .role,
                    parentPath: []
                )
                elements.append(elem)
            }
        }

        if let children = node.children {
            for child in children {
                collectFromAXNode(
                    child, counter: &counter, elements: &elements,
                    interactiveRoles: interactiveRoles,
                    screenBounds: screenBounds,
                    maxElements: maxElements
                )
            }
        }
    }

    /// Walk a pruned AXNodeRef tree in DFS pre-order, collecting interactive nodes
    /// with visible on-screen frames as InteractiveElements. IDs = DFS position.
    private func collectTreeElements(
        node: AXNodeRef,
        counter: inout Int,
        elements: inout [InteractiveElement],
        cacheEntries: inout [Int: CachedElement],
        screenBounds: (width: Double, height: Double)?,
        maxElements: Int
    ) {
        counter += 1
        let currentId = counter

        if node.isInteractive && elements.count < maxElements {
            if let frame = getFrame(node.element),
               frame.width > 0, frame.height > 0 {
                var onScreen = true
                if let sb = screenBounds {
                    onScreen = frame.x + frame.width > 0
                        && frame.y + frame.height > 0
                        && frame.x < sb.width
                        && frame.y < sb.height
                }
                if onScreen {
                    let role = getStringAttribute(node.element, kAXRoleAttribute) ?? "Unknown"
                    var label = getStringAttribute(node.element, kAXDescriptionAttribute)
                    let title = getStringAttribute(node.element, kAXTitleAttribute)
                    // Buttons without title/label (e.g. Maps annotations) may
                    // expose a meaningful name via AXHelp.
                    if role == "AXButton", title == nil, label == nil {
                        label = getStringAttribute(node.element, kAXHelpAttribute)
                    }
                    let elem = InteractiveElement(
                        id: currentId,
                        role: role,
                        label: label,
                        title: title,
                        value: getValueString(node.element),
                        frame: frame,
                        source: .role,
                        parentPath: []
                    )
                    elements.append(elem)
                    cacheEntries[currentId] = CachedElement(
                        axElement: node.element,
                        frame: frame,
                        role: role,
                        label: label,
                        title: title
                    )
                }
            }
        }

        for child in node.children {
            collectTreeElements(
                node: child, counter: &counter, elements: &elements,
                cacheEntries: &cacheEntries,
                screenBounds: screenBounds, maxElements: maxElements
            )
        }
    }

    /// Check if an element has a meaningful interactive action (AXPress, AXIncrement, etc.)
    private func elementHasInteractiveAction(_ element: AXUIElement) -> Bool {
        var actionsRef: CFArray?
        guard AXUIElementCopyActionNames(element, &actionsRef) == .success,
              let actions = actionsRef as? [String] else {
            return false
        }
        return !actions.isEmpty && actions.contains(where: { AccessibilityService.meaningfulActions.contains($0) })
    }

    private func collectInteractiveElements(
        element: AXUIElement,
        depth: Int,
        maxDepth: Int,
        screenBounds: (width: Double, height: Double)?,
        clipRect: AXFrame?,
        elements: inout [InteractiveElement],
        nextId: inout Int,
        parentPath: [String] = []
    ) {
        let role = getStringAttribute(element, kAXRoleAttribute)

        // Narrow clip rect when entering a scroll area
        var childClipRect = clipRect
        if role == "AXScrollArea", let frame = getFrame(element) {
            childClipRect = intersectFrames(clipRect, frame)
        }

        // Build path for children: current role appended to parent path
        let childPath = role.map { parentPath + [$0] } ?? parentPath

        // Detect scrollable areas — include if they have active scroll bars
        if role == "AXScrollArea", let frame = getFrame(element),
           frame.width > 0 && frame.height > 0 {
            let scrollState = detectScrollState(window: element)
            let isScrollable = scrollState.canScrollUp || scrollState.canScrollDown
                || scrollState.canScrollLeft || scrollState.canScrollRight
            if isScrollable {
                var dirs: [String] = []
                if scrollState.canScrollUp { dirs.append("up") }
                if scrollState.canScrollDown { dirs.append("down") }
                if scrollState.canScrollLeft { dirs.append("left") }
                if scrollState.canScrollRight { dirs.append("right") }
                let elem = InteractiveElement(
                    id: nextId,
                    role: "AXScrollArea",
                    label: getStringAttribute(element, kAXDescriptionAttribute),
                    title: getStringAttribute(element, kAXTitleAttribute),
                    value: "scroll:\(dirs.joined(separator: ","))",
                    frame: frame,
                    source: .role,
                    parentPath: parentPath
                )
                elements.append(elem)
                nextId += 1
            }
        }

        // Determine detection source: role whitelist or action-based
        var detectionSource: DetectionSource? = nil
        if let role = role {
            if AccessibilityService.interactiveRoles.contains(role) {
                detectionSource = .role
            } else if !AccessibilityService.containerRoles.contains(role),
                      elementHasInteractiveAction(element) {
                detectionSource = .action
            }
        }

        if let source = detectionSource, let role = role {
            if let frame = getFrame(element) {
                // Skip zero-size elements
                guard frame.width > 0 && frame.height > 0 else {
                    return collectInteractiveElementsChildren(
                        element: element, depth: depth, maxDepth: maxDepth,
                        screenBounds: screenBounds, clipRect: childClipRect,
                        elements: &elements, nextId: &nextId, parentPath: childPath
                    )
                }
                // Skip elements entirely outside the visible screen area
                if let sb = screenBounds {
                    let outOfBounds =
                        frame.x + frame.width < 0 ||
                        frame.y + frame.height < 0 ||
                        frame.x > sb.width ||
                        frame.y > sb.height
                    if outOfBounds {
                        return collectInteractiveElementsChildren(
                            element: element, depth: depth, maxDepth: maxDepth,
                            screenBounds: screenBounds, clipRect: childClipRect,
                            elements: &elements, nextId: &nextId, parentPath: childPath
                        )
                    }
                }
                // Skip elements outside the scroll viewport
                if !frameIntersectsClip(frame, clipRect: clipRect) {
                    return collectInteractiveElementsChildren(
                        element: element, depth: depth, maxDepth: maxDepth,
                        screenBounds: screenBounds, clipRect: childClipRect,
                        elements: &elements, nextId: &nextId, parentPath: childPath
                    )
                }
                var resolvedLabel = getStringAttribute(element, kAXDescriptionAttribute)
                let resolvedTitle = getStringAttribute(element, kAXTitleAttribute)
                // Buttons without title/label (e.g. Maps annotations) may
                // expose a meaningful name via AXHelp.
                if role == "AXButton", resolvedTitle == nil, resolvedLabel == nil {
                    resolvedLabel = getStringAttribute(element, kAXHelpAttribute)
                }
                let elem = InteractiveElement(
                    id: nextId,
                    role: role,
                    label: resolvedLabel,
                    title: resolvedTitle,
                    value: getValueString(element),
                    frame: frame,
                    source: source,
                    parentPath: parentPath
                )
                elements.append(elem)
                nextId += 1
            }
        }

        collectInteractiveElementsChildren(
            element: element, depth: depth, maxDepth: maxDepth,
            screenBounds: screenBounds, clipRect: childClipRect,
            elements: &elements, nextId: &nextId, parentPath: childPath
        )
    }

    private func collectInteractiveElementsChildren(
        element: AXUIElement,
        depth: Int,
        maxDepth: Int,
        screenBounds: (width: Double, height: Double)?,
        clipRect: AXFrame?,
        elements: inout [InteractiveElement],
        nextId: inout Int,
        parentPath: [String]
    ) {
        guard depth < maxDepth else { return }

        let role = getStringAttribute(element, kAXRoleAttribute)
        let children = resolveChildren(element, role: role)
        if !children.isEmpty {
            // Check if any child is an overlay (popover, sheet, dialog)
            let overlayRoles: Set<String> = ["AXPopover", "AXSheet", "AXDialog"]
            var overlay: AXUIElement?
            var toolbars: [AXUIElement] = []

            for child in children {
                if let role = getStringAttribute(child, kAXRoleAttribute) {
                    if overlayRoles.contains(role) {
                        overlay = child
                    } else if role == "AXToolbar" {
                        toolbars.append(child)
                    }
                }
            }

            if let overlay = overlay {
                // Overlay present: only walk overlay + toolbars
                collectInteractiveElements(
                    element: overlay, depth: depth + 1, maxDepth: maxDepth,
                    screenBounds: screenBounds, clipRect: clipRect,
                    elements: &elements, nextId: &nextId, parentPath: parentPath
                )
                for toolbar in toolbars {
                    collectInteractiveElements(
                        element: toolbar, depth: depth + 1, maxDepth: maxDepth,
                        screenBounds: screenBounds, clipRect: clipRect,
                        elements: &elements, nextId: &nextId, parentPath: parentPath
                    )
                }
            } else {
                // No overlay: walk all children normally
                for child in children {
                    collectInteractiveElements(
                        element: child, depth: depth + 1, maxDepth: maxDepth,
                        screenBounds: screenBounds, clipRect: clipRect,
                        elements: &elements, nextId: &nextId, parentPath: parentPath
                    )
                }
            }
        }
    }

    // MARK: - Clip Rect Helpers

    /// Intersect two frames, or return the non-nil one if only one is provided.
    private func intersectFrames(_ a: AXFrame?, _ b: AXFrame) -> AXFrame {
        guard let a = a else { return b }
        let x1 = max(a.x, b.x)
        let y1 = max(a.y, b.y)
        let x2 = min(a.x + a.width, b.x + b.width)
        let y2 = min(a.y + a.height, b.y + b.height)
        let w = max(0, x2 - x1)
        let h = max(0, y2 - y1)
        return AXFrame(x: x1, y: y1, width: w, height: h)
    }

    /// Check if an element frame intersects the clip rect. Returns true when clipRect is nil.
    private func frameIntersectsClip(_ frame: AXFrame, clipRect: AXFrame?) -> Bool {
        guard let clip = clipRect else { return true }
        return frame.x + frame.width > clip.x
            && frame.y + frame.height > clip.y
            && frame.x < clip.x + clip.width
            && frame.y < clip.y + clip.height
    }

    // MARK: - Change Detection & Waiting

    /// Create a lightweight snapshot of current a11y state for change detection
    func createSnapshot(target: AXTarget = .front) -> A11ySnapshot {
        let elements = getInteractiveElementsFromTree()

        // Check for AXWebArea with children
        var hasWebArea = false
        if case .front = target {
            let trees = (try? getTree(maxDepth: 8, target: target)) ?? []
            hasWebArea = trees.contains { treeHasWebAreaWithChildren($0.tree) }
        }

        return A11ySnapshot(
            elementCount: elements.elements.count,
            windowTitle: getWindowTitle(target: target),
            hasWebAreaWithChildren: hasWebArea,
            timestamp: Date()
        )
    }

    /// Wait for a large change in the a11y tree (navigation)
    /// Returns true if large change detected, false if timeout
    @discardableResult
    func waitForLargeChange(before: A11ySnapshot, timeout: TimeInterval = 5.0) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)

        while Date() < deadline {
            let current = createSnapshot()

            if before.hasLargeChangeTo(current) {
                NSLog("✓ Large change detected: \(before.elementCount) → \(current.elementCount) elements")
                return true
            }

            Thread.sleep(forTimeInterval: 0.5)
        }

        NSLog("⚠️ No large change detected within \(timeout)s timeout")
        return false
    }

    /// Wait for a11y tree to stabilize (no changes for N consecutive polls)
    func waitForStabilization(polls: Int = 2, interval: TimeInterval = 0.5, timeout: TimeInterval = 5.0) {
        var stableCount = 0
        var prev = createSnapshot()
        let deadline = Date().addingTimeInterval(timeout)

        while stableCount < polls && Date() < deadline {
            Thread.sleep(forTimeInterval: interval)
            let current = createSnapshot()

            if current.elementCount == prev.elementCount {
                stableCount += 1
            } else {
                stableCount = 0
                NSLog("🔄 Tree changed: \(prev.elementCount) → \(current.elementCount) elements")
            }

            prev = current
        }

        if stableCount >= polls {
            NSLog("✓ Tree stabilized at \(prev.elementCount) elements")
        } else {
            NSLog("⚠️ Tree did not stabilize within timeout")
        }
    }

    /// Wait for any change in the a11y tree (update)
    /// Returns true if change detected, false if timeout
    @discardableResult
    func waitForAnyChange(before: A11ySnapshot, timeout: TimeInterval = 2.0) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)

        while Date() < deadline {
            let current = createSnapshot()

            if before.hasAnyChangeTo(current) {
                NSLog("✓ Change detected: \(before.elementCount) → \(current.elementCount) elements")
                return true
            }

            Thread.sleep(forTimeInterval: 0.25)
        }

        NSLog("⚠️ No change detected within \(timeout)s timeout (might be ok)")
        return false
    }

    // MARK: - Actions

    /// Perform an AX action on an element found by label or role+title.
    /// - nth: 0-indexed, selects the Nth matching element in tree order
    /// - parent: only match elements whose ancestor contains this text
    func performAction(label: String? = nil, role: String? = nil, action: String = "AXPress", target: AXTarget = .front, nth: Int? = nil, parent: String? = nil) throws {

        guard !target.isMulti else { throw AXServiceError.multiTargetNotAllowed }

        let targets = try resolveTarget(target)
        guard let (pid, _) = targets.first else { throw AXServiceError.noFocusedApp }

        let appElement = AXUIElementCreateApplication(pid)

        var windowValue: CFTypeRef?
        _ = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)

        let searchRoot: AXUIElement = (windowValue as! AXUIElement?) ?? appElement
        let fallbackRoot: AXUIElement? = windowValue != nil ? appElement : nil

        let element: AXUIElement
        do {
            element = try resolveElement(in: searchRoot, fallbackRoot: fallbackRoot, label: label, role: role, nth: nth, parent: parent)
        } catch {
            // Element not found in window/app — search floating context menus
            // (layer-101 CGWindows not reachable via kAXChildrenAttribute).
            if let menuElement = findElementInFloatingMenus(label: label, role: role, nth: nth, parent: parent) {
                element = menuElement
            } else {
                throw error
            }
        }

        // AXFocus: set kAXFocusedAttribute on the element without moving pointer.
        // Useful for moving focus between split panes where Tab doesn't work
        // (e.g. Contacts.app SplitGroup panes).
        if action == "AXFocus" {
            guard isAttributeSettable(element, kAXFocusedAttribute) == true else {
                let role = getStringAttribute(element, kAXRoleAttribute) ?? "unknown"
                throw AXServiceError.actionFailed("AXFocus: kAXFocusedAttribute is not settable on \(role)")
            }
            let focusResult = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, true as CFTypeRef)
            if focusResult == .success { return }
            throw AXServiceError.actionFailed("AXFocus (kAXFocusedAttribute) returned \(focusResult.rawValue)")
        }

        // For AXPress, use PointerService for the physical click (proven reliable),
        // then reinforce with AXPress for elements that don't respond to synthetic
        // mouse events (e.g. toolbar buttons in Notes).
        if action == "AXPress" {
            if let frame = getFrame(element) {
                let center = CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
                let _ = try? PointerService.shared.sendEvent(
                    action: "click", x: center.x, y: center.y,
                    button: nil, label: nil, endX: nil, endY: nil
                )
                usleep(50_000)

                // If CGEvent destroyed the element, we're done
                var roleCheck: CFTypeRef?
                let check = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleCheck)
                if check == .invalidUIElement || check == .cannotComplete {
                    return
                }

                // Check if element supports AXPress before reinforcing — calling
                // AXPress on elements that don't support it (e.g. Contacts buttons
                // with empty action list) can interfere with the CGEvent click.
                var actionsRef: CFArray?
                if AXUIElementCopyActionNames(element, &actionsRef) == .success,
                   let actions = actionsRef as? [String],
                   actions.contains("AXPress") {
                    AXUIElementPerformAction(element, action as CFString)
                }
                return
            }

            // CGEvent not possible (no frame) — fall back to AXPress only
            let result = AXUIElementPerformAction(element, action as CFString)
            if result == .success { return }

            var roleCheck: CFTypeRef?
            let check = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleCheck)
            if check == .invalidUIElement || check == .cannotComplete {
                return // element gone — action succeeded
            }

            throw AXServiceError.actionFailed("\(action) returned \(result.rawValue)")
        }

        // Non-AXPress actions (e.g. AXShowMenu) — move pointer + overlay, then use AX directly
        if let frame = getFrame(element) {
            let center = CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
            if let moveEvent = CGEvent(mouseEventSource: CGEventSource(stateID: .combinedSessionState), mouseType: .mouseMoved, mouseCursorPosition: center, mouseButton: .left) {
                moveEvent.post(tap: .cgSessionEventTap)
            }
            ClickOverlayService.shared.animateClick(at: center)
            usleep(300_000)
        }
        let result = AXUIElementPerformAction(element, action as CFString)
        if result == .success { return }
        throw AXServiceError.actionFailed("\(action) returned \(result.rawValue)")
    }

    /// Move the pointer to hover over an element found by label/role (no click)
    func hoverElement(label: String? = nil, role: String? = nil, target: AXTarget = .front, nth: Int? = nil, parent: String? = nil) throws {
        guard !target.isMulti else { throw AXServiceError.multiTargetNotAllowed }

        let targets = try resolveTarget(target)
        guard let (pid, runningApp) = targets.first else { throw AXServiceError.noFocusedApp }

        // Ensure app is focused
        runningApp?.activate()
        usleep(50_000)

        let appElement = AXUIElementCreateApplication(pid)

        var windowValue: CFTypeRef?
        _ = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)

        let searchRoot: AXUIElement = (windowValue as! AXUIElement?) ?? appElement
        let fallbackRoot: AXUIElement? = windowValue != nil ? appElement : nil

        let element: AXUIElement
        do {
            element = try resolveElement(in: searchRoot, fallbackRoot: fallbackRoot, label: label, role: role, nth: nth, parent: parent)
        } catch {
            if let menuElement = findElementInFloatingMenus(label: label, role: role, nth: nth, parent: parent) {
                element = menuElement
            } else {
                throw error
            }
        }

        guard let frame = getFrame(element) else {
            throw AXServiceError.actionFailed("Element has no frame")
        }

        let center = CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
        if let moveEvent = CGEvent(mouseEventSource: CGEventSource(stateID: .combinedSessionState), mouseType: .mouseMoved, mouseCursorPosition: center, mouseButton: .left) {
            moveEvent.post(tap: .cgSessionEventTap)
        }
    }

    /// Set the value of an element found by label/role, or the focused element if no target specified
    func setValue(_ value: String, label: String? = nil, role: String? = nil, target: AXTarget = .front, nth: Int? = nil, parent: String? = nil) throws {

        guard !target.isMulti else { throw AXServiceError.multiTargetNotAllowed }

        let targets = try resolveTarget(target)
        guard let (pid, _) = targets.first else { throw AXServiceError.noFocusedApp }

        let appElement = AXUIElementCreateApplication(pid)

        let element: AXUIElement
        if label != nil || role != nil {
            var windowValue: CFTypeRef?
            _ = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
            let searchRoot: AXUIElement = (windowValue as! AXUIElement?) ?? appElement
            let fallbackRoot: AXUIElement? = windowValue != nil ? appElement : nil
            do {
                element = try resolveElement(in: searchRoot, fallbackRoot: fallbackRoot, label: label, role: role, nth: nth, parent: parent)
            } catch {
                // Search floating context menus (layer-101 CGWindows)
                if let menuElement = findElementInFloatingMenus(label: label, role: role, nth: nth, parent: parent) {
                    element = menuElement
                } else {
                    // Element not found by label/role — fall back to focused element.
                    // This handles rename mode in Finder where the ListItem disappears
                    // from the AX tree but the AXTextField is focused and editable.
                    var focusedValue: CFTypeRef?
                    let focusResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedValue)
                    if focusResult == .success, let focused = focusedValue {
                        let focusedEl = focused as! AXUIElement
                        let focusedRole = getStringAttribute(focusedEl, kAXRoleAttribute)
                        if focusedRole == "AXTextField" || focusedRole == "AXTextArea" {
                            element = focusedEl
                        } else {
                            throw error // rethrow original error
                        }
                    } else {
                        throw error // rethrow original error
                    }
                }
            }
        } else {
            // Use the focused UI element
            var focusedValue: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedValue)
            guard result == .success, let focused = focusedValue else {
                throw AXServiceError.elementNotFound("focused element")
            }
            element = focused as! AXUIElement
        }

        // Focus the element first
        AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, true as CFTypeRef)

        // Try setting value directly on the matched element
        var setResult = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
        if setResult == .success { return }

        // AXSetValue can fail on unfocused fields (e.g. -25202 cannotComplete in Contacts).
        // The focus above may not have taken effect yet — wait and retry.
        if setResult == .cannotComplete || setResult == .failure {
            usleep(200_000)
            setResult = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
            if setResult == .success { return }
        }

        // Direct set failed — look for a child AXTextField to set on instead.
        // This handles cases like Finder's AXRow which contains an AXTextField for the filename.
        // Focusing the text field enters edit mode, after which value can be set.
        if let textField = findChildTextField(element) {
            AXUIElementSetAttributeValue(textField, kAXFocusedAttribute as CFString, true as CFTypeRef)
            usleep(200_000) // Wait for edit mode to engage

            let retryResult = AXUIElementSetAttributeValue(textField, kAXValueAttribute as CFString, value as CFTypeRef)
            if retryResult == .success { return }

            throw AXServiceError.actionFailed("AXSetValue on child text field returned \(retryResult.rawValue)")
        }

        throw AXServiceError.actionFailed("AXSetValue returned \(setResult.rawValue)")
    }

    /// Type text into an element using keyboard simulation, preserving rich text formatting.
    /// This focuses the element, moves cursor to the end, and types character by character.
    func typeValue(_ value: String, label: String? = nil, role: String? = nil, target: AXTarget = .front, nth: Int? = nil, parent: String? = nil) throws {

        guard !target.isMulti else { throw AXServiceError.multiTargetNotAllowed }

        let targets = try resolveTarget(target)
        guard let (pid, _) = targets.first else { throw AXServiceError.noFocusedApp }

        let appElement = AXUIElementCreateApplication(pid)

        let element: AXUIElement
        if label != nil || role != nil {
            var windowValue: CFTypeRef?
            _ = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
            let searchRoot: AXUIElement = (windowValue as! AXUIElement?) ?? appElement
            let fallbackRoot: AXUIElement? = windowValue != nil ? appElement : nil
            do {
                element = try resolveElement(in: searchRoot, fallbackRoot: fallbackRoot, label: label, role: role, nth: nth, parent: parent)
            } catch {
                var focusedValue: CFTypeRef?
                let focusResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedValue)
                if focusResult == .success, let focused = focusedValue {
                    let focusedEl = focused as! AXUIElement
                    let focusedRole = getStringAttribute(focusedEl, kAXRoleAttribute)
                    if focusedRole == "AXTextField" || focusedRole == "AXTextArea" {
                        element = focusedEl
                    } else {
                        throw error
                    }
                } else {
                    throw error
                }
            }
        } else {
            var focusedValue: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedValue)
            guard result == .success, let focused = focusedValue else {
                throw AXServiceError.elementNotFound("focused element")
            }
            element = focused as! AXUIElement
        }

        // Focus the element
        AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, true as CFTypeRef)
        usleep(100_000)

        // Move cursor to end: Cmd+End
        let eventSource = CGEventSource(stateID: .combinedSessionState)
        if let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0x77, keyDown: true),
           let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0x77, keyDown: false) {
            down.flags = .maskCommand
            up.flags = .maskCommand
            down.post(tap: .cgSessionEventTap)
            up.post(tap: .cgSessionEventTap)
        }
        usleep(50_000)

        // Type the text character by character using KeyboardService
        try KeyboardService.shared.sendInput(text: value, keys: nil, modifiers: nil, rate: nil)
    }

    /// Find the first AXTextField descendant (up to 3 levels deep).
    private func findChildTextField(_ element: AXUIElement, depth: Int = 0) -> AXUIElement? {
        guard depth < 3 else { return nil }

        var childrenValue: CFTypeRef?
        let childResult = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        guard childResult == .success, let children = childrenValue as? [AXUIElement] else { return nil }

        for child in children {
            let childRole = getStringAttribute(child, kAXRoleAttribute)
            if childRole == "AXTextField" || childRole == "AXTextArea" {
                return child
            }
            if let found = findChildTextField(child, depth: depth + 1) {
                return found
            }
        }
        return nil
    }

    /// Trigger a menu item by path. E.g. ["File", "New Window"]
    func triggerMenuItem(path: [String], target: AXTarget = .front) throws {

        guard !target.isMulti else { throw AXServiceError.multiTargetNotAllowed }
        guard !path.isEmpty else { throw AXServiceError.menuNotFound("empty path") }

        let targets = try resolveTarget(target)
        guard let (pid, _) = targets.first else { throw AXServiceError.noFocusedApp }

        let appElement = AXUIElementCreateApplication(pid)

        // Get the menu bar
        var menuBarValue: CFTypeRef?
        let mbResult = AXUIElementCopyAttributeValue(appElement, kAXMenuBarAttribute as CFString, &menuBarValue)
        guard mbResult == .success, let menuBar = menuBarValue else {
            throw AXServiceError.menuNotFound("menu bar not accessible")
        }

        // Walk the menu path
        var current: AXUIElement = menuBar as! AXUIElement
        for (i, name) in path.enumerated() {
            guard let child = findChildByTitle(in: current, title: name) else {
                let soFar = path[0...i].joined(separator: " > ")
                throw AXServiceError.menuNotFound(soFar)
            }

            if i < path.count - 1 {
                // Open submenu: move pointer to menu item, then click to open
                if let frame = getFrame(child) {
                    let center = CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
                    if let moveEvent = CGEvent(mouseEventSource: CGEventSource(stateID: .combinedSessionState), mouseType: .mouseMoved, mouseCursorPosition: center, mouseButton: .left) {
                        moveEvent.post(tap: .cgSessionEventTap)
                    }
                    ClickOverlayService.shared.animateClick(at: center)
                    usleep(300_000)
                    if let down = CGEvent(mouseEventSource: CGEventSource(stateID: .combinedSessionState), mouseType: .leftMouseDown, mouseCursorPosition: center, mouseButton: .left),
                       let up = CGEvent(mouseEventSource: CGEventSource(stateID: .combinedSessionState), mouseType: .leftMouseUp, mouseCursorPosition: center, mouseButton: .left) {
                        down.post(tap: .cgSessionEventTap)
                        usleep(10_000)
                        up.post(tap: .cgSessionEventTap)
                    } else {
                        // CGEvent failed — fall back to AXPress
                        AXUIElementPerformAction(child, kAXPressAction as CFString)
                    }
                } else {
                    AXUIElementPerformAction(child, kAXPressAction as CFString)
                }
                usleep(100_000) // 100ms for menu to open

                // Now the submenu children should be available
                // Navigate into the submenu by looking at children
                var submenuValue: CFTypeRef?
                let subResult = AXUIElementCopyAttributeValue(child, kAXChildrenAttribute as CFString, &submenuValue)
                if subResult == .success, let submenus = submenuValue as? [AXUIElement], let submenu = submenus.first {
                    current = submenu
                } else {
                    current = child
                }
            } else {
                // Final item — move pointer to it, then click
                if let frame = getFrame(child) {
                    let center = CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
                    if let moveEvent = CGEvent(mouseEventSource: CGEventSource(stateID: .combinedSessionState), mouseType: .mouseMoved, mouseCursorPosition: center, mouseButton: .left) {
                        moveEvent.post(tap: .cgSessionEventTap)
                    }
                    ClickOverlayService.shared.animateClick(at: center)
                    usleep(300_000)
                    if let down = CGEvent(mouseEventSource: CGEventSource(stateID: .combinedSessionState), mouseType: .leftMouseDown, mouseCursorPosition: center, mouseButton: .left),
                       let up = CGEvent(mouseEventSource: CGEventSource(stateID: .combinedSessionState), mouseType: .leftMouseUp, mouseCursorPosition: center, mouseButton: .left) {
                        down.post(tap: .cgSessionEventTap)
                        usleep(10_000)
                        up.post(tap: .cgSessionEventTap)
                    } else {
                        // CGEvent failed — fall back to AXPress
                        let pressResult = AXUIElementPerformAction(child, kAXPressAction as CFString)
                        guard pressResult == .success else {
                            throw AXServiceError.actionFailed("AXPress on '\(name)' returned \(pressResult.rawValue)")
                        }
                    }
                } else {
                    let pressResult = AXUIElementPerformAction(child, kAXPressAction as CFString)
                    guard pressResult == .success else {
                        throw AXServiceError.actionFailed("AXPress on '\(name)' returned \(pressResult.rawValue)")
                    }
                }
            }
        }
    }

    /// Get the focused UI element's role, value, and available actions
    func getFocusedElement(target: AXTarget = .front) throws -> [String: Any] {

        guard !target.isMulti else { throw AXServiceError.multiTargetNotAllowed }

        let targets = try resolveTarget(target)
        guard let (pid, _) = targets.first else { throw AXServiceError.noFocusedApp }

        let appElement = AXUIElementCreateApplication(pid)

        var focusedValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedValue)
        guard result == .success, let focused = focusedValue else {
            // No focused element is a valid state, not an error
            return ["role": "none", "focused": false]
        }

        let element = focused as! AXUIElement
        var info: [String: Any] = [:]
        info["role"] = getStringAttribute(element, kAXRoleAttribute) ?? "unknown"
        info["title"] = getStringAttribute(element, kAXTitleAttribute)
        info["label"] = getStringAttribute(element, kAXDescriptionAttribute)
        info["value"] = getValueString(element)
        info["focused"] = true

        // Get available actions
        var actionsValue: CFArray?
        if AXUIElementCopyActionNames(element, &actionsValue) == .success, let actions = actionsValue as? [String] {
            info["actions"] = actions
        }

        return info
    }

    // MARK: - Flexible element finding (with disambiguation)

    /// Resolve a single element from label/role, with optional disambiguation via nth or parent.
    /// - nth: 0-indexed, selects the Nth matching element in tree order
    /// - parent: if set, only matches elements that have an ancestor whose title/description/value contains this string
    func resolveElement(in searchRoot: AXUIElement, fallbackRoot: AXUIElement?, label: String?, role: String?, nth: Int?, parent: String?) throws -> AXUIElement {
        var candidates = findAllElementsFlexible(in: searchRoot, label: label, role: role, depth: 0, maxDepth: 15)

        // Fallback: search app-level if not found in window
        if candidates.isEmpty, let fallback = fallbackRoot {
            candidates = findAllElementsFlexible(in: fallback, label: label, role: role, depth: 0, maxDepth: 15)
        }

        // Filter by parent context
        if let parent = parent {
            candidates = candidates.filter { el in
                ancestorContainsText(el, text: parent)
            }
        }

        guard !candidates.isEmpty else {
            throw AXServiceError.elementNotFound(label ?? role ?? "unknown")
        }

        let index = nth ?? 0
        guard index >= 0, index < candidates.count else {
            throw AXServiceError.elementNotFound("nth=\(index) out of range (found \(candidates.count) matches for \(label ?? role ?? "unknown"))")
        }

        return candidates[index]
    }

    /// Search floating context menus (layer-101 CGWindows) for an element matching
    /// label/role. Context menus are not children of the focused window or app element
    /// in the AX hierarchy, so they require hit-testing via CGWindowList to discover.
    func findElementInFloatingMenus(label: String?, role: String?, nth: Int?, parent: String?) -> AXUIElement? {
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }

        for info in windowList {
            let layer = info[kCGWindowLayer as String] as? Int ?? 0
            guard layer == 101 else { continue }

            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t else { continue }

            let bounds = info[kCGWindowBounds as String] as? [String: Any]
            let wx = bounds?["X"] as? Double ?? 0
            let wy = bounds?["Y"] as? Double ?? 0
            let ww = bounds?["Width"] as? Double ?? 0
            let wh = bounds?["Height"] as? Double ?? 0

            // Skip tiny windows (status bar extras are also layer 101)
            guard ww > 50 && wh > 50 else { continue }

            // Hit-test the center of the menu window to find an AX element
            let appElement = AXUIElementCreateApplication(pid)
            var hitElement: AXUIElement?
            let cx = Float(wx + ww / 2)
            let cy = Float(wy + wh / 2)
            let hitResult = AXUIElementCopyElementAtPosition(appElement, cx, cy, &hitElement)
            guard hitResult == .success, let hit = hitElement else { continue }

            // Walk up from the hit element to find the AXMenu root
            var menuRoot: AXUIElement? = nil
            let hitRole = getStringAttribute(hit, kAXRoleAttribute)
            if hitRole == "AXMenu" {
                menuRoot = hit
            } else {
                var current = hit
                for _ in 0..<20 {
                    var parentValue: CFTypeRef?
                    let pResult = AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentValue)
                    guard pResult == .success, let parentEl = parentValue else { break }
                    let parentElement = parentEl as! AXUIElement
                    let parentRole = getStringAttribute(parentElement, kAXRoleAttribute)
                    if parentRole == "AXMenu" {
                        menuRoot = parentElement
                    }
                    if parentRole == "AXWindow" || parentRole == "AXApplication" { break }
                    current = parentElement
                }
            }

            guard let menu = menuRoot else { continue }

            // Search within the menu for matching elements
            var candidates = findAllElementsFlexible(in: menu, label: label, role: role, depth: 0, maxDepth: 15)

            if let parent = parent {
                candidates = candidates.filter { el in
                    ancestorContainsText(el, text: parent)
                }
            }

            guard !candidates.isEmpty else { continue }

            let index = nth ?? 0
            guard index >= 0, index < candidates.count else { continue }

            return candidates[index]
        }

        return nil
    }

    /// Walk ancestors of `element` and check if any has title/description/value containing `text`.
    private func ancestorContainsText(_ element: AXUIElement, text: String) -> Bool {
        var current: AXUIElement = element
        for _ in 0..<20 {
            var parentValue: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentValue)
            guard result == .success, let parentEl = parentValue as! AXUIElement? else { return false }

            let title = getStringAttribute(parentEl, kAXTitleAttribute) ?? ""
            let desc = getStringAttribute(parentEl, kAXDescriptionAttribute) ?? ""
            let value = getValueString(parentEl) ?? ""

            if title.contains(text) || desc.contains(text) || value.contains(text) {
                return true
            }

            // Also check child static text of the parent for the context string
            if childTextContainsSubstring(parentEl, text: text) {
                return true
            }

            current = parentEl
        }
        return false
    }

    /// Check if any descendant AXStaticText of element contains the given text (substring).
    private func childTextContainsSubstring(_ element: AXUIElement, text: String, depth: Int = 0) -> Bool {
        guard depth < 3 else { return false }
        var childrenValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        guard result == .success, let children = childrenValue as? [AXUIElement] else { return false }
        for child in children {
            let childRole = getStringAttribute(child, kAXRoleAttribute)
            if childRole == "AXStaticText" || childRole == "AXCell" {
                let t = getStringAttribute(child, kAXTitleAttribute) ?? ""
                let v = getValueString(child) ?? ""
                let d = getStringAttribute(child, kAXDescriptionAttribute) ?? ""
                if t.contains(text) || v.contains(text) || d.contains(text) { return true }
            }
            if childTextContainsSubstring(child, text: text, depth: depth + 1) { return true }
        }
        return false
    }

    /// Collect ALL matching elements in DFS order.
    private func findAllElementsFlexible(in element: AXUIElement, label: String?, role: String?, depth: Int, maxDepth: Int) -> [AXUIElement] {
        var results: [AXUIElement] = []

        let elRole = getStringAttribute(element, kAXRoleAttribute)
        let elTitle = getStringAttribute(element, kAXTitleAttribute)
        let elDesc = getStringAttribute(element, kAXDescriptionAttribute)
        let elValue = getValueString(element)
        let elIdentifier = getStringAttribute(element, kAXIdentifierAttribute)
        let elPlaceholder = getStringAttribute(element, "AXPlaceholderValue")

        var labelMatches = true
        if let label = label {
            labelMatches = (elTitle == label || elDesc == label || elValue == label || elIdentifier == label || elPlaceholder == label)
        }

        if !labelMatches, let label = label {
            // When a role is specified and matches, check child text (original behavior)
            // Also check child text for container roles even without a role filter,
            // so e.g. setValue(label: "filename") can find Finder AXRow/AXOutlineRow
            // whose filename lives in a child AXStaticText/AXTextField.
            let containerRoles: Set<String> = ["AXRow", "AXOutlineRow", "AXCell", "AXGroup"]
            let shouldCheckChildren = (role != nil && elRole == role)
                || (role == nil && elRole.map { containerRoles.contains($0) } ?? false)
            if shouldCheckChildren, childTextContains(element, label: label) {
                results.append(element)
            }
        }

        var matches = labelMatches
        if let role = role, matches {
            // Match by role or subrole (e.g. AXTextField with subrole AXSearchField
            // should be findable by role "AXSearchField")
            let elSubrole = getStringAttribute(element, kAXSubroleAttribute)
            matches = (elRole == role || elSubrole == role)
        }
        if matches && (label != nil || role != nil) {
            results.append(element)
        }

        guard depth < maxDepth else { return results }

        var childrenValue: CFTypeRef?
        let copyResult = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        if copyResult == .success, let children = childrenValue as? [AXUIElement] {
            for child in children {
                results.append(contentsOf: findAllElementsFlexible(in: child, label: label, role: role, depth: depth + 1, maxDepth: maxDepth))
            }
        }

        return results
    }

    /// Legacy single-match finder (used by callers that don't need disambiguation)
    private func findElementFlexible(in element: AXUIElement, label: String?, role: String?, depth: Int, maxDepth: Int) -> AXUIElement? {
        return findAllElementsFlexible(in: element, label: label, role: role, depth: depth, maxDepth: maxDepth).first
    }

    /// Check if any descendant AXStaticText, AXCell, or AXTextField contains the given label (up to 3 levels deep).
    private func childTextContains(_ element: AXUIElement, label: String, depth: Int = 0) -> Bool {
        guard depth < 3 else { return false }
        var childrenValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        guard result == .success, let children = childrenValue as? [AXUIElement] else { return false }
        for child in children {
            let childRole = getStringAttribute(child, kAXRoleAttribute)
            if childRole == "AXStaticText" || childRole == "AXCell" || childRole == "AXTextField" {
                let t = getStringAttribute(child, kAXTitleAttribute)
                let v = getValueString(child)
                let d = getStringAttribute(child, kAXDescriptionAttribute)
                if t == label || v == label || d == label { return true }
            }
            if childTextContains(child, label: label, depth: depth + 1) { return true }
        }
        return false
    }

    /// Normalize "..." (three periods) to the Unicode ellipsis character "…" (U+2026)
    /// so agents don't need to know about macOS menu typography.
    private func normalizeEllipsis(_ s: String) -> String {
        s.replacingOccurrences(of: "...", with: "\u{2026}")
    }

    private func findChildByTitle(in element: AXUIElement, title: String) -> AXUIElement? {
        var childrenValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        guard result == .success, let children = childrenValue as? [AXUIElement] else { return nil }

        let normalizedTitle = normalizeEllipsis(title)

        for child in children {
            let childTitle = getStringAttribute(child, kAXTitleAttribute)
            if childTitle == title || childTitle == normalizedTitle { return child }
        }
        return nil
    }

    // MARK: - Element-by-Index (for pruned tree IDs)

    /// Tree node that pairs an AXNode with its backing AXUIElement reference
    private struct AXNodeRef {
        let element: AXUIElement
        let isInteractive: Bool
        var children: [AXNodeRef]

        func pruned() -> AXNodeRef? {
            let prunedChildren = children.compactMap { $0.pruned() }

            if prunedChildren.isEmpty && !isInteractive {
                return nil
            }

            if !isInteractive && prunedChildren.count == 1 {
                return prunedChildren[0]
            }

            return AXNodeRef(element: element, isInteractive: isInteractive, children: prunedChildren)
        }

        func limitDepth(_ maxDepth: Int, currentDepth: Int = 0) -> AXNodeRef? {
            if currentDepth >= maxDepth {
                return AXNodeRef(element: element, isInteractive: isInteractive, children: [])
            }

            let limitedChildren = children.compactMap {
                $0.limitDepth(maxDepth, currentDepth: currentDepth + 1)
            }

            return AXNodeRef(element: element, isInteractive: isInteractive, children: limitedChildren)
        }
    }

    /// Build a tree with element references (mirrors buildNode)
    private func buildNodeRef(element: AXUIElement, depth: Int, maxDepth: Int, includeText: Bool = false) -> AXNodeRef {
        let role = getStringAttribute(element, kAXRoleAttribute)
        let effectiveRoles = includeText ? AXNode.interactivePruneRoles.union(["AXStaticText"]) : AXNode.interactivePruneRoles
        let isInteractive = role.map { effectiveRoles.contains($0) } ?? false

        var children: [AXNodeRef] = []
        if depth < maxDepth {
            let childElements = resolveChildren(element, role: role)
            children = childElements.map {
                buildNodeRef(element: $0, depth: depth + 1, maxDepth: maxDepth, includeText: includeText)
            }
        }

        return AXNodeRef(element: element, isInteractive: isInteractive, children: children)
    }

    /// Walk a node ref tree in pre-order DFS (same order as renderNodeXML), find element at target index
    private func findInNodeRef(_ node: AXNodeRef, targetIndex: Int, counter: inout Int) -> AXUIElement? {
        counter += 1
        if counter == targetIndex {
            return node.element
        }

        for child in node.children {
            if let found = findInNodeRef(child, targetIndex: targetIndex, counter: &counter) {
                return found
            }
        }
        return nil
    }

    /// Find an AXUIElement by its sequential index in the pruned (or unpruned) tree.
    /// The index corresponds to DFS pre-order position, matching the `id=` attributes in XML output.
    func findElementByIndex(index: Int, target: AXTarget = .front, prune: Bool = true, menus: Bool = false, depth: Int = 100, includeText: Bool = false) throws -> AXUIElement? {
        guard !target.isMulti else { throw AXServiceError.multiTargetNotAllowed }

        let targets = try resolveTarget(target)
        guard let (pid, _) = targets.first else { throw AXServiceError.noFocusedApp }

        let appElement = AXUIElementCreateApplication(pid)

        // Build menu bar ref tree
        var menuBarRef: AXNodeRef?
        if menus {
            var menuBarValue: CFTypeRef?
            let menuBarResult = AXUIElementCopyAttributeValue(appElement, kAXMenuBarAttribute as CFString, &menuBarValue)
            if menuBarResult == .success, let mb = menuBarValue {
                let ref = buildNodeRef(element: mb as! AXUIElement, depth: 0, maxDepth: depth, includeText: includeText)
                if prune {
                    menuBarRef = ref.pruned()
                } else {
                    menuBarRef = ref
                }
            }
        }

        // Build main tree ref
        var windowValue: CFTypeRef?
        var windowResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
        if windowResult != .success {
            windowResult = AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &windowValue)
        }
        let rootElement: AXUIElement = (windowResult == .success && windowValue != nil) ? (windowValue as! AXUIElement) : appElement

        var treeRef = buildNodeRef(element: rootElement, depth: 0, maxDepth: depth, includeText: includeText)
        if prune {
            guard let pruned = treeRef.pruned() else {
                return nil
            }
            treeRef = pruned
        }

        // Walk in same order as formatA11yTreeXML: menu bar first, then tree
        var counter = 0

        if let mbRef = menuBarRef {
            if let found = findInNodeRef(mbRef, targetIndex: index, counter: &counter) {
                return found
            }
        }

        return findInNodeRef(treeRef, targetIndex: index, counter: &counter)
    }

    /// Find all elements matching a specific role
    func findElementsByRole(role: String, target: AXTarget = .front, maxDepth: Int = 100) throws -> [AXUIElement] {
        guard !target.isMulti else { throw AXServiceError.multiTargetNotAllowed }

        let targets = try resolveTarget(target)
        guard let (pid, _) = targets.first else { throw AXServiceError.noFocusedApp }

        let appElement = AXUIElementCreateApplication(pid)

        // Get the focused or main window
        var windowValue: CFTypeRef?
        var windowResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
        if windowResult != .success {
            windowResult = AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &windowValue)
        }
        let rootElement: AXUIElement = (windowResult == .success && windowValue != nil) ? (windowValue as! AXUIElement) : appElement

        // Collect all elements matching the role
        var results: [AXUIElement] = []
        collectElementsByRole(element: rootElement, role: role, depth: 0, maxDepth: maxDepth, results: &results)

        return results
    }

    /// Recursively collect elements matching a role
    private func collectElementsByRole(element: AXUIElement, role: String, depth: Int, maxDepth: Int, results: inout [AXUIElement]) {
        guard depth < maxDepth else { return }

        // Check if this element matches the role
        if let elementRole = getStringAttribute(element, kAXRoleAttribute) {
            // Normalize role by removing "AX" prefix if present
            let normalizedRole = role.hasPrefix("AX") ? role : "AX\(role)"
            let normalizedElementRole = elementRole.hasPrefix("AX") ? elementRole : "AX\(elementRole)"

            if normalizedElementRole.lowercased() == normalizedRole.lowercased() {
                results.append(element)
            }
        }

        // Recursively search children
        var childrenValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue) == .success,
              let children = childrenValue as? [AXUIElement] else {
            return
        }

        for child in children {
            collectElementsByRole(element: child, role: role, depth: depth + 1, maxDepth: maxDepth, results: &results)
        }
    }

    /// Walk up the AX parent chain to find the nearest enclosing AXScrollArea
    func findEnclosingScrollArea(element: AXUIElement) -> AXUIElement? {
        // Check if the element itself is a scroll area
        if getStringAttribute(element, kAXRoleAttribute) == "AXScrollArea" {
            return element
        }

        var current = element
        for _ in 0..<50 {
            var parentValue: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentValue)
            guard result == .success, let parent = parentValue else { return nil }

            let parentElement = parent as! AXUIElement
            if getStringAttribute(parentElement, kAXRoleAttribute) == "AXScrollArea" {
                return parentElement
            }
            current = parentElement
        }
        return nil
    }

    /// Scroll the area containing the element at the given pruned-tree index.
    /// Uses cached element data when available to avoid tree-rebuild mismatches.
    @discardableResult
    func scrollElement(index: Int, direction: String, amount: Double, target: AXTarget = .front, prune: Bool = true, menus: Bool = false, includeText: Bool = false) throws -> PointerService.PointerDiagnostics {
        // Try cache first
        let element: AXUIElement
        if let cached = lookupCachedElement(index: index) {
            element = cached.axElement
        } else {
            guard let found = try findElementByIndex(index: index, target: target, prune: prune, menus: menus, includeText: includeText) else {
                throw AXServiceError.elementNotFound("element #\(index)")
            }
            element = found
        }

        guard let scrollArea = findEnclosingScrollArea(element: element) else {
            throw AXServiceError.actionFailed("No scroll area found for element #\(index)")
        }

        guard let frame = getFrame(scrollArea) else {
            throw AXServiceError.actionFailed("Could not get frame of scroll area for element #\(index)")
        }

        let centerX = frame.x + frame.width / 2.0
        let centerY = frame.y + frame.height / 2.0

        let PIXELS_PER_SCREEN: Double = 800.0
        var deltaX: Double = 0
        var deltaY: Double = 0

        switch direction {
        case "up":    deltaY = -amount * PIXELS_PER_SCREEN
        case "down":  deltaY = amount * PIXELS_PER_SCREEN
        case "left":  deltaX = -amount * PIXELS_PER_SCREEN
        case "right": deltaX = amount * PIXELS_PER_SCREEN
        default:
            throw AXServiceError.actionFailed("Invalid scroll direction '\(direction)'. Use: up, down, left, right")
        }

        return try PointerService.shared.sendEvent(
            action: "scroll",
            x: centerX,
            y: centerY,
            button: nil,
            label: nil,
            endX: nil,
            endY: nil,
            deltaX: deltaX,
            deltaY: deltaY
        )
    }

    /// Click the element at the given pruned-tree index.
    /// Uses cached element data when available (populated by getInteractiveElementsFromTree)
    /// to avoid tree-rebuild mismatches between screenshot and click.
    func clickElementByIndex(index: Int, target: AXTarget = .front, prune: Bool = true, menus: Bool = false, includeText: Bool = false) throws {
        // Try cache first to avoid tree-rebuild mismatch
        if let cached = lookupCachedElement(index: index) {
            let center = CGPoint(
                x: cached.frame.x + cached.frame.width / 2,
                y: cached.frame.y + cached.frame.height / 2
            )

            // Use PointerService for the physical click (move + overlay + CGEvent)
            let _ = try? PointerService.shared.sendEvent(
                action: "click", x: center.x, y: center.y,
                button: nil, label: nil, endX: nil, endY: nil
            )
            usleep(50_000)

            // If CGEvent destroyed the element, we're done
            var roleCheck: CFTypeRef?
            let check = AXUIElementCopyAttributeValue(cached.axElement, kAXRoleAttribute as CFString, &roleCheck)
            if check == .invalidUIElement || check == .cannotComplete {
                return
            }

            // Reinforce with AXPress only if the element supports it
            var actionsRef: CFArray?
            if AXUIElementCopyActionNames(cached.axElement, &actionsRef) == .success,
               let actions = actionsRef as? [String],
               actions.contains("AXPress") {
                AXUIElementPerformAction(cached.axElement, kAXPressAction as CFString)
            }
            return
        }

        // Cache miss — fall back to tree-rebuild behavior
        guard let element = try findElementByIndex(index: index, target: target, prune: prune, menus: menus, includeText: includeText) else {
            throw AXServiceError.elementNotFound("element #\(index)")
        }

        // Use PointerService for the physical click
        if let frame = getFrame(element) {
            let center = CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
            let _ = try? PointerService.shared.sendEvent(
                action: "click", x: center.x, y: center.y,
                button: nil, label: nil, endX: nil, endY: nil
            )
            usleep(50_000)

            // If CGEvent destroyed the element, we're done
            var roleCheck: CFTypeRef?
            let check = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleCheck)
            if check == .invalidUIElement || check == .cannotComplete {
                return
            }

            // Reinforce with AXPress only if the element supports it
            var actionsRef: CFArray?
            if AXUIElementCopyActionNames(element, &actionsRef) == .success,
               let actions = actionsRef as? [String],
               actions.contains("AXPress") {
                AXUIElementPerformAction(element, kAXPressAction as CFString)
            }
            return
        }

        // No frame — fall back to AXPress only
        let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
        if result == .success { return }

        var roleCheck: CFTypeRef?
        let check = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleCheck)
        if check == .invalidUIElement || check == .cannotComplete {
            return
        }

        throw AXServiceError.actionFailed("Click on element #\(index) failed")
    }

    // MARK: - Text Extraction

    /// Read text content from the accessibility tree.
    /// If index is provided, reads from that element's subtree; otherwise reads from the window root.
    func readText(fromIndex index: Int? = nil, target: AXTarget = .front, prune: Bool = true, menus: Bool = false, includeText: Bool = false, depth: Int = 100) throws -> String {
        guard !target.isMulti else { throw AXServiceError.multiTargetNotAllowed }

        let targets = try resolveTarget(target)
        guard let (pid, _) = targets.first else { throw AXServiceError.noFocusedApp }

        let rootElement: AXUIElement
        if let idx = index {
            // Try cache first to avoid tree-rebuild mismatch
            if let cached = lookupCachedElement(index: idx) {
                rootElement = cached.axElement
            } else {
                guard let element = try findElementByIndex(index: idx, target: target, prune: prune, menus: menus, includeText: includeText) else {
                    throw AXServiceError.elementNotFound("element #\(idx)")
                }
                rootElement = element
            }
        } else {
            let appElement = AXUIElementCreateApplication(pid)
            var windowValue: CFTypeRef?
            var windowResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
            if windowResult != .success {
                windowResult = AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &windowValue)
            }
            rootElement = (windowResult == .success && windowValue != nil) ? (windowValue as! AXUIElement) : appElement
        }

        var texts: [String] = []
        collectText(element: rootElement, depth: 0, maxDepth: depth, texts: &texts)
        return texts.joined(separator: "\n")
    }

    /// Recursively collect text from AXStaticText values and AXHeading titles
    private func collectText(element: AXUIElement, depth: Int, maxDepth: Int, texts: inout [String]) {
        let role = getStringAttribute(element, kAXRoleAttribute)

        if role == "AXStaticText" {
            if let value = getValueString(element), !value.isEmpty {
                texts.append(value)
            } else if let title = getStringAttribute(element, kAXTitleAttribute), !title.isEmpty {
                texts.append(title)
            }
        } else if role == "AXHeading" {
            if let title = getStringAttribute(element, kAXTitleAttribute), !title.isEmpty {
                texts.append(title)
            } else if let value = getValueString(element), !value.isEmpty {
                texts.append(value)
            }
        }

        guard depth < maxDepth else { return }

        var childrenValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        if result == .success, let children = childrenValue as? [AXUIElement] {
            for child in children {
                collectText(element: child, depth: depth + 1, maxDepth: maxDepth, texts: &texts)
            }
        }
    }
}

import AppKit
import QuartzCore

/// Tree-focused accessibility overlay.
/// Captures the a11y tree ONCE on first mouse move, then re-renders instantly
/// from cache as the mouse moves. Stops on click/keyboard; next mouse move
/// triggers a fresh capture.
///
/// Rendering algorithm (tree-path based, no XY distance):
/// 1. Find the deepest node whose frame contains the mouse → "focus node"
/// 2. Build the path from root to focus node → "stem"
/// 3. Focus node: render with ALL descendants
/// 4. Siblings of focus node: render with ALL descendants
/// 5. Ancestors (stem nodes): render, but non-path children shown as collapsed (dashed + summary)
@MainActor
final class A11yTreeOverlay {
    static let shared = A11yTreeOverlay()
    private init() {}

    private(set) var isActive = false

    private enum State { case idle, capturing, showing }
    private var state: State = .idle

    private var containerLayer: CALayer?
    private var treeCache: [AccessibilityService.AXTreeResponse] = []
    private var isFloatingContext = false
    private var globalMoveMonitor: Any?
    private var localMoveMonitor: Any?
    private var globalInteractionMonitor: Any?
    private var localInteractionMonitor: Any?
    private var lastMouseLocation: CGPoint = .zero
    private var contextMenuTimer: DispatchWorkItem?

    // Floating XML panel
    private var xmlPanel: NSPanel?
    private var xmlTextView: NSTextView?

    // MARK: - Role classification

    private static let containerRoles: Set<String> = [
        "AXWindow", "AXGroup", "AXScrollArea", "AXSplitGroup",
        "AXTabGroup", "AXToolbar", "AXList", "AXOutline",
        "AXTable", "AXBrowser", "AXLayoutArea", "AXLayoutItem",
        "AXApplication", "AXMenuBar", "AXMenu",
    ]

    // MARK: - Public

    func toggle() {
        if isActive { stop() } else { start() }
    }

    func start() {
        guard !isActive else { return }
        isActive = true
        state = .idle

        setupXMLPanel()
        installMonitors()
    }

    func stop() {
        guard isActive else { return }
        isActive = false
        state = .idle

        contextMenuTimer?.cancel()
        contextMenuTimer = nil
        removeMonitors()
        clearOverlay()
        treeCache = []
        xmlPanel?.orderOut(nil)
        xmlPanel = nil
        xmlTextView = nil
    }

    // MARK: - XML Panel

    private func setupXMLPanel() {
        let panelWidth: CGFloat = 420
        let panelHeight: CGFloat = 500
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)

        let panelFrame = NSRect(
            x: screen.maxX - panelWidth - 12,
            y: screen.maxY - panelHeight - 12,
            width: panelWidth,
            height: panelHeight
        )

        let panel = NSPanel(
            contentRect: panelFrame,
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "A11y Tree"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = NSColor(white: 0.1, alpha: 0.92)

        let scrollView = NSScrollView(frame: panel.contentView!.bounds)
        scrollView.autoresizingMask = [.width, .height]
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .noBorder

        let textView = NSTextView(frame: scrollView.contentView.bounds)
        textView.autoresizingMask = [.width]
        textView.isEditable = false
        textView.isSelectable = true
        textView.backgroundColor = NSColor(white: 0.1, alpha: 1.0)
        textView.textColor = NSColor(white: 0.9, alpha: 1.0)
        textView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.textContainerInset = NSSize(width: 8, height: 8)

        scrollView.documentView = textView
        panel.contentView?.addSubview(scrollView)

        panel.orderFrontRegardless()
        xmlPanel = panel
        xmlTextView = textView
    }

    // MARK: - Event Monitors

    private func installMonitors() {
        globalMoveMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] _ in
            Task { @MainActor in self?.handleMouseMove() }
        }
        localMoveMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            Task { @MainActor in self?.handleMouseMove() }
            return event
        }
        globalInteractionMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .keyDown]
        ) { [weak self] event in
            Task { @MainActor in self?.handleInteraction(event: event) }
        }
        localInteractionMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .keyDown]
        ) { [weak self] event in
            Task { @MainActor in self?.handleInteraction(event: event) }
            return event
        }
    }

    private func removeMonitors() {
        if let m = globalMoveMonitor { NSEvent.removeMonitor(m) }
        globalMoveMonitor = nil
        if let m = localMoveMonitor { NSEvent.removeMonitor(m) }
        localMoveMonitor = nil
        if let m = globalInteractionMonitor { NSEvent.removeMonitor(m) }
        globalInteractionMonitor = nil
        if let m = localInteractionMonitor { NSEvent.removeMonitor(m) }
        localInteractionMonitor = nil
    }

    // MARK: - State Transitions

    private func handleMouseMove() {
        updateMouseLocation()
        switch state {
        case .idle:
            state = .capturing
            captureAndShow()
        case .capturing:
            break
        case .showing:
            render()
        }
    }

    private func handleInteraction() {
        handleInteraction(event: nil)
    }

    private func handleInteraction(event: NSEvent?) {
        contextMenuTimer?.cancel()
        contextMenuTimer = nil
        state = .idle
        clearOverlay()
        treeCache = []
        isFloatingContext = false

        // Clicks that open context menus use modal tracking that swallows mouse
        // events. Schedule a delayed capture to detect and display floating context.
        let isClick = (event?.type == .rightMouseDown || event?.type == .leftMouseDown)
        if isClick {
            let work = DispatchWorkItem { [weak self] in
                Task { @MainActor in
                    guard let self, self.isActive, self.state == .idle else { return }
                    self.updateMouseLocation()
                    self.state = .capturing
                    self.captureFloatingContext()
                }
            }
            contextMenuTimer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
        }
    }

    private func updateMouseLocation() {
        let screenLoc = NSEvent.mouseLocation
        let screenHeight = NSScreen.main?.frame.height ?? 1080
        lastMouseLocation = CGPoint(x: screenLoc.x, y: screenHeight - screenLoc.y)
    }

    // MARK: - Tree Capture

    private func captureAndShow() {
        DispatchQueue.global(qos: .userInitiated).async {
            let raw = (try? AccessibilityService.shared.getTree(maxDepth: .max, target: .visible)) ?? []

            // Check for floating context menus.
            let floatingContext = AccessibilityService.shared.getFloatingContext(maxDepth: .max)

            let result: [AccessibilityService.AXTreeResponse]
            let floating: Bool
            if let fc = floatingContext {
                floating = true
                result = [fc]
            } else {
                floating = false
                result = raw.map { response in
                    AccessibilityService.AXTreeResponse(
                        app: response.app,
                        bundleId: response.bundleId,
                        pid: response.pid,
                        window: response.window,
                        frame: response.frame,
                        tree: response.tree?.pruned(includeText: true),
                        menuBar: response.menuBar?.pruned(includeText: true)
                    )
                }
            }

            Task { @MainActor [weak self] in
                guard let self, self.isActive, self.state == .capturing else { return }
                self.isFloatingContext = floating
                self.treeCache = result
                self.state = .showing
                self.render()
            }
        }
    }

    /// Capture specifically for floating context (context menus).
    /// Since the menu's modal tracking loop swallows mouse events, we sample
    /// the mouse position and re-render on a timer until the menu disappears.
    private func captureFloatingContext() {
        DispatchQueue.global(qos: .userInitiated).async {
            let fc = AccessibilityService.shared.getFloatingContext(maxDepth: .max)
            Task { @MainActor [weak self] in
                guard let self, self.isActive, self.state == .capturing else { return }
                guard let fc = fc else {
                    // No floating context found — go back to idle
                    self.state = .idle
                    return
                }
                self.isFloatingContext = true
                self.treeCache = [fc]
                self.state = .showing
                self.render()
                // Start sampling mouse position since mouseMoved events are swallowed
                self.pollMouseDuringMenu()
            }
        }
    }

    /// Sample mouse position and re-render while a context menu is open.
    /// Stops when the menu disappears or overlay is deactivated.
    private func pollMouseDuringMenu() {
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, self.isActive, self.state == .showing else { return }
                self.updateMouseLocation()

                let stillOpen: AccessibilityService.AXTreeResponse? = DispatchQueue.global(qos: .userInitiated).sync {
                    AccessibilityService.shared.getFloatingContext(maxDepth: .max)
                }

                if let fc = stillOpen {
                    // Still open — update cache and re-render with current mouse position.
                    self.treeCache = [fc]
                    self.render()
                    self.pollMouseDuringMenu()
                } else {
                    // Closed — go back to idle
                    self.state = .idle
                    self.isFloatingContext = false
                    self.clearOverlay()
                    self.treeCache = []
                }
            }
        }
        contextMenuTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: work)
    }

    // MARK: - Focus Path

    /// Check if mouse is inside a node's frame.
    private func mouseInside(_ node: AccessibilityService.AXNode, mouse: CGPoint) -> Bool {
        guard let frame = node.frame, frame.width > 0, frame.height > 0 else { return false }
        return mouse.x >= frame.x && mouse.x <= frame.x + frame.width &&
               mouse.y >= frame.y && mouse.y <= frame.y + frame.height
    }

    /// Find the path from root to the deepest node containing the mouse point.
    /// Returns nil if mouse is not inside this node at all.
    /// Returns [] if this node IS the deepest (focus).
    /// Returns [childIndex, ...] for the path through children.
    /// When `skipRootFrame` is true, the root node's frame check is skipped
    /// (for floating context where the root may have a zero frame).
    private func findFocusPath(in node: AccessibilityService.AXNode, mouse: CGPoint, skipRootFrame: Bool = false) -> [Int]? {
        // Mouse must be inside this node's frame to even consider it
        if !skipRootFrame {
            guard mouseInside(node, mouse: mouse) else { return nil }
        }

        // Try to find a child that contains the mouse (go deeper)
        for (i, child) in (node.children ?? []).enumerated() {
            if let subPath = findFocusPath(in: child, mouse: mouse) {
                return [i] + subPath
            }
        }

        // If we skipped root frame check and no child matched, return nil
        // (mouse isn't in any child, so it's not really in this frameless root)
        if skipRootFrame { return nil }

        // Mouse is in this node but not in any child — this is the focus
        return []
    }

    // MARK: - Rendering

    /// What role does this node play in the current render?
    private enum RenderMode {
        case stem       // ancestor on the path — render self, non-path children collapsed
        case focus      // the hovered node — render self + all descendants + siblings get .full
        case full       // sibling of focus or descendant — render everything
        case collapsed  // non-path child of a stem — dashed outline + summary
        case hidden     // not rendered at all
    }

    private func render() {
        guard isActive, state == .showing, !treeCache.isEmpty else { return }
        guard let root = OverlayWindowManager.shared.ensureRootLayer() else { return }

        containerLayer?.removeFromSuperlayer()

        let container = CALayer()
        container.frame = root.bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        let scale = NSScreen.main?.backingScaleFactor ?? 2.0
        let mouse = lastMouseLocation

        for response in treeCache {
            if let tree = response.tree {
                // For floating context, skip the root frame check since roots like
                // Floating-menu roots can have 0x0 frames while children are valid.
                if let path = findFocusPath(in: tree, mouse: mouse, skipRootFrame: isFloatingContext) {
                    let mode: RenderMode = path.isEmpty ? .focus : .stem
                    renderNode(tree, into: container, scale: scale,
                               focusPath: path, pathIndex: 0, mode: mode)
                } else {
                    // Mouse is NOT in this tree.
                    // Floating context should still render fully.
                    let fallback: RenderMode = isFloatingContext ? .full : .collapsed
                    renderNode(tree, into: container, scale: scale,
                               focusPath: [], pathIndex: 0, mode: fallback)
                }
            }
            if let menuBar = response.menuBar {
                if let path = findFocusPath(in: menuBar, mouse: mouse) {
                    let mode: RenderMode = path.isEmpty ? .focus : .stem
                    renderNode(menuBar, into: container, scale: scale,
                               focusPath: path, pathIndex: 0, mode: mode)
                } else {
                    renderNode(menuBar, into: container, scale: scale,
                               focusPath: [], pathIndex: 0, mode: .collapsed)
                }
            }
        }

        root.addSublayer(container)
        containerLayer = container
        CATransaction.commit()

        // Generate tree document for the text panel
        xmlTextView?.string = buildTree()
    }

    private func clearOverlay() {
        containerLayer?.removeFromSuperlayer()
        containerLayer = nil
        xmlTextView?.string = ""
    }

    // MARK: - A11y Tree Document

    /// Build canonical A11y Tree document from the cached tree responses.
    private func buildTree() -> String {
        guard !treeCache.isEmpty else { return "" }

        // Extract menu bar from first response that has one
        let systemMenuBar = treeCache.first(where: { $0.menuBar != nil })?.menuBar

        // Determine focused app
        let focusBundleId = treeCache.first?.bundleId ?? ""
        let focusPid = treeCache.first?.pid ?? 0

        var xml = "<System focusBundleId=\"\(focusBundleId.xmlEscaped)\" focusPid=\(focusPid)>\n"

        // Menu channel
        xml += "  <Menu detected=\"\(systemMenuBar != nil)\">\n"
        if let menuBar = systemMenuBar {
            let inner = menuBar.toXMLDocument(
                includeVisibility: true,
                includeSubrole: true
            )
            for line in inner.split(separator: "\n", omittingEmptySubsequences: false) {
                xml += "    \(line)\n"
            }
        }
        xml += "  </Menu>\n"

        // Focused channel
        xml += "  <Focused count=\(treeCache.count)>\n"
        for response in treeCache {
            xml += renderTreeEnvelope(response, tag: "Application", indent: "    ")
        }
        xml += "  </Focused>\n"

        xml += "</System>\n"
        return xml
    }

    /// Render a tree response wrapped in an envelope tag.
    private func renderTreeEnvelope(
        _ tree: AccessibilityService.AXTreeResponse,
        tag: String,
        indent: String
    ) -> String {
        var attrs = ""
        attrs += " app=\"\(tree.app.xmlEscaped)\""
        attrs += " bundleId=\"\(tree.bundleId.xmlEscaped)\""
        attrs += " pid=\(tree.pid)"
        if let window = tree.window {
            attrs += " window=\"\(window.xmlEscaped)\""
        }

        var xml = "\(indent)<\(tag)\(attrs)>\n"
        if let root = tree.tree {
            let inner = root.toXMLDocument(
                includeVisibility: true,
                includeSubrole: true
            )
            for line in inner.split(separator: "\n", omittingEmptySubsequences: false) {
                xml += "\(indent)  \(line)\n"
            }
        }
        xml += "\(indent)</\(tag)>\n"
        return xml
    }

    // MARK: - Node Rendering

    private func renderNode(
        _ node: AccessibilityService.AXNode,
        into container: CALayer,
        scale: CGFloat,
        focusPath: [Int],
        pathIndex: Int,
        mode: RenderMode
    ) {
        guard mode != .hidden else { return }

        let hasFrame = node.frame != nil && node.frame!.width > 0 && node.frame!.height > 0

        // Draw this node
        if hasFrame {
            let isStem = (mode == .stem)
            let isCollapsed = (mode == .collapsed)
            let role = node.role ?? ""

            let strokeColor: CGColor
            if AccessibilityService.interactiveRoles.contains(role) {
                strokeColor = CGColor(red: 0.2, green: 0.5, blue: 1.0, alpha: 1.0)
            } else if Self.containerRoles.contains(role) {
                strokeColor = CGColor(red: 0.2, green: 0.8, blue: 0.3, alpha: 1.0)
            } else {
                strokeColor = CGColor(red: 0.6, green: 0.6, blue: 0.6, alpha: 1.0)
            }

            let frame = node.frame!
            let absRect = CGRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
            let viewRect = OverlayWindowManager.shared.screenRectToView(absRect)

            let opacity: Float = (isStem || isCollapsed) ? 0.35 : 1.0
            let lineWidth: CGFloat = (isStem || isCollapsed) ? 0.75 : 1.5

            let box = CAShapeLayer()
            box.path = CGPath(rect: viewRect, transform: nil)
            box.strokeColor = strokeColor
            box.fillColor = CGColor(red: 0, green: 0, blue: 0, alpha: 0)
            box.lineWidth = lineWidth
            box.opacity = opacity
            if isCollapsed {
                box.lineDashPattern = [6, 4]
            }
            container.addSublayer(box)

            // Labels on focus node and full-render nodes
            if mode == .focus || mode == .full {
                drawLabel(node: node, role: role, viewRect: viewRect, opacity: opacity, scale: scale, into: container)
            }
        }

        // Child recursion for overlay boxes
        switch mode {
        case .hidden:
            return

        case .collapsed:
            // No child recursion for collapsed nodes
            break

        case .stem:
            let pathChildIndex = (pathIndex < focusPath.count) ? focusPath[pathIndex] : -1
            for (i, child) in (node.children ?? []).enumerated() {
                if i == pathChildIndex {
                    let nextIsLast = (pathIndex + 1 >= focusPath.count)
                    let childMode: RenderMode = nextIsLast ? .focus : .stem
                    renderNode(child, into: container, scale: scale,
                               focusPath: focusPath, pathIndex: pathIndex + 1, mode: childMode)
                } else {
                    renderNode(child, into: container, scale: scale,
                               focusPath: focusPath, pathIndex: pathIndex, mode: .collapsed)
                }
            }

        case .focus, .full:
            for child in node.children ?? [] {
                renderNode(child, into: container, scale: scale,
                           focusPath: focusPath, pathIndex: pathIndex, mode: .full)
            }
        }
    }

    // MARK: - Helpers

    private func drawLabel(
        node: AccessibilityService.AXNode,
        role: String,
        viewRect: CGRect,
        opacity: Float,
        scale: CGFloat,
        into container: CALayer
    ) {
        let title = node.title ?? node.label
        let tag = node.displayTag
        let labelText: String
        if let title = title, !title.isEmpty {
            labelText = "\(tag): \(title)"
        } else {
            labelText = tag
        }
        guard !labelText.isEmpty else { return }

        let fontSize: CGFloat = 9
        let font = CTFontCreateWithName("Helvetica" as CFString, fontSize, nil)

        let textLayer = CATextLayer()
        textLayer.string = labelText
        textLayer.fontSize = fontSize
        textLayer.font = font
        textLayer.foregroundColor = CGColor(red: 1, green: 1, blue: 1, alpha: 0.9)
        textLayer.contentsScale = scale
        textLayer.alignmentMode = .left

        let textWidth = min(CGFloat(labelText.count) * fontSize * 0.55, viewRect.width)
        let textHeight: CGFloat = fontSize + 4
        let padding: CGFloat = 3

        let pillWidth = textWidth + padding * 2
        let pillHeight = textHeight + padding
        let pillX = viewRect.minX
        let pillY = viewRect.maxY - pillHeight

        let pill = CALayer()
        pill.frame = CGRect(x: pillX, y: pillY, width: pillWidth, height: pillHeight)
        pill.backgroundColor = CGColor(red: 0, green: 0, blue: 0, alpha: 0.7)
        pill.cornerRadius = 3
        pill.opacity = opacity
        container.addSublayer(pill)

        textLayer.frame = CGRect(x: pillX + padding, y: pillY + 1, width: textWidth, height: textHeight)
        textLayer.opacity = opacity
        container.addSublayer(textLayer)
    }
}

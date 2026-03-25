import AppKit
import QuartzCore

/// Shared full-screen transparent NSWindow for all overlay renderers.
/// Each renderer adds/removes its own CALayer sublayers on the shared root layer.
final class OverlayWindowManager {
    static let shared = OverlayWindowManager()
    private init() {}

    private var overlayWindow: NSWindow?

    private struct DesktopSpace {
        let desktopFrame: CGRect
        let primaryFrame: CGRect
    }

    /// Ensure the overlay window exists and return the root CALayer to draw into.
    func ensureRootLayer() -> CALayer? {
        let window = ensureOverlayWindow()
        return window.contentView?.layer
    }

    /// Convert actor-space coordinates (top-left origin at the primary display)
    /// to CALayer/NSView coordinates across the union desktop frame.
    func screenToView(_ point: CGPoint) -> CGPoint {
        let space = currentDesktopSpace()
        let global = screenToGlobal(point, space: space)
        return CGPoint(
            x: global.x - space.desktopFrame.minX,
            y: global.y - space.desktopFrame.minY
        )
    }

    /// Convert a screen-coordinate point (top-left origin) to view-coordinate point (bottom-left origin).
    func screenPointToView(_ point: CGPoint) -> CGPoint {
        return screenToView(point)
    }

    /// Convert a view-coordinate point (bottom-left origin) back to screen coordinates (top-left origin).
    func viewToScreen(_ point: CGPoint) -> CGPoint {
        let space = currentDesktopSpace()
        let global = CGPoint(
            x: point.x + space.desktopFrame.minX,
            y: point.y + space.desktopFrame.minY
        )
        return CGPoint(
            x: global.x - space.primaryFrame.minX,
            y: space.primaryFrame.maxY - global.y
        )
    }

    /// Convert a screen-coordinate rect (top-left origin) to view-coordinate rect (bottom-left origin).
    func screenRectToView(_ rect: CGRect) -> CGRect {
        let space = currentDesktopSpace()
        let globalMaxY = space.primaryFrame.maxY - rect.origin.y
        let globalRect = CGRect(
            x: space.primaryFrame.minX + rect.origin.x,
            y: globalMaxY - rect.height,
            width: rect.width,
            height: rect.height
        )
        return CGRect(
            x: globalRect.origin.x - space.desktopFrame.minX,
            y: globalRect.origin.y - space.desktopFrame.minY,
            width: globalRect.width,
            height: globalRect.height
        )
    }

    // MARK: - Window

    private func ensureOverlayWindow() -> NSWindow {
        let space = currentDesktopSpace()
        if let window = overlayWindow {
            window.setFrame(space.desktopFrame, display: false)
            window.contentView?.frame = CGRect(origin: .zero, size: space.desktopFrame.size)
            window.orderFrontRegardless()
            return window
        }

        let window = NSWindow(
            contentRect: space.desktopFrame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.level = .screenSaver
        window.isOpaque = false
        window.backgroundColor = .clear
        window.ignoresMouseEvents = true
        window.hasShadow = false
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]

        let view = NSView(frame: CGRect(origin: .zero, size: space.desktopFrame.size))
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
        window.contentView = view

        window.orderFrontRegardless()
        overlayWindow = window
        return window
    }

    private func currentDesktopSpace() -> DesktopSpace {
        let screens = NSScreen.screens
        let primaryFrame = NSScreen.main?.frame ?? screens.first?.frame ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)
        let desktopFrame = screens.reduce(primaryFrame) { partial, screen in
            partial.union(screen.frame)
        }
        return DesktopSpace(desktopFrame: desktopFrame, primaryFrame: primaryFrame)
    }

    private func screenToGlobal(_ point: CGPoint, space: DesktopSpace) -> CGPoint {
        CGPoint(
            x: space.primaryFrame.minX + point.x,
            y: space.primaryFrame.maxY - point.y
        )
    }
}

/// Removes the CALayer from its parent when the animation finishes.
/// Used by multiple overlay renderers for one-shot animations.
final class RemoveLayerDelegate: NSObject, CAAnimationDelegate {
    private weak var layer: CALayer?

    init(layer: CALayer) {
        self.layer = layer
        super.init()
    }

    func animationDidStop(_ anim: CAAnimation, finished flag: Bool) {
        layer?.removeFromSuperlayer()
    }
}

import AppKit
import QuartzCore

/// Cyberpunk-style scan animation that sweeps across matched UI elements with a red scan line.
final class ScanOverlayService {
    static let shared = ScanOverlayService()
    private init() {}

    private enum ScanDirection {
        case topToBottom
        case bottomToTop
        case leftToRight
        case rightToLeft

        init(_ rawValue: String) {
            switch rawValue {
            case "bottom-to-top":
                self = .bottomToTop
            case "left-to-right":
                self = .leftToRight
            case "right-to-left":
                self = .rightToLeft
            default:
                self = .topToBottom
            }
        }
    }

    /// Play a scan animation over the given rects.
    /// Coordinates are screen-absolute (top-left origin).
    /// `durationMs` controls how long the scan line takes to sweep.
    func playScan(
        rects: [CGRect],
        outlineRects: [CGRect] = [],
        durationMs: Int = 500,
        direction rawDirection: String = "top-to-bottom"
    ) {
        DispatchQueue.main.async {
            guard let root = OverlayWindowManager.shared.ensureRootLayer() else { return }
            guard !rects.isEmpty else { return }
            let direction = ScanDirection(rawDirection)

            let container = CALayer()
            container.frame = root.bounds

            // Convert all rects to view coordinates
            let viewRects = rects.map { OverlayWindowManager.shared.screenRectToView($0) }

            // Compute bounding box of all scan targets (in view coords, bottom-left origin)
            let allViewRects = viewRects
            let minX = allViewRects.map { $0.minX }.min()!
            let maxX = allViewRects.map { $0.maxX }.max()!
            let minY = allViewRects.map { $0.minY }.min()!
            let maxY = allViewRects.map { $0.maxY }.max()!

            let sweepDuration = CFTimeInterval(durationMs) / 1000.0
            let totalHeight = maxY - minY
            let totalWidth = maxX - minX

            let red = CGColor(red: 1.0, green: 0.15, blue: 0.1, alpha: 1.0)

            let scanLine = CALayer()
            scanLine.backgroundColor = red
            scanLine.shadowColor = red
            scanLine.shadowRadius = 8
            scanLine.shadowOpacity = 1.0
            scanLine.shadowOffset = .zero
            container.addSublayer(scanLine)

            let sweepAnim: CABasicAnimation
            switch direction {
            case .leftToRight:
                scanLine.bounds = CGRect(x: 0, y: 0, width: 2, height: totalHeight)
                scanLine.position = CGPoint(x: minX, y: (minY + maxY) / 2)
                sweepAnim = CABasicAnimation(keyPath: "position.x")
                sweepAnim.fromValue = minX
                sweepAnim.toValue = maxX
            case .rightToLeft:
                scanLine.bounds = CGRect(x: 0, y: 0, width: 2, height: totalHeight)
                scanLine.position = CGPoint(x: maxX, y: (minY + maxY) / 2)
                sweepAnim = CABasicAnimation(keyPath: "position.x")
                sweepAnim.fromValue = maxX
                sweepAnim.toValue = minX
            case .topToBottom:
                scanLine.bounds = CGRect(x: 0, y: 0, width: totalWidth, height: 2)
                scanLine.position = CGPoint(x: (minX + maxX) / 2, y: maxY)
                sweepAnim = CABasicAnimation(keyPath: "position.y")
                sweepAnim.fromValue = maxY
                sweepAnim.toValue = minY
            case .bottomToTop:
                scanLine.bounds = CGRect(x: 0, y: 0, width: totalWidth, height: 2)
                scanLine.position = CGPoint(x: (minX + maxX) / 2, y: minY)
                sweepAnim = CABasicAnimation(keyPath: "position.y")
                sweepAnim.fromValue = minY
                sweepAnim.toValue = maxY
            }
            sweepAnim.duration = sweepDuration
            sweepAnim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            sweepAnim.isRemovedOnCompletion = false
            sweepAnim.fillMode = .forwards
            scanLine.add(sweepAnim, forKey: "sweep")

            // Fade out scan line after sweep
            let scanFade = CABasicAnimation(keyPath: "opacity")
            scanFade.fromValue = 1.0
            scanFade.toValue = 0.0
            scanFade.beginTime = CACurrentMediaTime() + sweepDuration
            scanFade.duration = 0.3
            scanFade.isRemovedOnCompletion = false
            scanFade.fillMode = .forwards
            scanLine.add(scanFade, forKey: "scanFade")

            // Add container to root
            root.addSublayer(container)

            // --- Fade out everything after sweep + hold ---
            let now = CACurrentMediaTime()
            let holdDuration = 0.2
            let fadeOutDelay = sweepDuration + holdDuration
            let fadeOutDuration: CFTimeInterval = 1.0

            let containerFade = CABasicAnimation(keyPath: "opacity")
            containerFade.fromValue = 1.0
            containerFade.toValue = 0.0
            containerFade.beginTime = now + fadeOutDelay
            containerFade.duration = fadeOutDuration
            containerFade.isRemovedOnCompletion = false
            containerFade.fillMode = .forwards
            containerFade.delegate = RemoveLayerDelegate(layer: container)
            container.add(containerFade, forKey: "fadeOut")
        }
    }
}

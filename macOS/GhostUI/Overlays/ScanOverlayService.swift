import AppKit
import QuartzCore

/// Cyberpunk-style scan animation that sweeps across matched UI elements with glowing cyan outlines.
final class ScanOverlayService {
    static let shared = ScanOverlayService()
    private init() {}

    private enum ScanDirection {
        case topToBottom
        case leftToRight

        init(_ rawValue: String) {
            switch rawValue {
            case "left-to-right":
                self = .leftToRight
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
            guard !rects.isEmpty || !outlineRects.isEmpty else { return }
            let direction = ScanDirection(rawDirection)

            let container = CALayer()
            container.frame = root.bounds

            // Convert all rects to view coordinates
            let viewRects = rects.map { OverlayWindowManager.shared.screenRectToView($0) }
            let viewOutlineRects = outlineRects.map { OverlayWindowManager.shared.screenRectToView($0) }

            // Compute bounding box of all rects (in view coords, bottom-left origin)
            let allViewRects = viewRects + viewOutlineRects
            let minX = allViewRects.map { $0.minX }.min()!
            let maxX = allViewRects.map { $0.maxX }.max()!
            let minY = allViewRects.map { $0.minY }.min()!
            let maxY = allViewRects.map { $0.maxY }.max()!

            let sweepDuration = CFTimeInterval(durationMs) / 1000.0
            let totalHeight = maxY - minY
            let totalWidth = maxX - minX

            let cyan = CGColor(red: 0, green: 0.9, blue: 1.0, alpha: 1.0)
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
            case .topToBottom:
                scanLine.bounds = CGRect(x: 0, y: 0, width: totalWidth, height: 2)
                scanLine.position = CGPoint(x: (minX + maxX) / 2, y: maxY)
                sweepAnim = CABasicAnimation(keyPath: "position.y")
                sweepAnim.fromValue = maxY
                sweepAnim.toValue = minY
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

            // --- Per-rect outline layers ---
            let now = CACurrentMediaTime()
            var outlineLayers: [CAShapeLayer] = []

            for viewRect in viewRects {
                let outline = CAShapeLayer()
                outline.path = CGPath(roundedRect: viewRect, cornerWidth: 3, cornerHeight: 3, transform: nil)
                outline.strokeColor = cyan
                outline.fillColor = CGColor(red: 0, green: 0.9, blue: 1.0, alpha: 0.05)
                outline.lineWidth = 2
                outline.shadowColor = cyan
                outline.shadowRadius = 6
                outline.shadowOpacity = 0.8
                outline.shadowOffset = .zero
                outline.opacity = 0

                container.addSublayer(outline)
                outlineLayers.append(outline)

                let progress: CGFloat
                switch direction {
                case .leftToRight:
                    if totalWidth > 0 {
                        progress = (viewRect.minX - minX) / totalWidth
                    } else {
                        progress = 0
                    }
                case .topToBottom:
                    if totalHeight > 0 {
                        progress = (maxY - viewRect.maxY) / totalHeight
                    } else {
                        progress = 0
                    }
                }
                let revealTime = now + CFTimeInterval(progress) * sweepDuration

                // Pop-in animation
                let reveal = CABasicAnimation(keyPath: "opacity")
                reveal.fromValue = 0.0
                reveal.toValue = 1.0
                reveal.beginTime = revealTime
                reveal.duration = 0.15
                reveal.isRemovedOnCompletion = false
                reveal.fillMode = .forwards
                outline.add(reveal, forKey: "reveal")

                // Subtle scale pop
                let pop = CAKeyframeAnimation(keyPath: "transform")
                pop.values = [
                    NSValue(caTransform3D: CATransform3DMakeScale(0.95, 0.95, 1.0)),
                    NSValue(caTransform3D: CATransform3DMakeScale(1.02, 1.02, 1.0)),
                    NSValue(caTransform3D: CATransform3DIdentity)
                ]
                pop.keyTimes = [0, 0.6, 1.0]
                pop.beginTime = revealTime
                pop.duration = 0.2
                pop.isRemovedOnCompletion = false
                pop.fillMode = .forwards
                outline.add(pop, forKey: "pop")
            }

            // --- Outline-only layers (Window rects) — no fill, no animation, visible from start ---
            for viewRect in viewOutlineRects {
                let outline = CAShapeLayer()
                outline.path = CGPath(roundedRect: viewRect, cornerWidth: 3, cornerHeight: 3, transform: nil)
                outline.strokeColor = cyan
                outline.fillColor = CGColor.clear
                outline.lineWidth = 1
                outline.opacity = 1
                container.addSublayer(outline)
            }

            // Add container to root
            root.addSublayer(container)

            // --- Fade out everything after sweep + hold ---
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

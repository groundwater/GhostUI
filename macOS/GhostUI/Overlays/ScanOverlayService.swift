import AppKit
import QuartzCore

/// Cyberpunk-style scan animation that sweeps across matched UI elements with glowing cyan outlines.
final class ScanOverlayService {
    static let shared = ScanOverlayService()
    private init() {}

    /// Play a scan animation over the given rects.
    /// Coordinates are screen-absolute (top-left origin).
    /// `durationMs` controls how long the scan line takes to sweep.
    func playScan(rects: [CGRect], outlineRects: [CGRect] = [], durationMs: Int = 500) {
        DispatchQueue.main.async {
            guard let root = OverlayWindowManager.shared.ensureRootLayer() else { return }
            guard !rects.isEmpty || !outlineRects.isEmpty else { return }

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

            let scanWidth = maxX - minX
            let scanMidX = (minX + maxX) / 2
            let sweepDuration = CFTimeInterval(durationMs) / 1000.0
            let totalHeight = maxY - minY

            let cyan = CGColor(red: 0, green: 0.9, blue: 1.0, alpha: 1.0)
            let red = CGColor(red: 1.0, green: 0.15, blue: 0.1, alpha: 1.0)

            // --- Scan line: thin horizontal bar, bounded to rect extents ---
            let scanLine = CALayer()
            scanLine.bounds = CGRect(x: 0, y: 0, width: scanWidth, height: 2)
            scanLine.backgroundColor = red
            scanLine.shadowColor = red
            scanLine.shadowRadius = 8
            scanLine.shadowOpacity = 1.0
            scanLine.shadowOffset = .zero
            // Start at top of bounding box (maxY in view coords since y is flipped)
            scanLine.position = CGPoint(x: scanMidX, y: maxY)
            container.addSublayer(scanLine)

            // Animate scan line from top to bottom of bounding box
            // In view coords (bottom-left origin): top = maxY, bottom = minY
            let sweepAnim = CABasicAnimation(keyPath: "position.y")
            sweepAnim.fromValue = maxY
            sweepAnim.toValue = minY
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

                // Reveal when scan line is partway through the rect
                // In view coords: rect mid = rect.midY, scan goes maxY -> minY
                let rectTop = viewRect.midY
                let progress: CGFloat
                if totalHeight > 0 {
                    progress = (maxY - rectTop) / totalHeight
                } else {
                    progress = 0
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

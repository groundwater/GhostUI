import AppKit
import QuartzCore

/// Camera-flash style animation for element screenshots.
/// Pops a bright white rect that fades out quickly over the captured element.
final class FlashOverlayService {
    static let shared = FlashOverlayService()
    private init() {}

    /// Play a camera-flash animation over the given rect.
    /// Coordinates are screen-absolute (top-left origin).
    func playFlash(rect: CGRect) {
        DispatchQueue.main.async {
            guard let root = OverlayWindowManager.shared.ensureRootLayer() else { return }

            let viewRect = OverlayWindowManager.shared.screenRectToView(rect)

            let flash = CALayer()
            flash.frame = viewRect
            flash.cornerRadius = 4
            flash.backgroundColor = CGColor(red: 1, green: 1, blue: 1, alpha: 0.8)

            root.addSublayer(flash)

            // --- Blue scanline border ---
            let border = CAShapeLayer()
            let borderPath = CGPath(roundedRect: viewRect, cornerWidth: 4, cornerHeight: 4, transform: nil)
            border.path = borderPath
            border.strokeColor = CGColor(red: 0.2, green: 0.5, blue: 1.0, alpha: 1.0)
            border.lineWidth = 2
            border.fillColor = CGColor(red: 0, green: 0, blue: 0, alpha: 0)
            border.shadowColor = CGColor(red: 0.2, green: 0.5, blue: 1.0, alpha: 1.0)
            border.shadowRadius = 6
            border.shadowOpacity = 0.8
            border.shadowOffset = .zero

            root.addSublayer(border)

            // Stroke draws around the perimeter
            let stroke = CABasicAnimation(keyPath: "strokeEnd")
            stroke.fromValue = 0
            stroke.toValue = 1
            stroke.duration = 0.4
            stroke.timingFunction = CAMediaTimingFunction(name: .easeOut)

            // Fade out the border after it's mostly drawn
            let borderFade = CABasicAnimation(keyPath: "opacity")
            borderFade.fromValue = 1.0
            borderFade.toValue = 0.0
            borderFade.duration = 0.3
            borderFade.beginTime = 0.3
            borderFade.timingFunction = CAMediaTimingFunction(name: .easeOut)

            let borderGroup = CAAnimationGroup()
            borderGroup.animations = [stroke, borderFade]
            borderGroup.duration = 0.6
            borderGroup.isRemovedOnCompletion = false
            borderGroup.fillMode = .forwards
            borderGroup.delegate = RemoveLayerDelegate(layer: border)

            border.add(borderGroup, forKey: "scanline")

            // Scale pop: 1.0 → 1.03 → 1.0
            let pop = CAKeyframeAnimation(keyPath: "transform")
            pop.values = [
                NSValue(caTransform3D: CATransform3DIdentity),
                NSValue(caTransform3D: CATransform3DMakeScale(1.03, 1.03, 1.0)),
                NSValue(caTransform3D: CATransform3DIdentity)
            ]
            pop.keyTimes = [0, 0.3, 1.0]
            pop.duration = 0.3
            pop.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)

            // Fade out
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.8
            fade.toValue = 0.0
            fade.duration = 0.3
            fade.timingFunction = CAMediaTimingFunction(name: .easeOut)

            let group = CAAnimationGroup()
            group.animations = [pop, fade]
            group.duration = 0.3
            group.isRemovedOnCompletion = false
            group.fillMode = .forwards
            group.delegate = RemoveLayerDelegate(layer: flash)

            flash.add(group, forKey: "flash")
        }
    }
}

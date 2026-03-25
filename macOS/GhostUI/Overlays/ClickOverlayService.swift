import AppKit
import QuartzCore

/// Persistent glowing cursor overlay for visualizing automated pointer events.
/// The cursor stays visible, moves to each new click position, pulses on click,
/// then drifts to a random nearby offset. Auto-hides after 10s idle with pop animation.
final class ClickOverlayService {
    static let shared = ClickOverlayService()
    private init() {}

    private var cursorLayer: CALayer?       // persistent glowing dot
    private var glowLayer: CALayer?         // outer glow behind cursor
    private var centerDot: CALayer?         // white center dot inside cursor
    private let cursorSize: CGFloat = 16
    private let glowSize: CGFloat = 32

    private var idleWorkItem: DispatchWorkItem?
    private var isHidden: Bool = false
    private let idleTimeout: TimeInterval = 10.0

    /// Animate the cursor to the given point, pulse, then drift away.
    /// Coordinates are absolute screen (top-left origin).
    func animateClick(at point: CGPoint) {
        DispatchQueue.main.async { [self] in
            guard let root = OverlayWindowManager.shared.ensureRootLayer() else { return }
            let viewPoint = OverlayWindowManager.shared.screenToView(point)

            resetIdleTimer()

            if cursorLayer != nil {
                if isHidden {
                    // Pop back in, then continue with the click sequence
                    popIn { [self] in
                        self.runClickSequence(in: root, at: viewPoint)
                    }
                } else {
                    runClickSequence(in: root, at: viewPoint)
                }
            } else {
                // First click — create the cursor at this position with pop-in
                createCursorLayers(in: root, at: viewPoint)
                // Small delay after pop-in before pulsing
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [self] in
                    self.animatePulse(in: root, at: viewPoint)
                    // Drift away after pulse
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [self] in
                        let offset = self.randomOffset(from: viewPoint)
                        self.animateMove(from: viewPoint, to: offset)
                    }
                }
            }
        }
    }

    // MARK: - Click Sequence

    private func runClickSequence(in root: CALayer, at viewPoint: CGPoint) {
        guard let cursor = cursorLayer else { return }
        // Ensure center dot is visible (popOut animations can leave it hidden)
        if let dot = centerDot {
            dot.removeAllAnimations()
            dot.opacity = 1.0
            dot.transform = CATransform3DIdentity
        }
        let from = cursor.position

        // 1. Move cursor to target
        animateMove(from: from, to: viewPoint)

        // 2. Pause to "land", then pulse
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [self] in
            self.animatePulse(in: root, at: viewPoint)

            // 3. Pause after pulse, then drift away
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [self] in
                let offset = self.randomOffset(from: viewPoint)
                self.animateMove(from: viewPoint, to: offset)
            }
        }
    }

    // MARK: - Persistent Cursor

    private func createCursorLayers(in root: CALayer, at point: CGPoint) {
        // Outer glow
        let glow = CALayer()
        glow.bounds = CGRect(x: 0, y: 0, width: glowSize, height: glowSize)
        glow.cornerRadius = glowSize / 2
        glow.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.2).cgColor
        glow.position = point
        glow.shadowColor = NSColor.systemBlue.cgColor
        glow.shadowRadius = 8
        glow.shadowOpacity = 0.6
        glow.shadowOffset = .zero
        root.addSublayer(glow)
        glowLayer = glow

        // Inner cursor dot
        let cursor = CALayer()
        cursor.bounds = CGRect(x: 0, y: 0, width: cursorSize, height: cursorSize)
        cursor.cornerRadius = cursorSize / 2
        cursor.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.85).cgColor
        cursor.borderWidth = 3
        cursor.borderColor = NSColor.white.cgColor
        cursor.position = point
        cursor.shadowColor = NSColor.systemBlue.cgColor
        cursor.shadowRadius = 4
        cursor.shadowOpacity = 0.8
        cursor.shadowOffset = .zero

        // Inner center dot for reticle feel
        let center = CALayer()
        center.bounds = CGRect(x: 0, y: 0, width: 8, height: 8)
        center.cornerRadius = 4
        center.backgroundColor = NSColor.white.withAlphaComponent(0.5).cgColor
        center.position = CGPoint(x: cursorSize / 2, y: cursorSize / 2)
        cursor.addSublayer(center)
        centerDot = center

        root.addSublayer(cursor)
        cursorLayer = cursor

        // Gentle breathing animation on the glow
        addBreathingAnimation(to: glow)

        // Pop-in animation
        applyPopIn(to: cursor)
        applyPopIn(to: glow)

        isHidden = false
    }

    private func addBreathingAnimation(to layer: CALayer) {
        let breathe = CABasicAnimation(keyPath: "transform")
        breathe.fromValue = NSValue(caTransform3D: CATransform3DIdentity)
        breathe.toValue = NSValue(caTransform3D: CATransform3DMakeScale(1.3, 1.3, 1.0))
        breathe.duration = 1.2
        breathe.autoreverses = true
        breathe.repeatCount = .infinity
        breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(breathe, forKey: "breathe")
    }

    // MARK: - Move Animation

    private func animateMove(from: CGPoint, to: CGPoint) {
        guard let cursor = cursorLayer, let glow = glowLayer else { return }

        cursor.removeAnimation(forKey: "fadeOut")
        cursor.removeAnimation(forKey: "popOut")
        glow.removeAnimation(forKey: "fadeOut")
        glow.removeAnimation(forKey: "popOut")
        cursor.opacity = 1.0
        glow.opacity = 1.0

        let duration: CFTimeInterval = 0.2

        let moveC = CABasicAnimation(keyPath: "position")
        moveC.fromValue = NSValue(point: NSPoint(x: from.x, y: from.y))
        moveC.toValue = NSValue(point: NSPoint(x: to.x, y: to.y))
        moveC.duration = duration
        moveC.timingFunction = CAMediaTimingFunction(name: .easeIn)
        cursor.position = to
        cursor.add(moveC, forKey: "move")

        let moveG = CABasicAnimation(keyPath: "position")
        moveG.fromValue = NSValue(point: NSPoint(x: from.x, y: from.y))
        moveG.toValue = NSValue(point: NSPoint(x: to.x, y: to.y))
        moveG.duration = duration
        moveG.timingFunction = CAMediaTimingFunction(name: .easeIn)
        glow.position = to
        glow.add(moveG, forKey: "move")
    }

    // MARK: - Pulse Animation

    private func animatePulse(in root: CALayer, at point: CGPoint) {
        // Primary pulse ring
        addPulseRing(in: root, at: point, toScale: 6.0, opacity: 0.8, duration: 0.5, borderWidth: 2.5)

        // Secondary pulse ring — fires 100ms later, smaller scale
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            self.addPulseRing(in: root, at: point, toScale: 3.0, opacity: 0.8, duration: 0.5, borderWidth: 2.5)
        }

        // Inner cursor dot pop
        if let cursor = cursorLayer {
            let pop = CAKeyframeAnimation(keyPath: "transform.scale")
            pop.values = [1.0, 1.4, 1.0]
            pop.keyTimes = [0, 0.4, 1.0]
            pop.duration = 0.5
            pop.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            cursor.add(pop, forKey: "clickPop")
        }
    }

    private func addPulseRing(in root: CALayer, at point: CGPoint, toScale: CGFloat, opacity: Float, duration: CFTimeInterval, borderWidth: CGFloat) {
        let pulse = CALayer()
        pulse.bounds = CGRect(x: 0, y: 0, width: cursorSize, height: cursorSize)
        pulse.cornerRadius = cursorSize / 2
        pulse.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.3).cgColor
        pulse.borderWidth = borderWidth
        pulse.borderColor = NSColor.systemBlue.withAlphaComponent(0.5).cgColor
        pulse.position = point
        root.addSublayer(pulse)

        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 1.0
        scale.toValue = toScale
        scale.duration = duration
        scale.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = opacity
        fade.toValue = 0.0
        fade.duration = duration
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = duration
        group.isRemovedOnCompletion = false
        group.fillMode = .forwards
        group.delegate = RemoveLayerDelegate(layer: pulse)

        pulse.add(group, forKey: "pulse")
    }

    // MARK: - Pop In / Pop Out

    private func applyPopIn(to layer: CALayer) {
        // Spring-like scale: 0.1 → 1.15 → 1.0
        let scaleAnim = CAKeyframeAnimation(keyPath: "transform")
        scaleAnim.values = [
            NSValue(caTransform3D: CATransform3DMakeScale(0.1, 0.1, 1.0)),
            NSValue(caTransform3D: CATransform3DMakeScale(1.15, 1.15, 1.0)),
            NSValue(caTransform3D: CATransform3DIdentity)
        ]
        scaleAnim.keyTimes = [0, 0.7, 1.0]
        scaleAnim.duration = 0.3
        scaleAnim.timingFunctions = [
            CAMediaTimingFunction(name: .easeOut),
            CAMediaTimingFunction(name: .easeInEaseOut)
        ]

        let fadeIn = CABasicAnimation(keyPath: "opacity")
        fadeIn.fromValue = 0.0
        fadeIn.toValue = 1.0
        fadeIn.duration = 0.15

        let group = CAAnimationGroup()
        group.animations = [scaleAnim, fadeIn]
        group.duration = 0.3

        // Model layer stays at final state (identity transform, full opacity)
        layer.transform = CATransform3DIdentity
        layer.opacity = 1.0

        layer.add(group, forKey: "popIn")
    }

    private func popIn(completion: @escaping () -> Void) {
        guard let cursor = cursorLayer, let glow = glowLayer else {
            completion()
            return
        }

        // Remove lingering popOut fill-forward animations before popping back in
        cursor.removeAnimation(forKey: "popOut")
        glow.removeAnimation(forKey: "popOut")
        centerDot?.removeAnimation(forKey: "popOut")

        applyPopIn(to: cursor)
        applyPopIn(to: glow)
        addBreathingAnimation(to: glow)
        isHidden = false

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            completion()
        }
    }

    private func popOut() {
        guard let cursor = cursorLayer, let glow = glowLayer else { return }

        for layer in [cursor, glow] {
            // Scale: 1.0 → 1.3 → 0.001
            let scaleAnim = CAKeyframeAnimation(keyPath: "transform")
            scaleAnim.values = [
                NSValue(caTransform3D: CATransform3DIdentity),
                NSValue(caTransform3D: CATransform3DMakeScale(1.3, 1.3, 1.0)),
                NSValue(caTransform3D: CATransform3DMakeScale(0.001, 0.001, 1.0))
            ]
            scaleAnim.keyTimes = [0, 0.3, 1.0]
            scaleAnim.duration = 0.3
            scaleAnim.timingFunctions = [
                CAMediaTimingFunction(name: .easeOut),
                CAMediaTimingFunction(name: .easeIn)
            ]

            let fadeOut = CABasicAnimation(keyPath: "opacity")
            fadeOut.fromValue = 1.0
            fadeOut.toValue = 0.0
            fadeOut.duration = 0.2

            let group = CAAnimationGroup()
            group.animations = [scaleAnim, fadeOut]
            group.duration = 0.3
            group.isRemovedOnCompletion = false
            group.fillMode = .forwards

            layer.transform = CATransform3DMakeScale(0.001, 0.001, 1.0)
            layer.opacity = 0.0
            layer.add(group, forKey: "popOut")
        }

        isHidden = true
    }

    // MARK: - Idle Timer

    private func resetIdleTimer() {
        idleWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            DispatchQueue.main.async {
                self?.popOut()
            }
        }
        idleWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + idleTimeout, execute: work)
    }

    // MARK: - Random Offset

    private func randomOffset(from point: CGPoint) -> CGPoint {
        let distance = CGFloat.random(in: 10...25)
        let angle = CGFloat.random(in: 0...(2 * .pi))
        let dx = cos(angle) * distance
        let dy = sin(angle) * distance

        var newPoint = CGPoint(x: point.x + dx, y: point.y + dy)

        // Clamp to overlay window bounds (view coordinates, bottom-left origin)
        if let root = OverlayWindowManager.shared.ensureRootLayer() {
            let bounds = root.bounds
            newPoint.x = max(cursorSize, min(bounds.width - cursorSize, newPoint.x))
            newPoint.y = max(cursorSize, min(bounds.height - cursorSize, newPoint.y))
        }

        return newPoint
    }
}

import AppKit
import QuartzCore
import CoreText

private struct ActorOverlayPoint: Decodable {
    let x: Double
    let y: Double

    var cgPoint: CGPoint {
        CGPoint(x: x, y: y)
    }
}

private struct ActorOverlayPayload: Decodable {
    let op: String
    let name: String
    let type: String?
    let position: ActorOverlayPoint?
    let to: ActorOverlayPoint?
    let durationMs: Double?
    let style: String?
    let button: String?
    let dx: Double?
    let dy: Double?
    let text: String?
}

private final class PointerActorLayer {
    let name: String
    let container = CALayer()
    let halo = CALayer()
    let body = CALayer()
    let center = CALayer()

    var screenPosition: CGPoint
    var hidden = true
    var thinkLayer: CALayer?
    var dragLayer: CAShapeLayer?
    var bubbleLayer: CALayer?
    var bubbleTextLayer: CATextLayer?
    var cleanupItems: [DispatchWorkItem] = []

    init(name: String, screenPosition: CGPoint) {
        self.name = name
        self.screenPosition = screenPosition

        container.masksToBounds = false

        halo.bounds = CGRect(x: 0, y: 0, width: 34, height: 34)
        halo.cornerRadius = 17
        halo.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.18).cgColor
        halo.shadowColor = NSColor.systemBlue.cgColor
        halo.shadowOpacity = 0.65
        halo.shadowRadius = 10
        halo.shadowOffset = .zero

        body.bounds = CGRect(x: 0, y: 0, width: 18, height: 18)
        body.cornerRadius = 9
        body.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.92).cgColor
        body.borderWidth = 2.5
        body.borderColor = NSColor.white.withAlphaComponent(0.95).cgColor
        body.shadowColor = NSColor.systemBlue.cgColor
        body.shadowOpacity = 0.6
        body.shadowRadius = 5
        body.shadowOffset = .zero

        center.bounds = CGRect(x: 0, y: 0, width: 6, height: 6)
        center.cornerRadius = 3
        center.backgroundColor = NSColor.white.withAlphaComponent(0.95).cgColor
        center.position = CGPoint(x: 9, y: 9)
        body.addSublayer(center)

        container.addSublayer(halo)
        container.addSublayer(body)

        container.opacity = 0
        container.isHidden = true
    }

    func cancelCleanup() {
        for item in cleanupItems {
            item.cancel()
        }
        cleanupItems.removeAll()
    }
}

/// Retained overlay renderer for daemon-owned visual actors.
final class ActorOverlayService {
    static let shared = ActorOverlayService()
    private init() {}

    private var actorsByName: [String: PointerActorLayer] = [:]

    func handle(jsonData: Data) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let decoder = JSONDecoder()
            guard let payload = try? decoder.decode(ActorOverlayPayload.self, from: jsonData) else {
                return
            }
            self.apply(payload)
        }
    }

    private func apply(_ payload: ActorOverlayPayload) {
        guard let root = OverlayWindowManager.shared.ensureRootLayer() else { return }

        switch payload.op {
        case "spawn":
            let actor = ensureActor(named: payload.name, root: root, screenPosition: payload.position?.cgPoint)
            actor.screenPosition = payload.position?.cgPoint ?? actor.screenPosition
            syncPosition(actor, root: root)
            show(actor, duration: durationSeconds(payload.durationMs))
        case "show":
            guard let actor = actor(named: payload.name, root: root) else { return }
            if let position = payload.position?.cgPoint {
                actor.screenPosition = position
            }
            syncPosition(actor, root: root)
            show(actor, duration: durationSeconds(payload.durationMs))
        case "move":
            guard let actor = actor(named: payload.name, root: root), let target = payload.to?.cgPoint else { return }
            clearTransientDecorations(actor)
            show(actor, duration: 0.12)
            animateMove(actor, root: root, to: target, duration: durationSeconds(payload.durationMs), style: payload.style ?? "purposeful")
        case "click":
            guard let actor = actor(named: payload.name, root: root) else { return }
            clearTransientDecorations(actor)
            show(actor, duration: 0.12)
            animateClick(actor, root: root, duration: durationSeconds(payload.durationMs), button: payload.button ?? "left")
        case "drag":
            guard let actor = actor(named: payload.name, root: root), let target = payload.to?.cgPoint else { return }
            clearTransientDecorations(actor)
            show(actor, duration: 0.12)
            animateDrag(actor, root: root, to: target, duration: durationSeconds(payload.durationMs))
        case "scroll":
            guard let actor = actor(named: payload.name, root: root) else { return }
            clearTransientDecorations(actor)
            show(actor, duration: 0.12)
            animateScroll(actor, root: root, dx: payload.dx ?? 0, dy: payload.dy ?? 0, duration: durationSeconds(payload.durationMs))
        case "thinkStart":
            guard let actor = actor(named: payload.name, root: root) else { return }
            clearTransientDecorations(actor)
            show(actor, duration: 0.12)
            startThinking(actor)
        case "thinkStop":
            guard let actor = actorsByName[payload.name] else { return }
            stopThinking(actor, duration: durationSeconds(payload.durationMs))
        case "narrate":
            guard let actor = actor(named: payload.name, root: root) else { return }
            clearTransientDecorations(actor)
            show(actor, duration: 0.12)
            showBubble(actor, root: root, text: payload.text ?? "", duration: durationSeconds(payload.durationMs))
        case "dismiss":
            guard let actor = actorsByName[payload.name] else { return }
            clearTransientDecorations(actor)
            hide(actor, duration: durationSeconds(payload.durationMs))
        case "cancel":
            guard let actor = actorsByName[payload.name] else { return }
            clearTransientDecorations(actor)
            setPressed(actor, pressed: false)
        case "kill":
            guard let actor = actorsByName.removeValue(forKey: payload.name) else { return }
            clearTransientDecorations(actor)
            actor.cancelCleanup()
            actor.container.removeAllAnimations()
            actor.container.removeFromSuperlayer()
        default:
            break
        }
    }

    private func ensureActor(named name: String, root: CALayer, screenPosition: CGPoint?) -> PointerActorLayer {
        if let existing = actorsByName[name] {
            existing.container.frame = root.bounds
            if existing.container.superlayer == nil {
                root.addSublayer(existing.container)
            }
            return existing
        }

        let actor = PointerActorLayer(name: name, screenPosition: screenPosition ?? CGPoint(x: 0, y: 0))
        actor.container.frame = root.bounds
        root.addSublayer(actor.container)
        actorsByName[name] = actor
        return actor
    }

    private func actor(named name: String, root: CALayer) -> PointerActorLayer? {
        guard let actor = actorsByName[name] else { return nil }
        actor.container.frame = root.bounds
        if actor.container.superlayer == nil {
            root.addSublayer(actor.container)
        }
        return actor
    }

    private func syncPosition(_ actor: PointerActorLayer, root: CALayer) {
        actor.container.frame = root.bounds
        let viewPoint = OverlayWindowManager.shared.screenPointToView(actor.screenPosition)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        actor.halo.position = viewPoint
        actor.body.position = viewPoint
        CATransaction.commit()
    }

    private func durationSeconds(_ value: Double?) -> CFTimeInterval {
        max(0, (value ?? 180) / 1000)
    }

    private func currentPosition(_ actor: PointerActorLayer) -> CGPoint {
        if let position = actor.body.presentation()?.position {
            return position
        }
        return actor.body.position
    }

    private func show(_ actor: PointerActorLayer, duration: CFTimeInterval) {
        actor.container.isHidden = false
        actor.hidden = false
        actor.container.removeAnimation(forKey: "actor-hide")

        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = max(0.78, actor.container.presentation()?.value(forKeyPath: "transform.scale") as? CGFloat ?? 0.78)
        scale.toValue = 1
        scale.duration = max(0.12, duration)
        scale.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = actor.container.presentation()?.opacity ?? 0
        fade.toValue = 1
        fade.duration = max(0.12, duration)
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)

        actor.container.transform = CATransform3DIdentity
        actor.container.opacity = 1
        actor.container.add(scale, forKey: "actor-show-scale")
        actor.container.add(fade, forKey: "actor-show")
    }

    private func hide(_ actor: PointerActorLayer, duration: CFTimeInterval) {
        actor.hidden = true
        actor.cancelCleanup()

        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = actor.container.presentation()?.value(forKeyPath: "transform.scale") as? CGFloat ?? 1
        scale.toValue = 0.78
        scale.duration = max(0.12, duration)
        scale.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = actor.container.presentation()?.opacity ?? actor.container.opacity
        fade.toValue = 0
        fade.duration = max(0.12, duration)
        fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)

        actor.container.transform = CATransform3DMakeScale(0.78, 0.78, 1)
        actor.container.opacity = 0
        actor.container.add(scale, forKey: "actor-hide-scale")
        actor.container.add(fade, forKey: "actor-hide")

        let work = DispatchWorkItem { [weak actor] in
            actor?.container.isHidden = true
        }
        actor.cleanupItems.append(work)
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.12, duration), execute: work)
    }

    private func animateMove(_ actor: PointerActorLayer, root: CALayer, to target: CGPoint, duration: CFTimeInterval, style: String) {
        let from = currentPosition(actor)
        let to = OverlayWindowManager.shared.screenPointToView(target)
        actor.screenPosition = target
        setPressed(actor, pressed: false)

        let timing: CAMediaTimingFunctionName
        switch style {
        case "fast":
            timing = .easeOut
        case "slow":
            timing = .easeInEaseOut
        case "wandering":
            timing = .linear
        default:
            timing = .easeInEaseOut
        }

        animateLayerPosition(actor.body, from: from, to: to, duration: max(0.01, duration), timing: timing, wandering: style == "wandering")
        animateLayerPosition(actor.halo, from: from, to: to, duration: max(0.01, duration), timing: timing, wandering: style == "wandering")
    }

    private func animateClick(_ actor: PointerActorLayer, root: CALayer, duration: CFTimeInterval, button: String) {
        let point = currentPosition(actor)
        let tint: NSColor
        switch button {
        case "right":
            tint = .systemOrange
        case "middle":
            tint = .systemGreen
        default:
            tint = .systemBlue
        }

        addPulseRing(root: root, point: point, color: tint, scale: 5.6, duration: max(0.18, duration))
        let echo = DispatchWorkItem { [weak self, weak root] in
            guard let self, let root else { return }
            self.addPulseRing(root: root, point: point, color: tint.withAlphaComponent(0.7), scale: 3.2, duration: max(0.14, duration * 0.8))
        }
        actor.cleanupItems.append(echo)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: echo)

        let pop = CAKeyframeAnimation(keyPath: "transform.scale")
        pop.values = [1.0, 0.86, 1.12, 1.0]
        pop.keyTimes = [0, 0.18, 0.48, 1]
        pop.duration = max(0.18, duration)
        pop.timingFunctions = [
            CAMediaTimingFunction(name: .easeInEaseOut),
            CAMediaTimingFunction(name: .easeOut),
            CAMediaTimingFunction(name: .easeInEaseOut),
        ]
        actor.body.add(pop, forKey: "click-pop")
    }

    private func animateDrag(_ actor: PointerActorLayer, root: CALayer, to target: CGPoint, duration: CFTimeInterval) {
        let start = currentPosition(actor)
        let end = OverlayWindowManager.shared.screenPointToView(target)
        actor.screenPosition = target

        let dragLayer = CAShapeLayer()
        dragLayer.frame = root.bounds
        let path = CGMutablePath()
        path.move(to: start)
        path.addLine(to: end)
        dragLayer.path = path
        dragLayer.strokeColor = NSColor.systemBlue.withAlphaComponent(0.65).cgColor
        dragLayer.fillColor = nil
        dragLayer.lineWidth = 2.5
        dragLayer.lineDashPattern = [8, 5]
        dragLayer.lineCap = .round
        actor.container.addSublayer(dragLayer)
        actor.dragLayer = dragLayer

        let stroke = CABasicAnimation(keyPath: "strokeEnd")
        stroke.fromValue = 0
        stroke.toValue = 1
        stroke.duration = max(0.18, duration * 0.55)
        stroke.timingFunction = CAMediaTimingFunction(name: .easeOut)
        dragLayer.add(stroke, forKey: "drag-stroke")

        setPressed(actor, pressed: true)
        animateLayerPosition(actor.body, from: start, to: end, duration: max(0.18, duration), timing: .easeInEaseOut, wandering: false)
        animateLayerPosition(actor.halo, from: start, to: end, duration: max(0.18, duration), timing: .easeInEaseOut, wandering: false)

        let release = DispatchWorkItem { [weak self, weak actor] in
            guard let self, let actor else { return }
            self.setPressed(actor, pressed: false)
            self.removeDragLayer(actor)
            self.animateClick(actor, root: root, duration: 0.22, button: "left")
        }
        actor.cleanupItems.append(release)
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.18, duration), execute: release)
    }

    private func animateScroll(_ actor: PointerActorLayer, root: CALayer, dx: Double, dy: Double, duration: CFTimeInterval) {
        let origin = currentPosition(actor)
        let chevrons = CALayer()
        chevrons.frame = root.bounds
        actor.container.addSublayer(chevrons)

        if dy != 0 {
            let isUp = dy < 0
            let count = min(4, max(1, Int(abs(dy) / 80)))
            for index in 0..<count {
                let offset = CGFloat(index) * 18
                let y = isUp ? origin.y + 22 + offset : origin.y - 22 - offset
                chevrons.addSublayer(makeChevron(at: CGPoint(x: origin.x, y: y), verticalUp: isUp))
            }
        }

        if dx != 0 {
            let isLeft = dx < 0
            let count = min(4, max(1, Int(abs(dx) / 80)))
            for index in 0..<count {
                let offset = CGFloat(index) * 18
                let x = isLeft ? origin.x - 24 - offset : origin.x + 24 + offset
                chevrons.addSublayer(makeChevron(at: CGPoint(x: x, y: origin.y), horizontalLeft: isLeft))
            }
        }

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.duration = max(0.2, duration)
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        fade.delegate = RemoveLayerDelegate(layer: chevrons)
        chevrons.add(fade, forKey: "scroll-fade")
    }

    private func startThinking(_ actor: PointerActorLayer) {
        stopThinking(actor, duration: 0)

        let orbit = CALayer()
        orbit.bounds = CGRect(x: 0, y: 0, width: 42, height: 42)
        orbit.position = currentPosition(actor)

        let radii: [CGFloat] = [14, 16, 18]
        let colors: [NSColor] = [
            .systemBlue.withAlphaComponent(0.95),
            .systemTeal.withAlphaComponent(0.85),
            .white.withAlphaComponent(0.9),
        ]

        for (index, radius) in radii.enumerated() {
            let dot = CALayer()
            dot.bounds = CGRect(x: 0, y: 0, width: 6, height: 6)
            dot.cornerRadius = 3
            dot.backgroundColor = colors[index].cgColor
            dot.position = CGPoint(x: 21 + radius, y: 21)
            orbit.addSublayer(dot)
        }

        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.fromValue = 0
        spin.toValue = CGFloat.pi * 2
        spin.duration = 1.0
        spin.repeatCount = .infinity
        spin.timingFunction = CAMediaTimingFunction(name: .linear)
        orbit.add(spin, forKey: "think-spin")

        actor.container.addSublayer(orbit)
        actor.thinkLayer = orbit
    }

    private func stopThinking(_ actor: PointerActorLayer, duration: CFTimeInterval) {
        guard let thinkLayer = actor.thinkLayer else { return }
        actor.thinkLayer = nil
        if duration <= 0 {
            thinkLayer.removeFromSuperlayer()
            return
        }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = thinkLayer.presentation()?.opacity ?? thinkLayer.opacity
        fade.toValue = 0
        fade.duration = max(0.1, duration)
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        fade.delegate = RemoveLayerDelegate(layer: thinkLayer)
        thinkLayer.add(fade, forKey: "think-fade")
        thinkLayer.opacity = 0
    }

    private func showBubble(_ actor: PointerActorLayer, root: CALayer, text: String, duration: CFTimeInterval) {
        guard !text.isEmpty else { return }

        let bubble = CALayer()
        bubble.backgroundColor = NSColor.black.withAlphaComponent(0.78).cgColor
        bubble.cornerRadius = 10
        bubble.shadowColor = NSColor.black.cgColor
        bubble.shadowOpacity = 0.28
        bubble.shadowRadius = 10
        bubble.shadowOffset = CGSize(width: 0, height: -2)

        let label = CATextLayer()
        label.string = text
        label.font = CTFontCreateWithName("SF Pro Text" as CFString, 12, nil)
        label.fontSize = 12
        label.foregroundColor = NSColor.white.withAlphaComponent(0.96).cgColor
        label.alignmentMode = .left
        label.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        label.isWrapped = true
        label.truncationMode = .end

        let maxWidth: CGFloat = 260
        let textSize = estimateTextSize(text: text, maxWidth: maxWidth)
        bubble.bounds = CGRect(x: 0, y: 0, width: textSize.width + 24, height: textSize.height + 18)
        let point = currentPosition(actor)
        bubble.position = CGPoint(x: point.x + bubble.bounds.width / 2 + 18, y: point.y + bubble.bounds.height / 2 + 10)
        label.frame = CGRect(x: 12, y: 9, width: textSize.width, height: textSize.height)
        bubble.addSublayer(label)

        actor.container.addSublayer(bubble)
        actor.bubbleLayer = bubble
        actor.bubbleTextLayer = label

        let fadeIn = CABasicAnimation(keyPath: "opacity")
        fadeIn.fromValue = 0
        fadeIn.toValue = 1
        fadeIn.duration = 0.14
        bubble.opacity = 1
        bubble.add(fadeIn, forKey: "bubble-show")

        let hideWork = DispatchWorkItem { [weak self, weak actor] in
            guard let self, let actor else { return }
            self.hideBubble(actor)
        }
        actor.cleanupItems.append(hideWork)
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.3, duration), execute: hideWork)
    }

    private func hideBubble(_ actor: PointerActorLayer) {
        guard let bubble = actor.bubbleLayer else { return }
        actor.bubbleLayer = nil
        actor.bubbleTextLayer = nil

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = bubble.presentation()?.opacity ?? bubble.opacity
        fade.toValue = 0
        fade.duration = 0.18
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        fade.delegate = RemoveLayerDelegate(layer: bubble)
        bubble.add(fade, forKey: "bubble-hide")
        bubble.opacity = 0
    }

    private func clearTransientDecorations(_ actor: PointerActorLayer) {
        actor.cancelCleanup()
        hideBubble(actor)
        stopThinking(actor, duration: 0)
        removeDragLayer(actor)
        setPressed(actor, pressed: false)
    }

    private func removeDragLayer(_ actor: PointerActorLayer) {
        actor.dragLayer?.removeAllAnimations()
        actor.dragLayer?.removeFromSuperlayer()
        actor.dragLayer = nil
    }

    private func setPressed(_ actor: PointerActorLayer, pressed: Bool) {
        let color = pressed
            ? NSColor.systemOrange.withAlphaComponent(0.92).cgColor
            : NSColor.systemBlue.withAlphaComponent(0.92).cgColor
        let haloColor = pressed
            ? NSColor.systemOrange.withAlphaComponent(0.22).cgColor
            : NSColor.systemBlue.withAlphaComponent(0.18).cgColor
        actor.body.backgroundColor = color
        actor.halo.backgroundColor = haloColor
        actor.body.transform = pressed ? CATransform3DMakeScale(1.12, 1.12, 1) : CATransform3DIdentity
    }

    private func animateLayerPosition(
        _ layer: CALayer,
        from: CGPoint,
        to: CGPoint,
        duration: CFTimeInterval,
        timing: CAMediaTimingFunctionName,
        wandering: Bool
    ) {
        layer.removeAnimation(forKey: "move")
        layer.position = to

        if wandering {
            let path = CGMutablePath()
            path.move(to: from)
            let mid = CGPoint(x: (from.x + to.x) / 2 + 28, y: (from.y + to.y) / 2 + 18)
            path.addQuadCurve(to: to, control: mid)
            let animation = CAKeyframeAnimation(keyPath: "position")
            animation.path = path
            animation.duration = duration
            animation.timingFunction = CAMediaTimingFunction(name: timing)
            layer.add(animation, forKey: "move")
            return
        }

        let animation = CABasicAnimation(keyPath: "position")
        animation.fromValue = from
        animation.toValue = to
        animation.duration = duration
        animation.timingFunction = CAMediaTimingFunction(name: timing)
        layer.add(animation, forKey: "move")
    }

    private func addPulseRing(root: CALayer, point: CGPoint, color: NSColor, scale: CGFloat, duration: CFTimeInterval) {
        let ring = CALayer()
        ring.bounds = CGRect(x: 0, y: 0, width: 18, height: 18)
        ring.cornerRadius = 9
        ring.borderWidth = 2
        ring.borderColor = color.withAlphaComponent(0.7).cgColor
        ring.backgroundColor = color.withAlphaComponent(0.12).cgColor
        ring.position = point
        root.addSublayer(ring)

        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 1
        grow.toValue = scale
        grow.duration = duration
        grow.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.8
        fade.toValue = 0
        fade.duration = duration
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let group = CAAnimationGroup()
        group.animations = [grow, fade]
        group.duration = duration
        group.delegate = RemoveLayerDelegate(layer: ring)
        group.isRemovedOnCompletion = false
        group.fillMode = .forwards
        ring.add(group, forKey: "pulse")
    }

    private func makeChevron(at point: CGPoint, verticalUp: Bool? = nil, horizontalLeft: Bool? = nil) -> CAShapeLayer {
        let size: CGFloat = 14
        let shape = CAShapeLayer()
        shape.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        shape.position = point

        let path = CGMutablePath()
        if let verticalUp {
            if verticalUp {
                path.move(to: CGPoint(x: 2, y: 4))
                path.addLine(to: CGPoint(x: size / 2, y: size - 2))
                path.addLine(to: CGPoint(x: size - 2, y: 4))
            } else {
                path.move(to: CGPoint(x: 2, y: size - 4))
                path.addLine(to: CGPoint(x: size / 2, y: 2))
                path.addLine(to: CGPoint(x: size - 2, y: size - 4))
            }
        } else if let horizontalLeft {
            if horizontalLeft {
                path.move(to: CGPoint(x: size - 4, y: 2))
                path.addLine(to: CGPoint(x: 2, y: size / 2))
                path.addLine(to: CGPoint(x: size - 4, y: size - 2))
            } else {
                path.move(to: CGPoint(x: 4, y: 2))
                path.addLine(to: CGPoint(x: size - 2, y: size / 2))
                path.addLine(to: CGPoint(x: 4, y: size - 2))
            }
        }

        shape.path = path
        shape.strokeColor = NSColor.systemOrange.withAlphaComponent(0.9).cgColor
        shape.fillColor = nil
        shape.lineWidth = 2.4
        shape.lineCap = .round
        shape.lineJoin = .round
        return shape
    }

    private func estimateTextSize(text: String, maxWidth: CGFloat) -> CGSize {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
        ]
        let rect = NSString(string: text).boundingRect(
            with: CGSize(width: maxWidth, height: 400),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attributes
        )
        return CGSize(width: ceil(rect.width), height: ceil(rect.height))
    }
}

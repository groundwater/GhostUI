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

private struct ActorOverlayRect: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var cgRect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

private struct ActorOverlayPayload: Decodable {
    let op: String
    let name: String
    let type: String?
    let position: ActorOverlayPoint?
    let to: ActorOverlayPoint?
    let rect: ActorOverlayRect?
    let box: ActorOverlayRect?
    let durationMs: Double?
    let style: String?
    let button: String?
    let dx: Double?
    let dy: Double?
    let text: String?
    let shape: String?
    let font: String?
    let size: Double?
    let color: String?
    let highlight: String?
    let padding: Double?
    let roughness: Double?
    let opacity: Double?
    let id: String?
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

private final class CanvasActorLayer {
    let name: String
    let container = CALayer()
    var markerLayersByKey: [String: CAShapeLayer] = [:]
    var textLayersByKey: [String: CanvasTextItemLayer] = [:]
    private var nextGeneratedItemIndex: Int = 0

    init(name: String) {
        self.name = name
        container.masksToBounds = false
        container.opacity = 1
        container.isHidden = false
    }

    func nextItemKey(prefix: String) -> String {
        defer { nextGeneratedItemIndex += 1 }
        return "\(name).\(prefix).\(nextGeneratedItemIndex)"
    }

    func clearItems() {
        for layer in markerLayersByKey.values {
            layer.removeAllAnimations()
            layer.removeFromSuperlayer()
        }
        for item in textLayersByKey.values {
            item.removeAllAnimations()
            item.container.removeFromSuperlayer()
        }
        markerLayersByKey.removeAll()
        textLayersByKey.removeAll()
        nextGeneratedItemIndex = 0
    }
}

private final class CanvasTextItemLayer {
    let container = CALayer()
    let background = CALayer()
    let label = CATextLayer()

    init() {
        container.masksToBounds = false
        container.opacity = 0

        background.masksToBounds = true
        background.cornerRadius = 10
        background.backgroundColor = NSColor.clear.cgColor
        background.shadowColor = NSColor.black.cgColor
        background.shadowOpacity = 0.0
        background.shadowRadius = 8
        background.shadowOffset = CGSize(width: 0, height: -1)

        label.alignmentMode = .center
        label.isWrapped = true
        label.truncationMode = .end
        label.contentsScale = NSScreen.main?.backingScaleFactor ?? 2

        container.addSublayer(background)
        container.addSublayer(label)
    }

    func removeAllAnimations() {
        container.removeAllAnimations()
        background.removeAllAnimations()
        label.removeAllAnimations()
    }
}

/// Retained overlay renderer for daemon-owned visual actors.
final class ActorOverlayService {
    static let shared = ActorOverlayService()
    private init() {}

    private var actorsByName: [String: PointerActorLayer] = [:]
    private var canvasActorsByName: [String: CanvasActorLayer] = [:]

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

        if isCanvasPayload(payload) {
            applyCanvas(payload, root: root)
            return
        }

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
            if let canvasActor = canvasActorsByName.removeValue(forKey: payload.name) {
                clearCanvas(canvasActor)
                canvasActor.container.removeAllAnimations()
                canvasActor.container.removeFromSuperlayer()
            }
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

    private func isCanvasPayload(_ payload: ActorOverlayPayload) -> Bool {
        let type = payload.type?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if type == "canvas" {
            return true
        }
        return payload.op.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("canvas.")
    }

    private func canvasOp(_ payload: ActorOverlayPayload) -> String {
        let raw = payload.op.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if raw.hasPrefix("canvas.") {
            return String(raw.dropFirst("canvas.".count))
        }
        return raw
    }

    private func applyCanvas(_ payload: ActorOverlayPayload, root: CALayer) {
        switch canvasOp(payload) {
        case "spawn", "show":
            _ = ensureCanvasActor(named: payload.name, root: root)
        case "draw":
            guard let actor = ensureCanvasActor(named: payload.name, root: root) else { return }
            applyCanvasDraw(actor, root: root, payload: payload)
        case "text":
            guard let actor = ensureCanvasActor(named: payload.name, root: root) else { return }
            applyCanvasText(actor, root: root, payload: payload)
        case "clear":
            guard let actor = canvasActor(named: payload.name, root: root) else { return }
            clearCanvas(actor)
        case "kill":
            guard let actor = canvasActorsByName.removeValue(forKey: payload.name) else { return }
            clearCanvas(actor)
            actor.container.removeAllAnimations()
            actor.container.removeFromSuperlayer()
        default:
            break
        }
    }

    private func ensureCanvasActor(named name: String, root: CALayer) -> CanvasActorLayer? {
        if let existing = canvasActorsByName[name] {
            existing.container.frame = root.bounds
            existing.container.isHidden = false
            existing.container.opacity = 1
            if existing.container.superlayer == nil {
                root.addSublayer(existing.container)
            }
            return existing
        }

        let actor = CanvasActorLayer(name: name)
        actor.container.frame = root.bounds
        root.addSublayer(actor.container)
        canvasActorsByName[name] = actor
        return actor
    }

    private func canvasActor(named name: String, root: CALayer) -> CanvasActorLayer? {
        guard let actor = canvasActorsByName[name] else { return nil }
        actor.container.frame = root.bounds
        if actor.container.superlayer == nil {
            root.addSublayer(actor.container)
        }
        return actor
    }

    private func clearCanvas(_ actor: CanvasActorLayer) {
        actor.clearItems()
    }

    private func applyCanvasDraw(_ actor: CanvasActorLayer, root: CALayer, payload: ActorOverlayPayload) {
        guard let shape = payload.markerShape else { return }
        let style = payload.resolvedMarkerStyle
        let rect = payload.canvasMarkerRect(in: root, style: style)
        let key = canvasItemKey(from: payload, prefix: "marker", actor: actor)
        let layer = actor.markerLayersByKey[key] ?? CAShapeLayer()
        if actor.markerLayersByKey[key] == nil {
            actor.markerLayersByKey[key] = layer
            actor.container.addSublayer(layer)
        }

        let path = CanvasMarkerGeometry.makeMarkerPath(
            shape: shape,
            rect: rect,
            style: style,
            seed: CanvasMarkerGeometry.markerSeed(shape: shape, rect: rect, style: style)
        )

        let reveal = CABasicAnimation(keyPath: "strokeEnd")
        reveal.fromValue = 0
        reveal.toValue = 1
        reveal.duration = max(0.18, payload.durationSeconds ?? 0.26)
        reveal.timingFunction = CAMediaTimingFunction(name: .easeOut)
        reveal.isRemovedOnCompletion = true
        reveal.fillMode = .removed

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.frame = root.bounds
        layer.path = path
        layer.strokeColor = style.color
        layer.fillColor = nil
        layer.lineWidth = style.size
        layer.lineCap = .round
        layer.lineJoin = .round
        layer.miterLimit = 1
        layer.opacity = Float(style.opacity)
        layer.allowsEdgeAntialiasing = true
        layer.strokeEnd = 1
        CATransaction.commit()

        layer.add(reveal, forKey: "canvasMarkerReveal")
    }

    private func applyCanvasText(_ actor: CanvasActorLayer, root: CALayer, payload: ActorOverlayPayload) {
        guard let text = payload.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
        let fontSize = max(8, CGFloat(payload.size ?? 36))
        let fontName = payload.font?.trimmingCharacters(in: .whitespacesAndNewlines)
        let font = Self.makeTextFont(name: fontName, size: fontSize)
        let textColor = payload.color.flatMap(ActorOverlayColor.parse) ?? NSColor.systemRed.cgColor
        let highlightColor = payload.highlight.flatMap { value -> CGColor? in
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || trimmed.lowercased() == "none" {
                return nil
            }
            return ActorOverlayColor.parse(trimmed)
        }
        let maxWidth = payload.canvasTextMaxWidth(in: root, fontSize: fontSize)
        let textSize = estimateTextSize(text: text, maxWidth: maxWidth, font: font)
        let padding = max(10, fontSize * 0.36)
        let frame = payload.canvasTextFrame(in: root, textSize: textSize, padding: padding)
        let key = canvasItemKey(from: payload, prefix: "text", actor: actor)
        let item = actor.textLayersByKey[key] ?? CanvasTextItemLayer()
        if actor.textLayersByKey[key] == nil {
            actor.textLayersByKey[key] = item
            actor.container.addSublayer(item.container)
        }

        item.configure(
            frame: frame,
            text: text,
            font: font,
            fontSize: fontSize,
            textColor: textColor,
            highlightColor: highlightColor
        )

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.16
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        item.container.opacity = 1
        item.container.add(fade, forKey: "canvasTextReveal")
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

    private static func makeTextFont(name: String?, size: CGFloat) -> CTFont {
        if let name, !name.isEmpty {
            return CTFontCreateWithName(name as CFString, size, nil)
        }
        return CTFontCreateWithName("SF Pro Text" as CFString, size, nil)
    }

    private func canvasItemKey(from payload: ActorOverlayPayload, prefix: String, actor: CanvasActorLayer) -> String {
        if let raw = payload.id?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
            return raw
        }
        return actor.nextItemKey(prefix: prefix)
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

        let fontSize: CGFloat = 24
        let font = CTFontCreateWithName("SF Pro Text" as CFString, fontSize, nil)
        let measureFont = NSFont(name: CTFontCopyPostScriptName(font) as String, size: fontSize)
            ?? NSFont.systemFont(ofSize: fontSize, weight: .medium)
        let horizontalPadding = max(12, fontSize * 0.5)
        let verticalPadding = max(9, fontSize * 0.38)
        let maxWidth = min(max(root.bounds.width * 0.32, 260), 420)
        let wrappedText = wrapBubbleText(text, maxWidth: maxWidth, font: font)
        let textSize = estimateTextSize(text: wrappedText, maxWidth: maxWidth, font: measureFont)
        let textFrameWidth = max(1, min(maxWidth + 4, textSize.width + 4))
        let textFrameHeight = max(ceil(fontSize * 1.2), textSize.height)
        let bubbleSize = CGSize(
            width: textFrameWidth + horizontalPadding * 2,
            height: textFrameHeight + verticalPadding * 2
        )

        let bubble = CALayer()
        bubble.backgroundColor = NSColor.black.withAlphaComponent(0.78).cgColor
        bubble.cornerRadius = 10
        bubble.shadowColor = NSColor.black.cgColor
        bubble.shadowOpacity = 0.28
        bubble.shadowRadius = 10
        bubble.shadowOffset = CGSize(width: 0, height: -2)

        let label = CATextLayer()
        label.string = ""
        label.font = font
        label.fontSize = fontSize
        label.foregroundColor = NSColor.white.withAlphaComponent(0.96).cgColor
        label.alignmentMode = .left
        label.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        label.isWrapped = false
        label.truncationMode = .none

        bubble.bounds = CGRect(origin: .zero, size: bubbleSize)
        let point = currentPosition(actor)
        bubble.position = bubblePlacement(for: bubbleSize, near: point, in: root.bounds)
        label.frame = CGRect(x: horizontalPadding, y: verticalPadding, width: textFrameWidth, height: textFrameHeight)
        label.string = wrappedText
        bubble.addSublayer(label)

        actor.container.addSublayer(bubble)
        actor.bubbleLayer = bubble
        actor.bubbleTextLayer = label

        scheduleBubbleTyping(actor, label: label, text: wrappedText, duration: duration)

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

    private func scheduleBubbleTyping(
        _ actor: PointerActorLayer,
        label: CATextLayer,
        text: String,
        duration: CFTimeInterval
    ) {
        let characters = Array(text)
        guard !characters.isEmpty else { return }

        let availableReveal = max(0.18, min(max(0.22, duration * 0.72), Double(characters.count) * 0.045))
        let stepDelay = max(0.012, availableReveal / Double(characters.count))

        for index in 1...characters.count {
            let partial = String(characters.prefix(index))
            let reveal = DispatchWorkItem { [weak actor, weak label] in
                guard
                    let actor,
                    let label,
                    actor.bubbleTextLayer === label
                else { return }
                label.string = partial
            }
            actor.cleanupItems.append(reveal)
            let deadline = DispatchTime.now() + stepDelay * Double(index - 1)
            DispatchQueue.main.asyncAfter(deadline: deadline, execute: reveal)
        }
    }

    private func bubblePlacement(for bubbleSize: CGSize, near point: CGPoint, in bounds: CGRect) -> CGPoint {
        let edgeInset: CGFloat = 14
        let horizontalGap: CGFloat = 18
        let verticalGap: CGFloat = 12
        let halfWidth = bubbleSize.width / 2
        let halfHeight = bubbleSize.height / 2

        let fitsRight = point.x + horizontalGap + bubbleSize.width <= bounds.maxX - edgeInset
        let fitsLeft = point.x - horizontalGap - bubbleSize.width >= bounds.minX + edgeInset
        let fitsAbove = point.y + verticalGap + bubbleSize.height <= bounds.maxY - edgeInset
        let fitsBelow = point.y - verticalGap - bubbleSize.height >= bounds.minY + edgeInset

        let centerX: CGFloat
        if fitsRight {
            centerX = point.x + horizontalGap + halfWidth
        } else if fitsLeft {
            centerX = point.x - horizontalGap - halfWidth
        } else {
            centerX = min(max(point.x, bounds.minX + edgeInset + halfWidth), bounds.maxX - edgeInset - halfWidth)
        }

        let centerY: CGFloat
        if fitsAbove {
            centerY = point.y + verticalGap + halfHeight
        } else if fitsBelow {
            centerY = point.y - verticalGap - halfHeight
        } else {
            centerY = min(max(point.y, bounds.minY + edgeInset + halfHeight), bounds.maxY - edgeInset - halfHeight)
        }

        return CGPoint(x: centerX, y: centerY)
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
        estimateTextSize(text: text, maxWidth: maxWidth, font: NSFont.systemFont(ofSize: 12, weight: .medium))
    }

    private func estimateTextSize(text: String, maxWidth: CGFloat, font: NSFont) -> CGSize {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
        ]
        let rect = NSString(string: text).boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attributes
        )
        return CGSize(width: ceil(rect.width), height: ceil(rect.height))
    }

    private func wrapBubbleText(_ text: String, maxWidth: CGFloat, font: CTFont) -> String {
        guard maxWidth > 0 else { return text }

        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        let paragraphs = normalized.components(separatedBy: "\n")
        return paragraphs.map { paragraph in
            wrapBubbleParagraph(paragraph, maxWidth: maxWidth, font: font)
        }.joined(separator: "\n")
    }

    private func wrapBubbleParagraph(_ paragraph: String, maxWidth: CGFloat, font: CTFont) -> String {
        guard !paragraph.isEmpty else { return "" }

        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(rawValue: kCTFontAttributeName as String): font,
        ]
        let attributed = NSAttributedString(string: paragraph, attributes: attributes)
        let typesetter = CTTypesetterCreateWithAttributedString(attributed)
        let source = paragraph as NSString
        var lines: [String] = []
        var start = 0

        while start < attributed.length {
            let suggested = CTTypesetterSuggestLineBreak(typesetter, start, Double(maxWidth))
            let lineLength = max(1, min(suggested, attributed.length - start))
            let lineRange = NSRange(location: start, length: lineLength)
            let line = source.substring(with: lineRange).trimmingCharacters(in: .whitespaces)
            lines.append(line)
            start += lineLength

            while start < attributed.length {
                let scalar = source.character(at: start)
                if scalar == 0x20 || scalar == 0x09 {
                    start += 1
                } else {
                    break
                }
            }
        }

        return lines.joined(separator: "\n")
    }
}

private extension ActorOverlayPayload {
    var markerShape: CanvasMarkerShape? {
        let raw = shape?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch raw {
        case "rect":
            return .rect
        case "circ", "circle":
            return .circ
        case "check":
            return .check
        case "cross":
            return .cross
        case "underline":
            return .underline
        default:
            return nil
        }
    }

    var markerRect: ActorOverlayRect? {
        rect ?? box
    }

    var resolvedMarkerStyle: CanvasMarkerStyle {
        CanvasMarkerStyle(
            color: color.flatMap(ActorOverlayColor.parse) ?? NSColor.systemCyan.cgColor,
            size: max(0.5, CGFloat(size ?? 4)),
            padding: max(0, CGFloat(padding ?? 10)),
            roughness: min(max(CGFloat(roughness ?? 0.22), 0), 1),
            opacity: min(max(CGFloat(opacity ?? 1), 0), 1)
        )
    }

    func canvasMarkerRect(in root: CALayer, style: CanvasMarkerStyle) -> CGRect {
        let sourceRect: CGRect
        if let rect = markerRect?.cgRect {
            sourceRect = OverlayWindowManager.shared.screenRectToView(rect)
        } else {
            sourceRect = fallbackCanvasRect(in: root, style: style)
        }
        return sourceRect.insetBy(dx: -style.padding, dy: -style.padding)
    }

    func canvasTextFrame(in root: CALayer, textSize: CGSize, padding: CGFloat) -> CGRect {
        if let rect = markerRect?.cgRect {
            return OverlayWindowManager.shared.screenRectToView(rect)
        }

        let point = position?.cgPoint ?? CGPoint(x: root.bounds.midX, y: root.bounds.midY)
        let width = textSize.width + padding * 2
        let height = textSize.height + padding * 2
        return CGRect(
            x: point.x - width / 2,
            y: point.y - height / 2,
            width: width,
            height: height
        )
    }

    func canvasTextMaxWidth(in root: CALayer, fontSize: CGFloat) -> CGFloat {
        if let rect = markerRect?.cgRect {
            let viewRect = OverlayWindowManager.shared.screenRectToView(rect)
            return max(40, viewRect.width - 20)
        }
        return min(max(root.bounds.width * 0.68, fontSize * 8), 640)
    }

    private func fallbackCanvasRect(in root: CALayer, style: CanvasMarkerStyle) -> CGRect {
        let side = max(96, style.size * 24)
        let point = position?.cgPoint ?? CGPoint(x: root.bounds.midX, y: root.bounds.midY)
        return CGRect(x: point.x - side / 2, y: point.y - side / 2, width: side, height: side)
    }

    var durationSeconds: CFTimeInterval? {
        durationMs.map { max(0, $0) / 1000.0 }
    }
}

private struct CanvasMarkerStyle {
    let color: CGColor
    let size: CGFloat
    let padding: CGFloat
    let roughness: CGFloat
    let opacity: CGFloat
}

private enum CanvasMarkerShape: String {
    case rect
    case circ
    case check
    case cross
    case underline
}

private enum ActorOverlayColor {
    private static let hexColorPattern = "^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
    private static let rgbColorPattern = "^rgb\\(\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*,\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*,\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*\\)$"
    private static let rgbaColorPattern = "^rgba\\(\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*,\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*,\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*,\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*\\)$"

    static func parse(_ value: String) -> CGColor? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("#") {
            return parseHexColor(trimmed)
        }

        let lower = trimmed.lowercased()
        if lower.hasPrefix("rgb(") || lower.hasPrefix("rgba(") {
            return parseRGBColor(trimmed)
        }

        return nil
    }

    private static func parseHexColor(_ value: String) -> CGColor? {
        guard value.range(of: hexColorPattern, options: .regularExpression) != nil else {
            return nil
        }

        let hex = String(value.dropFirst())
        let expanded: String
        switch hex.count {
        case 3:
            expanded = hex.map { "\($0)\($0)" }.joined() + "FF"
        case 4:
            expanded = hex.map { "\($0)\($0)" }.joined()
        case 6:
            expanded = hex + "FF"
        case 8:
            expanded = hex
        default:
            return nil
        }

        guard let intValue = UInt64(expanded, radix: 16) else {
            return nil
        }

        let r = CGFloat((intValue >> 24) & 0xFF) / 255
        let g = CGFloat((intValue >> 16) & 0xFF) / 255
        let b = CGFloat((intValue >> 8) & 0xFF) / 255
        let a = CGFloat(intValue & 0xFF) / 255
        return CGColor(red: r, green: g, blue: b, alpha: a)
    }

    private static func parseRGBColor(_ value: String) -> CGColor? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)

        if let matches = matchColorPattern(trimmed, pattern: rgbColorPattern), matches.count == 4 {
            guard
                let r = parseRGBComponent(matches[1]),
                let g = parseRGBComponent(matches[2]),
                let b = parseRGBComponent(matches[3])
            else {
                return nil
            }
            return CGColor(red: r, green: g, blue: b, alpha: 1)
        }

        if let matches = matchColorPattern(trimmed, pattern: rgbaColorPattern), matches.count == 5 {
            guard
                let r = parseRGBComponent(matches[1]),
                let g = parseRGBComponent(matches[2]),
                let b = parseRGBComponent(matches[3]),
                let a = parseAlphaComponent(matches[4])
            else {
                return nil
            }
            return CGColor(red: r, green: g, blue: b, alpha: a)
        }

        return nil
    }

    private static func parseRGBComponent(_ value: String) -> CGFloat? {
        guard isStrictDecimal(value), let number = Double(value), number >= 0, number <= 255 else {
            return nil
        }
        return CGFloat(number / 255.0)
    }

    private static func parseAlphaComponent(_ value: String) -> CGFloat? {
        guard isStrictDecimal(value), let number = Double(value), number >= 0, number <= 1 else {
            return nil
        }
        return CGFloat(number)
    }

    private static func isStrictDecimal(_ value: String) -> Bool {
        value.range(of: #"^[+-]?(?:\d+|\d*\.\d+|\.\d+)$"#, options: .regularExpression) != nil
    }

    private static func matchColorPattern(_ value: String, pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return nil
        }

        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, options: [], range: range) else {
            return nil
        }

        return (0..<match.numberOfRanges).compactMap { index in
            guard let range = Range(match.range(at: index), in: value) else {
                return nil
            }
            return String(value[range])
        }
    }
}

private enum CanvasMarkerGeometry {
    static func makeMarkerPath(shape: CanvasMarkerShape, rect: CGRect, style: CanvasMarkerStyle, seed: UInt64) -> CGPath {
        var random = StableRandom(seed: seed)
        let path = CGMutablePath()

        switch shape {
        case .rect:
            addRoughOpenPath(path, points: markerRectanglePoints(in: rect, style: style, random: &random))
        case .circ:
            addSmoothClosedPath(path, points: markerCirclePoints(in: rect, style: style, random: &random))
        case .check:
            for stroke in markerCheckPoints(in: rect, style: style, random: &random) {
                addSmoothOpenPath(path, points: stroke)
            }
        case .cross:
            for stroke in markerCrossPoints(in: rect, style: style, random: &random) {
                addSmoothOpenPath(path, points: stroke)
            }
        case .underline:
            addSmoothOpenPath(path, points: markerUnderlinePoints(in: rect, style: style, random: &random))
        }

        return path
    }

    static func markerSeed(shape: CanvasMarkerShape, rect: CGRect, style: CanvasMarkerStyle) -> UInt64 {
        var hasher = StableHasher()
        hasher.combine(shape.rawValue)
        hasher.combine(rect.origin.x)
        hasher.combine(rect.origin.y)
        hasher.combine(rect.width)
        hasher.combine(rect.height)
        hasher.combine(style.size)
        hasher.combine(style.padding)
        hasher.combine(style.roughness)
        hasher.combine(style.opacity)
        return hasher.finalize()
    }

    private static func markerRectanglePoints(in rect: CGRect, style: CanvasMarkerStyle, random: inout StableRandom) -> [CGPoint] {
        let jitter = markerJitter(in: rect, style: style)
        let anchorJitterX = min(10, max(rect.width * 0.05, jitter * (0.75 + style.roughness * 0.45)))
        let anchorJitterY = min(10, max(rect.height * 0.05, jitter * (0.75 + style.roughness * 0.45)))
        let gap = max(6, min(max(style.size * 2.5, 8), rect.width * 0.18))
        let topCenterLeft = CGPoint(x: rect.midX - gap / 2, y: rect.minY)
        let topCenterRight = CGPoint(x: rect.midX + gap / 2, y: rect.minY)
        return [
            jitteredPoint(topCenterLeft, maxOffsetX: anchorJitterX * 0.45, maxOffsetY: anchorJitterY * 0.3, random: &random),
            jitteredPoint(CGPoint(x: rect.maxX, y: rect.minY), maxOffsetX: anchorJitterX, maxOffsetY: anchorJitterY, random: &random),
            jitteredPoint(CGPoint(x: rect.maxX, y: rect.maxY), maxOffsetX: anchorJitterX, maxOffsetY: anchorJitterY, random: &random),
            jitteredPoint(CGPoint(x: rect.minX, y: rect.maxY), maxOffsetX: anchorJitterX, maxOffsetY: anchorJitterY, random: &random),
            jitteredPoint(CGPoint(x: rect.minX, y: rect.minY), maxOffsetX: anchorJitterX, maxOffsetY: anchorJitterY, random: &random),
            jitteredPoint(topCenterRight, maxOffsetX: anchorJitterX * 0.45, maxOffsetY: anchorJitterY * 0.3, random: &random),
        ]
    }

    private static func markerCirclePoints(in rect: CGRect, style: CanvasMarkerStyle, random: inout StableRandom) -> [CGPoint] {
        let jitter = markerJitter(in: rect, style: style)
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let circumscribedScale: CGFloat = 1.41421356237
        let radiusX = max(rect.width * 0.5 * circumscribedScale, style.size)
        let radiusY = max(rect.height * 0.5 * circumscribedScale, style.size)
        let pointCount = min(28, max(12, Int((max(rect.width, rect.height) / max(style.size * 1.5, 1)).rounded(.up))))

        var result: [CGPoint] = []
        for index in 0..<pointCount {
            let progress = CGFloat(index) / CGFloat(pointCount)
            let angle = (progress * 2 * .pi) - (.pi / 2)
            let radialJitter = random.uniform(0, jitter) * (0.3 + style.roughness * 0.5)
            result.append(
                CGPoint(
                    x: center.x + cos(angle) * (radiusX + radialJitter),
                    y: center.y + sin(angle) * (radiusY + radialJitter)
                )
            )
        }
        return result
    }

    private static func markerCheckPoints(in rect: CGRect, style: CanvasMarkerStyle, random: inout StableRandom) -> [[CGPoint]] {
        let jitter = markerJitter(in: rect, style: style)
        let start1 = CGPoint(x: rect.minX + rect.width * 0.20 + random.uniform(-jitter, jitter) * 0.4, y: rect.minY + rect.height * 0.55 + random.uniform(-jitter, jitter) * 0.4)
        let end1 = CGPoint(x: rect.minX + rect.width * 0.42 + random.uniform(-jitter, jitter) * 0.4, y: rect.maxY - rect.height * 0.10 + random.uniform(-jitter, jitter) * 0.4)
        let start2 = CGPoint(x: rect.minX + rect.width * 0.40 + random.uniform(-jitter, jitter) * 0.45, y: rect.maxY - rect.height * 0.15 + random.uniform(-jitter, jitter) * 0.45)
        let end2 = CGPoint(x: rect.maxX - rect.width * 0.12 + random.uniform(-jitter, jitter) * 0.45, y: rect.minY + rect.height * 0.18 + random.uniform(-jitter, jitter) * 0.45)
        return [
            roughStrokePoints(from: start1, to: end1, style: style, random: &random),
            roughStrokePoints(from: start2, to: end2, style: style, random: &random),
        ]
    }

    private static func markerCrossPoints(in rect: CGRect, style: CanvasMarkerStyle, random: inout StableRandom) -> [[CGPoint]] {
        let jitter = markerJitter(in: rect, style: style)
        let firstStart = CGPoint(x: rect.minX + rect.width * 0.12 + random.uniform(-jitter, jitter) * 0.5, y: rect.minY + rect.height * 0.16 + random.uniform(-jitter, jitter) * 0.5)
        let firstEnd = CGPoint(x: rect.maxX - rect.width * 0.10 + random.uniform(-jitter, jitter) * 0.5, y: rect.maxY - rect.height * 0.12 + random.uniform(-jitter, jitter) * 0.5)
        let secondStart = CGPoint(x: rect.maxX - rect.width * 0.12 + random.uniform(-jitter, jitter) * 0.5, y: rect.minY + rect.height * 0.18 + random.uniform(-jitter, jitter) * 0.5)
        let secondEnd = CGPoint(x: rect.minX + rect.width * 0.10 + random.uniform(-jitter, jitter) * 0.5, y: rect.maxY - rect.height * 0.10 + random.uniform(-jitter, jitter) * 0.5)
        return [
            roughStrokePoints(from: firstStart, to: firstEnd, style: style, random: &random),
            roughStrokePoints(from: secondStart, to: secondEnd, style: style, random: &random),
        ]
    }

    private static func markerUnderlinePoints(in rect: CGRect, style: CanvasMarkerStyle, random: inout StableRandom) -> [CGPoint] {
        let jitter = markerJitter(in: rect, style: style)
        let yBase = rect.maxY - max(style.size * 0.55, rect.height * 0.08)
        let start = CGPoint(x: rect.minX - style.size * 0.35, y: yBase + random.uniform(-jitter, jitter) * 0.2)
        let end = CGPoint(x: rect.maxX + style.size * 0.35, y: yBase + random.uniform(-jitter, jitter) * 0.2)
        return roughStrokePoints(from: start, to: end, style: style, random: &random)
    }

    private static func roughStrokePoints(from start: CGPoint, to end: CGPoint, style: CanvasMarkerStyle, random: inout StableRandom) -> [CGPoint] {
        let delta = CGPoint(x: end.x - start.x, y: end.y - start.y)
        let length = max(hypot(delta.x, delta.y), 1)
        let tangent = CGPoint(x: delta.x / length, y: delta.y / length)
        let normal = CGPoint(x: -tangent.y, y: tangent.x)
        let jitter = markerJitter(length: length, style: style)
        let drift = jitter * (0.35 + style.roughness * 0.35)

        let startTangentJitter = random.uniform(-style.size * 0.28, style.size * 0.24)
        let startNormalJitter = random.uniform(-drift, drift)
        let mid1NormalJitter = random.uniform(-jitter, jitter)
        let mid1TangentJitter = random.uniform(-jitter * 0.12, jitter * 0.12)
        let mid2NormalJitter = random.uniform(-jitter, jitter)
        let mid2TangentJitter = random.uniform(-jitter * 0.12, jitter * 0.12)
        let endTangentJitter = random.uniform(-style.size * 0.18, style.size * 0.32)
        let endNormalJitter = random.uniform(-drift, drift)

        let startPoint = CGPoint(
            x: start.x + tangent.x * startTangentJitter + normal.x * startNormalJitter,
            y: start.y + tangent.y * startTangentJitter + normal.y * startNormalJitter
        )
        let mid1 = CGPoint(
            x: start.x + delta.x * 0.33 + normal.x * mid1NormalJitter + tangent.x * mid1TangentJitter,
            y: start.y + delta.y * 0.33 + normal.y * mid1NormalJitter + tangent.y * mid1TangentJitter
        )
        let mid2 = CGPoint(
            x: start.x + delta.x * 0.68 + normal.x * mid2NormalJitter + tangent.x * mid2TangentJitter,
            y: start.y + delta.y * 0.68 + normal.y * mid2NormalJitter + tangent.y * mid2TangentJitter
        )
        let endPoint = CGPoint(
            x: end.x + tangent.x * endTangentJitter + normal.x * endNormalJitter,
            y: end.y + tangent.y * endTangentJitter + normal.y * endNormalJitter
        )

        return [startPoint, mid1, mid2, endPoint]
    }

    private static func markerJitter(in rect: CGRect, style: CanvasMarkerStyle) -> CGFloat {
        let base = max(style.size * (0.08 + style.roughness * 0.45), 0.35)
        let rectScale = max(1, min(rect.width, rect.height) * 0.035)
        return min(rectScale, max(base, style.size * 0.1))
    }

    private static func markerJitter(length: CGFloat, style: CanvasMarkerStyle) -> CGFloat {
        let base = max(style.size * (0.10 + style.roughness * 0.55), 0.35)
        let lengthScale = max(0.8, length * 0.035)
        return min(lengthScale, base)
    }

    private static func addSmoothClosedPath(_ path: CGMutablePath, points: [CGPoint]) {
        guard points.count >= 2 else { return }
        path.move(to: points[0])
        let count = points.count
        for index in 0..<count {
            let p0 = points[(index - 1 + count) % count]
            let p1 = points[index]
            let p2 = points[(index + 1) % count]
            let p3 = points[(index + 2) % count]
            let cp1 = CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6)
            let cp2 = CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6)
            path.addCurve(to: p2, control1: cp1, control2: cp2)
        }
        path.closeSubpath()
    }

    private static func addRoughClosedPath(_ path: CGMutablePath, points: [CGPoint]) {
        guard points.count >= 2 else { return }
        path.move(to: points[0])
        for point in points.dropFirst() {
            path.addLine(to: point)
        }
        path.closeSubpath()
    }

    private static func addRoughOpenPath(_ path: CGMutablePath, points: [CGPoint]) {
        guard points.count >= 2 else { return }
        path.move(to: points[0])
        for point in points.dropFirst() {
            path.addLine(to: point)
        }
    }

    private static func addSmoothOpenPath(_ path: CGMutablePath, points: [CGPoint]) {
        guard points.count >= 2 else { return }
        path.move(to: points[0])
        if points.count == 2 {
            path.addLine(to: points[1])
            return
        }

        for index in 0..<(points.count - 1) {
            let p0 = index == 0 ? points[0] : points[index - 1]
            let p1 = points[index]
            let p2 = points[index + 1]
            let p3 = index + 2 < points.count ? points[index + 2] : points[points.count - 1]
            let cp1 = CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6)
            let cp2 = CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6)
            path.addCurve(to: p2, control1: cp1, control2: cp2)
        }
    }

    private static func jitteredPoint(
        _ point: CGPoint,
        maxOffsetX: CGFloat,
        maxOffsetY: CGFloat,
        random: inout StableRandom
    ) -> CGPoint {
        CGPoint(
            x: point.x + random.uniform(-maxOffsetX, maxOffsetX),
            y: point.y + random.uniform(-maxOffsetY, maxOffsetY)
        )
    }
}

private struct StableHasher {
    private var state: UInt64 = 0xcbf29ce484222325

    mutating func combine(_ value: UInt64) {
        state ^= value
        state &*= 0x100000001b3
    }

    mutating func combine(_ value: Double) {
        combine(value.bitPattern)
    }

    mutating func combine(_ value: String) {
        for byte in value.utf8 {
            combine(UInt64(byte))
        }
    }

    func finalize() -> UInt64 {
        state
    }
}

private struct StableRandom {
    private var state: UInt64

    init(seed: UInt64) {
        self.state = seed == 0 ? 0x9e3779b97f4a7c15 : seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9e3779b97f4a7c15
        var z = state
        z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9
        z = (z ^ (z >> 27)) &* 0x94d049bb133111eb
        return z ^ (z >> 31)
    }

    mutating func uniform(_ lower: CGFloat, _ upper: CGFloat) -> CGFloat {
        let raw = next()
        let unit = Double(raw) / Double(UInt64.max)
        return lower + (upper - lower) * CGFloat(unit)
    }
}

private extension CanvasTextItemLayer {
    func configure(
        frame: CGRect,
        text: String,
        font: CTFont,
        fontSize: CGFloat,
        textColor: CGColor,
        highlightColor: CGColor?
    ) {
        container.frame = frame
        container.isHidden = false

        background.frame = container.bounds
        background.cornerRadius = max(10, fontSize * 0.32)
        background.backgroundColor = highlightColor ?? NSColor.clear.cgColor
        background.opacity = highlightColor == nil ? 0 : 1
        background.shadowOpacity = highlightColor == nil ? 0 : 0.18
        background.shadowRadius = highlightColor == nil ? 0 : 8
        background.shadowOffset = CGSize(width: 0, height: -1)

        let horizontalPadding = max(10, fontSize * 0.36)
        let verticalPadding = max(8, fontSize * 0.22)
        label.string = text
        label.font = font
        label.fontSize = fontSize
        label.foregroundColor = textColor
        label.alignmentMode = .center
        label.isWrapped = true
        label.truncationMode = .end

        let insetBounds = container.bounds.insetBy(dx: horizontalPadding, dy: verticalPadding)
        let availableWidth = max(insetBounds.width, 1)
        let availableHeight = max(insetBounds.height, 1)
        let measuredHeight = measureTextHeight(text: text, font: font, maxWidth: availableWidth)
        let minHeight = max(fontSize * 1.15, 1)
        let labelHeight = min(availableHeight, max(minHeight, measuredHeight))
        let labelY = insetBounds.minY + max(0, (availableHeight - labelHeight) / 2)
        label.frame = CGRect(x: insetBounds.minX, y: labelY, width: availableWidth, height: labelHeight)
    }

    private func measureTextHeight(text: String, font: CTFont, maxWidth: CGFloat) -> CGFloat {
        guard maxWidth > 0 else { return ceil(CTFontGetSize(font) * 1.15) }
        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(rawValue: kCTFontAttributeName as String): font,
        ]
        let rect = NSString(string: text).boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attributes
        )
        return ceil(rect.height)
    }
}

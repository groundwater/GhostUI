import AppKit
import QuartzCore
import ScreenCaptureKit
import CoreImage

/// Retained primitive draw overlay runtime.
/// Primitive items with stable ids are updated in place across draw commands.
final class DrawOverlayService {
    static let shared = DrawOverlayService()
    private init() {}
    private static let spotlightEpsilon: CGFloat = 0.001

    private var activeContainer: CALayer?
    private var shapeLayersByKey: [String: CAShapeLayer] = [:]
    private var xrayLayersByKey: [String: CALayer] = [:]
    private var attachmentByKey: [String: String] = [:]
    private var xrayGenerationByKey: [String: Int] = [:]
    private var xrayCleanupWorkItemsByKey: [String: DispatchWorkItem] = [:]

    func playDraw(jsonData: Data) {
        DispatchQueue.main.async(execute: { [weak self] in
            guard let self else { return }

            let decoder = JSONDecoder()
            guard let payload = try? decoder.decode(DrawOverlayPayload.self, from: jsonData) else {
                NSLog("[DrawOverlayService] failed to decode draw payload")
                return
            }

            let attachmentId = payload.attachmentId ?? "global"
            if payload.closeAttachment == true {
                self.clearAttachment(attachmentId)
                return
            }

            guard payload.coordinateSpace == nil || payload.coordinateSpace == "screen" else {
                return
            }

            guard let root = OverlayWindowManager.shared.ensureRootLayer() else { return }
            let container = self.ensureContainer(root: root)

            guard !payload.items.isEmpty else {
                return
            }

            var orderedLayers: [(index: Int, layer: CALayer)] = []

            for (index, item) in payload.items.enumerated() {
                if item.remove == true {
                    if let id = item.id {
                        self.removeLayer(forKey: Self.persistentLayerKey(for: id))
                    }
                    continue
                }

                let resolvedStyle = item.resolvedStyle
                let finalPath: CGPath

                switch item.kind {
                case .rect:
                    guard let rect = item.rect else { continue }
                    let finalViewRect = OverlayWindowManager.shared.screenRectToView(rect.cgRect)
                    finalPath = Self.makeRectPath(for: finalViewRect, cornerRadius: resolvedStyle.cornerRadius ?? 8)
                case .line:
                    guard let line = item.line else { continue }
                    let fromView = OverlayWindowManager.shared.screenPointToView(line.from.cgPoint)
                    let toView = OverlayWindowManager.shared.screenPointToView(line.to.cgPoint)
                    finalPath = Self.makeLinePath(from: fromView, to: toView)
                case .spotlight:
                    guard let rects = item.rects, !rects.isEmpty else { continue }
                    let finalViewRects = rects.map { OverlayWindowManager.shared.screenRectToView($0.cgRect) }
                    finalPath = Self.makeSpotlightPath(
                        in: container.bounds,
                        cutouts: finalViewRects,
                        cornerRadius: resolvedStyle.cornerRadius ?? 18,
                        shape: item.spotlightShape
                    )
                case .marker:
                    guard let markerShape = item.markerShape, let markerRect = item.markerRect else { continue }
                    let markerStyle = item.resolvedMarkerStyle
                    let layerKey = Self.layerKey(for: item, attachmentId: attachmentId, index: index)
                    let (shape, isNewLayer) = self.resolveShapeLayer(forKey: layerKey, container: container)
                    self.attachmentByKey[layerKey] = attachmentId

                    let finalViewRect = OverlayWindowManager.shared.screenRectToView(markerRect.cgRect.insetBy(dx: -markerStyle.padding, dy: -markerStyle.padding))
                    finalPath = Self.makeMarkerPath(shape: markerShape, rect: finalViewRect, style: markerStyle, seed: Self.markerSeed(shape: markerShape, rect: finalViewRect, style: markerStyle))

                    if !isNewLayer {
                        shape.removeAllAnimations()
                    }

                    CATransaction.begin()
                    CATransaction.setDisableActions(true)
                    shape.frame = container.bounds
                    shape.path = finalPath
                    shape.strokeColor = markerStyle.color
                    shape.fillColor = nil
                    shape.lineWidth = markerStyle.size
                    shape.opacity = Float(markerStyle.opacity)
                    shape.lineJoin = .round
                    shape.lineCap = .round
                    shape.strokeStart = 0
                    shape.strokeEnd = 1
                    shape.lineDashPattern = nil
                    shape.miterLimit = 1
                    shape.allowsEdgeAntialiasing = true
                    shape.fillRule = .nonZero
                    CATransaction.commit()

                    let animation = item.animation ?? DrawOverlayAnimation(durMs: 260, ease: .easeOut)
                    let reveal = CABasicAnimation(keyPath: "strokeEnd")
                    reveal.fromValue = 0
                    reveal.toValue = 1
                    reveal.duration = animation.duration
                    reveal.timingFunction = animation.timingFunction
                    reveal.isRemovedOnCompletion = true
                    reveal.fillMode = .removed
                    shape.add(reveal, forKey: "markerReveal")

                    orderedLayers.append((index: index, layer: shape))
                    continue
                case .xray:
                    guard let rect = item.rect else { continue }
                    let layerKey = Self.layerKey(for: item, attachmentId: attachmentId, index: index)
                    let (xrayLayer, generation) = self.prepareXrayLayer(
                        forKey: layerKey,
                        attachmentId: attachmentId,
                        screenRect: rect.cgRect,
                        container: container
                    )
                    orderedLayers.append((index: index, layer: xrayLayer))
                    self.launchXrayCapture(
                        screenRect: rect.cgRect,
                        layerKey: layerKey,
                        attachmentId: attachmentId,
                        generation: generation,
                        container: container,
                        animation: item.animation,
                        direction: item.scanDirection
                    )
                    continue
                }

                let layerKey = Self.layerKey(for: item, attachmentId: attachmentId, index: index)
                let (shape, isNewLayer) = self.resolveShapeLayer(forKey: layerKey, container: container)
                self.attachmentByKey[layerKey] = attachmentId

                let startState = self.makeStartState(for: shape, item: item, resolvedStyle: resolvedStyle, finalPath: finalPath)

                if !isNewLayer {
                    shape.removeAllAnimations()
                }

                CATransaction.begin()
                CATransaction.setDisableActions(true)
                shape.frame = container.bounds
                shape.path = finalPath
                shape.strokeColor = resolvedStyle.strokeColor
                shape.lineWidth = resolvedStyle.lineWidth ?? 2
                shape.opacity = Float(resolvedStyle.opacity ?? 1)
                shape.lineJoin = .round
                shape.lineCap = .round
                shape.allowsEdgeAntialiasing = true

                switch item.kind {
                case .rect:
                    shape.fillColor = resolvedStyle.fillColor
                    shape.fillRule = .nonZero
                case .line:
                    shape.fillColor = nil
                    shape.fillRule = .nonZero
                case .spotlight:
                    shape.fillColor = resolvedStyle.fillColor
                    shape.strokeColor = nil
                    shape.lineWidth = 0
                    shape.fillRule = .evenOdd
                    shape.shadowColor = resolvedStyle.fillColor
                    shape.shadowOpacity = Float((resolvedStyle.blur ?? 0) > 0 ? 1 : 0)
                    shape.shadowRadius = resolvedStyle.blur ?? 0
                    shape.shadowOffset = .zero
                case .xray:
                    break
                case .marker:
                    break
                }

                CATransaction.commit()

                if let animation = item.animation {
                    self.applyAnimations(
                        to: shape,
                        start: startState,
                        end: resolvedStyle,
                        finalPath: finalPath,
                        animation: animation
                    )
                }

                orderedLayers.append((index: index, layer: shape))
            }

            self.reorder(container: container, layers: orderedLayers.sorted { $0.index < $1.index }.map(\.layer))
            self.pruneDetachedLayers()
        })
    }

    private func ensureContainer(root: CALayer) -> CALayer {
        if let container = activeContainer {
            container.frame = root.bounds
            if container.superlayer == nil {
                root.addSublayer(container)
            }
            return container
        }

        let container = CALayer()
        container.frame = root.bounds
        container.masksToBounds = false
        root.addSublayer(container)
        activeContainer = container
        return container
    }

    private func clearAttachment(_ attachmentId: String) {
        let keys = attachmentByKey.compactMap { key, owner in
            owner == attachmentId ? key : nil
        }
        for key in keys {
            removeLayer(forKey: key)
        }
    }

    private func removeLayer(forKey key: String) {
        if let existing = shapeLayersByKey.removeValue(forKey: key) {
            existing.removeAllAnimations()
            existing.removeFromSuperlayer()
        }
        if xrayLayersByKey[key] != nil {
            _ = bumpXrayGeneration(forKey: key)
            removeXrayLayer(forKey: key)
        }
        attachmentByKey.removeValue(forKey: key)
    }

    private func resolveShapeLayer(
        forKey key: String,
        container: CALayer
    ) -> (CAShapeLayer, Bool) {
        if let layer = shapeLayersByKey[key] {
            return (layer, false)
        }

        let layer = CAShapeLayer()
        layer.frame = container.bounds

        shapeLayersByKey[key] = layer

        return (layer, true)
    }

    private func reorder(container: CALayer, layers: [CALayer]) {
        guard !layers.isEmpty else { return }

        for layer in layers {
            if layer.superlayer === container {
                layer.removeFromSuperlayer()
            }
            container.addSublayer(layer)
        }
    }

    private func pruneDetachedLayers() {
        guard let container = activeContainer else { return }

        shapeLayersByKey = shapeLayersByKey.filter { $0.value.superlayer === container }
        xrayLayersByKey = xrayLayersByKey.filter { $0.value.superlayer === container }
        xrayCleanupWorkItemsByKey = xrayCleanupWorkItemsByKey.filter { xrayLayersByKey[$0.key] != nil }
        attachmentByKey = attachmentByKey.filter {
            shapeLayersByKey[$0.key] != nil || xrayLayersByKey[$0.key] != nil
        }
    }

    private static func layerKey(for item: DrawOverlayItem, attachmentId: String, index: Int) -> String {
        if let id = item.id {
            return persistentLayerKey(for: id)
        }
        return "attachment:\(attachmentId):\(index)"
    }

    private static func persistentLayerKey(for id: String) -> String {
        "id:\(id)"
    }

    private func makeStartState(
        for shape: CAShapeLayer,
        item: DrawOverlayItem,
        resolvedStyle: DrawOverlayStyle,
        finalPath: CGPath
    ) -> DrawOverlayRenderState {
        switch item.kind {
        case .rect:
            if let fromRect = item.from?.rect {
                let fromViewRect = OverlayWindowManager.shared.screenRectToView(fromRect.cgRect)
                let fromCornerRadius = item.from?.cornerRadius ?? resolvedStyle.cornerRadius ?? 8
                let fromPath = Self.makeRectPath(for: fromViewRect, cornerRadius: fromCornerRadius)
                let presentation = shape.presentation()
                return DrawOverlayRenderState(
                    path: fromPath,
                    strokeColor: item.from?.strokeColor ?? presentation?.strokeColor ?? shape.strokeColor,
                    fillColor: item.from?.fillColor ?? presentation?.fillColor ?? shape.fillColor,
                    lineWidth: item.from?.lineWidth ?? shape.lineWidth,
                    opacity: item.from?.opacity.map(Float.init) ?? shape.opacity,
                    shadowColor: shape.shadowColor,
                    shadowOpacity: shape.shadowOpacity,
                    shadowRadius: shape.shadowRadius
                )
            }
        case .line:
            if let fromLine = item.from?.line {
                let fromView = OverlayWindowManager.shared.screenPointToView(fromLine.from.cgPoint)
                let toView = OverlayWindowManager.shared.screenPointToView(fromLine.to.cgPoint)
                let fromPath = Self.makeLinePath(from: fromView, to: toView)
                let presentation = shape.presentation()
                return DrawOverlayRenderState(
                    path: fromPath,
                    strokeColor: item.from?.strokeColor ?? presentation?.strokeColor ?? shape.strokeColor,
                    fillColor: nil,
                    lineWidth: item.from?.lineWidth ?? shape.lineWidth,
                    opacity: item.from?.opacity.map(Float.init) ?? shape.opacity,
                    shadowColor: shape.shadowColor,
                    shadowOpacity: shape.shadowOpacity,
                    shadowRadius: shape.shadowRadius
                )
            }
        case .xray:
            break // xray items are handled separately via launchXrayCapture
        case .spotlight:
            break
        case .marker:
            break
        }

        if let presentation = shape.presentation() {
            return DrawOverlayRenderState(
                path: presentation.path ?? shape.path ?? finalPath,
                strokeColor: presentation.strokeColor ?? shape.strokeColor,
                fillColor: presentation.fillColor ?? shape.fillColor,
                lineWidth: presentation.lineWidth,
                opacity: presentation.opacity,
                shadowColor: presentation.shadowColor ?? shape.shadowColor,
                shadowOpacity: presentation.shadowOpacity,
                shadowRadius: presentation.shadowRadius
            )
        }

        return DrawOverlayRenderState(
            path: shape.path ?? finalPath,
            strokeColor: shape.strokeColor,
            fillColor: shape.fillColor,
            lineWidth: shape.lineWidth,
            opacity: shape.opacity,
            shadowColor: shape.shadowColor,
            shadowOpacity: shape.shadowOpacity,
            shadowRadius: shape.shadowRadius
        )
    }

    private func applyAnimations(
        to shape: CAShapeLayer,
        start: DrawOverlayRenderState,
        end: DrawOverlayStyle,
        finalPath: CGPath,
        animation: DrawOverlayAnimation
    ) {
        var animations: [CAAnimation] = []
        let endLineWidth = end.lineWidth ?? start.lineWidth
        let endOpacity = end.opacity.map(Float.init) ?? start.opacity
        let endShadowOpacity: Float = end.blur == nil || (end.blur ?? 0) <= 0 ? 0 : 1
        let endShadowRadius = end.blur ?? start.shadowRadius
        let endShadowColor = end.fillColor ?? start.shadowColor

        if let startPath = start.path, !Self.pathsEqual(startPath, finalPath) {
            let pathAnimation = CABasicAnimation(keyPath: "path")
            pathAnimation.fromValue = startPath
            pathAnimation.toValue = finalPath
            pathAnimation.duration = animation.duration
            pathAnimation.timingFunction = animation.timingFunction
            animations.append(pathAnimation)
        }

        if let startStroke = start.strokeColor, let endStroke = end.strokeColor, !Self.colorsEqual(startStroke, endStroke) {
            let strokeAnimation = CABasicAnimation(keyPath: "strokeColor")
            strokeAnimation.fromValue = startStroke
            strokeAnimation.toValue = endStroke
            strokeAnimation.duration = animation.duration
            strokeAnimation.timingFunction = animation.timingFunction
            animations.append(strokeAnimation)
        }

        if let startFill = start.fillColor, let endFill = end.fillColor, !Self.colorsEqual(startFill, endFill) {
            let fillAnimation = CABasicAnimation(keyPath: "fillColor")
            fillAnimation.fromValue = startFill
            fillAnimation.toValue = endFill
            fillAnimation.duration = animation.duration
            fillAnimation.timingFunction = animation.timingFunction
            animations.append(fillAnimation)
        }

        if start.lineWidth != endLineWidth {
            let lineWidthAnimation = CABasicAnimation(keyPath: "lineWidth")
            lineWidthAnimation.fromValue = start.lineWidth
            lineWidthAnimation.toValue = endLineWidth
            lineWidthAnimation.duration = animation.duration
            lineWidthAnimation.timingFunction = animation.timingFunction
            animations.append(lineWidthAnimation)
        }

        if start.opacity != endOpacity {
            let opacityAnimation = CABasicAnimation(keyPath: "opacity")
            opacityAnimation.fromValue = start.opacity
            opacityAnimation.toValue = endOpacity
            opacityAnimation.duration = animation.duration
            opacityAnimation.timingFunction = animation.timingFunction
            animations.append(opacityAnimation)
        }

        if start.shadowOpacity != endShadowOpacity {
            let shadowOpacityAnimation = CABasicAnimation(keyPath: "shadowOpacity")
            shadowOpacityAnimation.fromValue = start.shadowOpacity
            shadowOpacityAnimation.toValue = endShadowOpacity
            shadowOpacityAnimation.duration = animation.duration
            shadowOpacityAnimation.timingFunction = animation.timingFunction
            animations.append(shadowOpacityAnimation)
        }

        if start.shadowRadius != endShadowRadius {
            let shadowRadiusAnimation = CABasicAnimation(keyPath: "shadowRadius")
            shadowRadiusAnimation.fromValue = start.shadowRadius
            shadowRadiusAnimation.toValue = endShadowRadius
            shadowRadiusAnimation.duration = animation.duration
            shadowRadiusAnimation.timingFunction = animation.timingFunction
            animations.append(shadowRadiusAnimation)
        }

        if let startShadow = start.shadowColor, let endShadow = endShadowColor, !Self.colorsEqual(startShadow, endShadow) {
            let shadowColorAnimation = CABasicAnimation(keyPath: "shadowColor")
            shadowColorAnimation.fromValue = startShadow
            shadowColorAnimation.toValue = endShadow
            shadowColorAnimation.duration = animation.duration
            shadowColorAnimation.timingFunction = animation.timingFunction
            animations.append(shadowColorAnimation)
        }

        guard !animations.isEmpty else {
            return
        }

        let group = CAAnimationGroup()
        group.animations = animations
        group.duration = animation.duration
        group.timingFunction = animation.timingFunction
        group.isRemovedOnCompletion = true
        group.fillMode = .removed
        shape.add(group, forKey: "drawUpdate")
    }

    private static func makeRectPath(for rect: CGRect, cornerRadius: CGFloat) -> CGPath {
        if cornerRadius <= 0 {
            return CGPath(rect: rect, transform: nil)
        }
        return CGPath(roundedRect: rect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
    }

    private static func makeLinePath(from: CGPoint, to: CGPoint) -> CGPath {
        let path = CGMutablePath()
        path.move(to: from)
        path.addLine(to: to)
        return path
    }

    private static func makeMarkerPath(
        shape: DrawOverlayMarkerShape,
        rect: CGRect,
        style: DrawOverlayMarkerStyle,
        seed: UInt64
    ) -> CGPath {
        var random = StableRandom(seed: seed)
        let path = CGMutablePath()

        switch shape {
        case .rect:
            addRoughClosedPath(path, points: markerRectanglePoints(in: rect, style: style, random: &random))
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

    private static func markerSeed(shape: DrawOverlayMarkerShape, rect: CGRect, style: DrawOverlayMarkerStyle) -> UInt64 {
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

    private static func markerRectanglePoints(in rect: CGRect, style: DrawOverlayMarkerStyle, random: inout StableRandom) -> [CGPoint] {
        let jitter = markerJitter(in: rect, style: style)
        let anchorJitterX = max(rect.width * 0.05, jitter * (0.75 + style.roughness * 0.45))
        let anchorJitterY = max(rect.height * 0.05, jitter * (0.75 + style.roughness * 0.45))
        return [
            CGPoint(
                x: rect.minX + random.uniform(-anchorJitterX, anchorJitterX),
                y: rect.minY + random.uniform(-anchorJitterY, anchorJitterY)
            ),
            CGPoint(
                x: rect.maxX + random.uniform(-anchorJitterX, anchorJitterX),
                y: rect.minY + random.uniform(-anchorJitterY, anchorJitterY)
            ),
            CGPoint(
                x: rect.maxX + random.uniform(-anchorJitterX, anchorJitterX),
                y: rect.maxY + random.uniform(-anchorJitterY, anchorJitterY)
            ),
            CGPoint(
                x: rect.minX + random.uniform(-anchorJitterX, anchorJitterX),
                y: rect.maxY + random.uniform(-anchorJitterY, anchorJitterY)
            ),
        ]
    }

    private static func markerCirclePoints(in rect: CGRect, style: DrawOverlayMarkerStyle, random: inout StableRandom) -> [CGPoint] {
        let jitter = markerJitter(in: rect, style: style)
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radiusX = max(rect.width * 0.5, style.size)
        let radiusY = max(rect.height * 0.5, style.size)
        let pointCount = min(28, max(12, Int((max(rect.width, rect.height) / max(style.size * 1.5, 1)).rounded(.up))))

        var result: [CGPoint] = []
        for index in 0..<pointCount {
            let progress = CGFloat(index) / CGFloat(pointCount)
            let angle = (progress * 2 * .pi) - (.pi / 2)
            let radialJitter = random.uniform(-jitter, jitter) * (0.4 + style.roughness * 0.6)
            result.append(
                CGPoint(
                    x: center.x + cos(angle) * (radiusX + radialJitter),
                    y: center.y + sin(angle) * (radiusY + radialJitter)
                )
            )
        }
        return result
    }

    private static func markerCheckPoints(in rect: CGRect, style: DrawOverlayMarkerStyle, random: inout StableRandom) -> [[CGPoint]] {
        let jitter = markerJitter(in: rect, style: style)
        let start1 = CGPoint(
            x: rect.minX + rect.width * 0.20 + random.uniform(-jitter, jitter) * 0.4,
            y: rect.minY + rect.height * 0.55 + random.uniform(-jitter, jitter) * 0.4
        )
        let end1 = CGPoint(
            x: rect.minX + rect.width * 0.42 + random.uniform(-jitter, jitter) * 0.4,
            y: rect.maxY - rect.height * 0.10 + random.uniform(-jitter, jitter) * 0.4
        )
        let start2 = CGPoint(
            x: rect.minX + rect.width * 0.40 + random.uniform(-jitter, jitter) * 0.45,
            y: rect.maxY - rect.height * 0.15 + random.uniform(-jitter, jitter) * 0.45
        )
        let end2 = CGPoint(
            x: rect.maxX - rect.width * 0.12 + random.uniform(-jitter, jitter) * 0.45,
            y: rect.minY + rect.height * 0.18 + random.uniform(-jitter, jitter) * 0.45
        )
        return [
            roughStrokePoints(from: start1, to: end1, style: style, random: &random),
            roughStrokePoints(from: start2, to: end2, style: style, random: &random),
        ]
    }

    private static func markerCrossPoints(in rect: CGRect, style: DrawOverlayMarkerStyle, random: inout StableRandom) -> [[CGPoint]] {
        let jitter = markerJitter(in: rect, style: style)
        let firstStart = CGPoint(
            x: rect.minX + rect.width * 0.12 + random.uniform(-jitter, jitter) * 0.5,
            y: rect.minY + rect.height * 0.16 + random.uniform(-jitter, jitter) * 0.5
        )
        let firstEnd = CGPoint(
            x: rect.maxX - rect.width * 0.10 + random.uniform(-jitter, jitter) * 0.5,
            y: rect.maxY - rect.height * 0.12 + random.uniform(-jitter, jitter) * 0.5
        )
        let secondStart = CGPoint(
            x: rect.maxX - rect.width * 0.12 + random.uniform(-jitter, jitter) * 0.5,
            y: rect.minY + rect.height * 0.18 + random.uniform(-jitter, jitter) * 0.5
        )
        let secondEnd = CGPoint(
            x: rect.minX + rect.width * 0.10 + random.uniform(-jitter, jitter) * 0.5,
            y: rect.maxY - rect.height * 0.10 + random.uniform(-jitter, jitter) * 0.5
        )
        return [
            roughStrokePoints(from: firstStart, to: firstEnd, style: style, random: &random),
            roughStrokePoints(from: secondStart, to: secondEnd, style: style, random: &random),
        ]
    }

    private static func markerUnderlinePoints(in rect: CGRect, style: DrawOverlayMarkerStyle, random: inout StableRandom) -> [CGPoint] {
        let jitter = markerJitter(in: rect, style: style)
        let yBase = rect.maxY - max(style.size * 0.55, rect.height * 0.08)
        let start = CGPoint(
            x: rect.minX - style.size * 0.35,
            y: yBase + random.uniform(-jitter, jitter) * 0.2
        )
        let end = CGPoint(
            x: rect.maxX + style.size * 0.35,
            y: yBase + random.uniform(-jitter, jitter) * 0.2
        )
        return roughStrokePoints(from: start, to: end, style: style, random: &random)
    }

    private static func roughStrokePoints(
        from start: CGPoint,
        to end: CGPoint,
        style: DrawOverlayMarkerStyle,
        random: inout StableRandom
    ) -> [CGPoint] {
        let delta = CGPoint(x: end.x - start.x, y: end.y - start.y)
        let length = max(hypot(delta.x, delta.y), 1)
        let tangent = CGPoint(x: delta.x / length, y: delta.y / length)
        let normal = CGPoint(x: -tangent.y, y: tangent.x)
        let jitter = markerJitter(length: length, style: style)
        let drift = jitter * (0.35 + style.roughness * 0.35)

        let startPoint = CGPoint(
            x: start.x + tangent.x * random.uniform(-style.size * 0.28, style.size * 0.24) + normal.x * random.uniform(-drift, drift),
            y: start.y + tangent.y * random.uniform(-style.size * 0.28, style.size * 0.24) + normal.y * random.uniform(-drift, drift)
        )
        let mid1 = CGPoint(
            x: start.x + delta.x * 0.33 + normal.x * random.uniform(-jitter, jitter) + tangent.x * random.uniform(-jitter * 0.12, jitter * 0.12),
            y: start.y + delta.y * 0.33 + normal.y * random.uniform(-jitter, jitter) + tangent.y * random.uniform(-jitter * 0.12, jitter * 0.12)
        )
        let mid2 = CGPoint(
            x: start.x + delta.x * 0.68 + normal.x * random.uniform(-jitter, jitter) + tangent.x * random.uniform(-jitter * 0.12, jitter * 0.12),
            y: start.y + delta.y * 0.68 + normal.y * random.uniform(-jitter, jitter) + tangent.y * random.uniform(-jitter * 0.12, jitter * 0.12)
        )
        let endPoint = CGPoint(
            x: end.x + tangent.x * random.uniform(-style.size * 0.18, style.size * 0.32) + normal.x * random.uniform(-drift, drift),
            y: end.y + tangent.y * random.uniform(-style.size * 0.18, style.size * 0.32) + normal.y * random.uniform(-drift, drift)
        )

        return [startPoint, mid1, mid2, endPoint]
    }

    private static func markerJitter(in rect: CGRect, style: DrawOverlayMarkerStyle) -> CGFloat {
        let base = max(style.size * (0.08 + style.roughness * 0.45), 0.35)
        let rectScale = max(1, min(rect.width, rect.height) * 0.035)
        return min(rectScale, max(base, style.size * 0.1))
    }

    private static func markerJitter(length: CGFloat, style: DrawOverlayMarkerStyle) -> CGFloat {
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

    fileprivate static func makeSpotlightPath(in bounds: CGRect, cutouts: [CGRect], cornerRadius: CGFloat, shape: DrawOverlaySpotlightShape?) -> CGPath {
        let path = CGMutablePath()
        path.addRect(bounds)
        let spotlightShape = shape ?? .rect
        let cutoutRects: [CGRect]
        switch spotlightShape {
        case .rect:
            let coalescedCutouts = coalescedSpotlightCutouts(cutouts)
            let usesRoundedCutouts = coalescedCutouts.count == cutouts.count
            cutoutRects = coalescedCutouts
            for cutout in cutoutRects {
                path.addPath(makeRectPath(for: cutout, cornerRadius: usesRoundedCutouts ? cornerRadius : 0))
            }
        case .circ:
            cutoutRects = cutouts.map(\.standardized).filter { $0.width > 0 && $0.height > 0 }
            for cutout in cutoutRects {
                path.addEllipse(in: cutout)
            }
        }
        return path
    }

    static func coalescedSpotlightCutouts(_ cutouts: [CGRect]) -> [CGRect] {
        let normalized = cutouts
            .map(\.standardized)
            .filter { $0.width > 0 && $0.height > 0 }
            .sorted {
                if !approximatelyEqual($0.minY, $1.minY) {
                    return $0.minY < $1.minY
                }
                if !approximatelyEqual($0.maxY, $1.maxY) {
                    return $0.maxY < $1.maxY
                }
                return $0.minX < $1.minX
            }
        guard normalized.count > 1 else {
            return normalized
        }

        let ys = Array(Set(normalized.flatMap { [$0.minY, $0.maxY] })).sorted()
        guard ys.count > 1 else {
            return normalized
        }

        var coalesced: [CGRect] = []
        for index in 0..<(ys.count - 1) {
            let minY = ys[index]
            let maxY = ys[index + 1]
            let height = maxY - minY
            if height <= 0 {
                continue
            }

            let intervals = mergedIntervals(
                normalized.compactMap { rect -> ClosedRange<CGFloat>? in
                    guard rect.maxY > minY + spotlightEpsilon && rect.minY < maxY - spotlightEpsilon else {
                        return nil
                    }
                    return rect.minX...rect.maxX
                }
            )

            for interval in intervals {
                let rect = CGRect(
                    x: interval.lowerBound,
                    y: minY,
                    width: interval.upperBound - interval.lowerBound,
                    height: height
                )
                if var last = coalesced.last,
                   approximatelyEqual(last.minX, rect.minX),
                   approximatelyEqual(last.maxX, rect.maxX),
                   approximatelyEqual(last.maxY, rect.minY) {
                    last.size.height += rect.height
                    coalesced[coalesced.count - 1] = last
                } else {
                    coalesced.append(rect)
                }
            }
        }

        return coalesced
    }

    private static func mergedIntervals(_ intervals: [ClosedRange<CGFloat>]) -> [ClosedRange<CGFloat>] {
        let sorted = intervals.sorted { lhs, rhs in
            if !approximatelyEqual(lhs.lowerBound, rhs.lowerBound) {
                return lhs.lowerBound < rhs.lowerBound
            }
            return lhs.upperBound < rhs.upperBound
        }
        guard var current = sorted.first else {
            return []
        }

        var merged: [ClosedRange<CGFloat>] = []
        for interval in sorted.dropFirst() {
            if interval.lowerBound <= current.upperBound + spotlightEpsilon {
                current = current.lowerBound...max(current.upperBound, interval.upperBound)
            } else {
                merged.append(current)
                current = interval
            }
        }
        merged.append(current)
        return merged
    }

    private static func approximatelyEqual(_ lhs: CGFloat, _ rhs: CGFloat) -> Bool {
        abs(lhs - rhs) <= spotlightEpsilon
    }

    private static func pathsEqual(_ lhs: CGPath, _ rhs: CGPath) -> Bool {
        pathSignature(lhs) == pathSignature(rhs)
    }

    private static func colorsEqual(_ lhs: CGColor, _ rhs: CGColor) -> Bool {
        lhs == rhs
    }

    private static func pathSignature(_ path: CGPath) -> String {
        var parts: [String] = []
        path.applyWithBlock { elementPointer in
            let element = elementPointer.pointee
            switch element.type {
            case .moveToPoint:
                parts.append("M:\(Self.format(element.points[0]))")
            case .addLineToPoint:
                parts.append("L:\(Self.format(element.points[0]))")
            case .addQuadCurveToPoint:
                parts.append("Q:\(Self.format(element.points[0]))|\(Self.format(element.points[1]))")
            case .addCurveToPoint:
                parts.append("C:\(Self.format(element.points[0]))|\(Self.format(element.points[1]))|\(Self.format(element.points[2]))")
            case .closeSubpath:
                parts.append("Z")
            @unknown default:
                break
            }
        }
        return parts.joined(separator: ";")
    }

    private static func format(_ point: CGPoint) -> String {
        String(format: "%.2f,%.2f", point.x, point.y)
    }

    // MARK: - Xray capture + render

    private func launchXrayCapture(
        screenRect: CGRect,
        layerKey: String,
        attachmentId: String,
        generation: Int,
        container: CALayer,
        animation: DrawOverlayAnimation?,
        direction: DrawOverlayScanDirection
    ) {
        // CALayer is not Sendable, but we only touch it on MainActor.
        nonisolated(unsafe) let safeContainer = container
        Task {
            do {
                let image = try await Self.captureAndInvert(screenRect: screenRect)
                await MainActor.run {
                    guard self.isCurrentXrayGeneration(generation, forKey: layerKey, attachmentId: attachmentId) else {
                        return
                    }
                    self.renderXrayLayer(
                        image: image,
                        screenRect: screenRect,
                        layerKey: layerKey,
                        attachmentId: attachmentId,
                        generation: generation,
                        container: safeContainer,
                        animation: animation,
                        direction: direction
                    )
                }
            } catch {
                NSLog("[DrawOverlayService] xray capture failed: \(error)")
            }
        }
    }

    private static func captureAndInvert(screenRect: CGRect) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw NSError(domain: "DrawOverlay", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        // Exclude the GhostUI overlay window itself from capture
        let excludedWindows = content.windows.filter { $0.owningApplication?.bundleIdentifier == Bundle.main.bundleIdentifier }

        let filter = SCContentFilter(display: display, excludingWindows: excludedWindows)
        let config = SCStreamConfiguration()
        config.sourceRect = screenRect
        let displayWidth = CGFloat(display.width)
        let frameWidth = display.frame.width
        let scaleFactor = (displayWidth.isFinite && frameWidth.isFinite && frameWidth > 0 && displayWidth > 0)
            ? displayWidth / frameWidth
            : 1

        let pixelWidth = Self.pixelDimension(for: screenRect.width, scaleFactor: scaleFactor)
        let pixelHeight = Self.pixelDimension(for: screenRect.height, scaleFactor: scaleFactor)
        guard pixelWidth > 0, pixelHeight > 0 else {
            throw NSError(domain: "DrawOverlay", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid xray capture dimensions"])
        }

        config.width = pixelWidth
        config.height = pixelHeight
        config.showsCursor = false

        let captured = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)

        // Invert via Core Image
        let ciImage = CIImage(cgImage: captured)
        guard let inverted = ciImage.applyingFilter("CIColorInvert") as CIImage? else {
            throw NSError(domain: "DrawOverlay", code: 2, userInfo: [NSLocalizedDescriptionKey: "CIColorInvert failed"])
        }
        let context = CIContext()
        guard let result = context.createCGImage(inverted, from: inverted.extent) else {
            throw NSError(domain: "DrawOverlay", code: 3, userInfo: [NSLocalizedDescriptionKey: "CGImage creation failed"])
        }
        return result
    }

    private func renderXrayLayer(
        image: CGImage,
        screenRect: CGRect,
        layerKey: String,
        attachmentId: String,
        generation: Int,
        container: CALayer,
        animation: DrawOverlayAnimation?,
        direction: DrawOverlayScanDirection
    ) {
        guard self.isCurrentXrayGeneration(self.xrayGenerationByKey[layerKey] ?? 0, forKey: layerKey, attachmentId: attachmentId) else {
            return
        }

        let viewRect = OverlayWindowManager.shared.screenRectToView(screenRect)

        guard let layer = xrayLayersByKey[layerKey] else {
            return
        }

        layer.removeAllAnimations()
        layer.mask?.removeAllAnimations()

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.frame = viewRect
        layer.contents = image
        layer.opacity = 1
        layer.contentsGravity = .resizeAspectFill
        layer.cornerRadius = 0
        layer.masksToBounds = true
        layer.borderColor = nil
        layer.borderWidth = 0
        CATransaction.commit()

        // Animated scan band sweep: reveal a thick directional band with falloff.
        let anim = animation ?? DrawOverlayAnimation(durMs: 400, ease: .easeInOut)
        let maskLayer = Self.makeScanBandMask(for: layer, direction: direction)
        layer.mask = maskLayer
        Self.animateScanBand(maskLayer, in: layer.bounds, direction: direction, animation: anim)
        self.scheduleXrayCleanup(
            forKey: layerKey,
            attachmentId: attachmentId,
            generation: generation,
            after: anim.duration
        )
    }

    /// Override cleanup to also clear xray layers
    private func removeXrayLayer(forKey key: String) {
        cancelXrayCleanupWorkItem(forKey: key)
        if let layer = xrayLayersByKey.removeValue(forKey: key) {
            layer.removeAllAnimations()
            layer.mask?.removeAllAnimations()
            layer.mask = nil
            layer.removeFromSuperlayer()
        }
        xrayCleanupWorkItemsByKey.removeValue(forKey: key)
        attachmentByKey.removeValue(forKey: key)
    }

    private func prepareXrayLayer(
        forKey key: String,
        attachmentId: String,
        screenRect: CGRect,
        container: CALayer
    ) -> (CALayer, Int) {
        let generation = bumpXrayGeneration(forKey: key)
        let viewRect = OverlayWindowManager.shared.screenRectToView(screenRect)
        let layer = xrayLayersByKey[key] ?? CALayer()

        layer.removeAllAnimations()
        layer.mask?.removeAllAnimations()

        if layer.superlayer !== container {
            layer.removeFromSuperlayer()
            container.addSublayer(layer)
        }

        xrayLayersByKey[key] = layer
        attachmentByKey[key] = attachmentId
        cancelXrayCleanupWorkItem(forKey: key)

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.frame = viewRect
        layer.contents = nil
        layer.mask = nil
        layer.opacity = 0
        layer.masksToBounds = true
        layer.cornerRadius = 0
        layer.borderColor = nil
        layer.borderWidth = 0
        CATransaction.commit()

        return (layer, generation)
    }

    private func scheduleXrayCleanup(
        forKey key: String,
        attachmentId: String,
        generation: Int,
        after delay: CFTimeInterval
    ) {
        let cleanupDelay = max(delay, 0)
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard self.isCurrentXrayGeneration(generation, forKey: key, attachmentId: attachmentId) else {
                return
            }
            self.removeXrayLayer(forKey: key)
        }
        xrayCleanupWorkItemsByKey[key] = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + cleanupDelay, execute: workItem)
    }

    private func cancelXrayCleanupWorkItem(forKey key: String) {
        xrayCleanupWorkItemsByKey[key]?.cancel()
        xrayCleanupWorkItemsByKey.removeValue(forKey: key)
    }

    private func bumpXrayGeneration(forKey key: String) -> Int {
        let next = (xrayGenerationByKey[key] ?? 0) + 1
        xrayGenerationByKey[key] = next
        return next
    }

    private func isCurrentXrayGeneration(_ generation: Int, forKey key: String, attachmentId: String) -> Bool {
        guard attachmentByKey[key] == attachmentId else {
            return false
        }
        return xrayGenerationByKey[key] == generation
    }

    private static func makeScanBandMask(for layer: CALayer, direction: DrawOverlayScanDirection) -> CAGradientLayer {
        let maskLayer = CAGradientLayer()
        if direction.isHorizontal {
            let bandWidth = max(72, min(max(layer.bounds.width, 1) * 0.34, 220))
            maskLayer.bounds = CGRect(x: 0, y: 0, width: bandWidth, height: layer.bounds.height)
            maskLayer.position = CGPoint(x: -bandWidth * 0.5, y: layer.bounds.midY)
            maskLayer.startPoint = CGPoint(x: 0, y: 0.5)
            maskLayer.endPoint = CGPoint(x: 1, y: 0.5)
        } else {
            let bandHeight = max(72, min(max(layer.bounds.height, 1) * 0.34, 220))
            maskLayer.bounds = CGRect(x: 0, y: 0, width: layer.bounds.width, height: bandHeight)
            maskLayer.position = CGPoint(x: layer.bounds.midX, y: -bandHeight * 0.5)
            maskLayer.startPoint = CGPoint(x: 0.5, y: 0)
            maskLayer.endPoint = CGPoint(x: 0.5, y: 1)
        }
        maskLayer.colors = [
            CGColor(red: 1, green: 1, blue: 1, alpha: 0.0),
            CGColor(red: 1, green: 1, blue: 1, alpha: 0.15),
            CGColor(red: 1, green: 1, blue: 1, alpha: 0.95),
            CGColor(red: 1, green: 1, blue: 1, alpha: 0.15),
            CGColor(red: 1, green: 1, blue: 1, alpha: 0.0),
        ]
        maskLayer.locations = [0.0, 0.2, 0.5, 0.8, 1.0]
        return maskLayer
    }

    private static func animateScanBand(
        _ maskLayer: CAGradientLayer,
        in bounds: CGRect,
        direction: DrawOverlayScanDirection,
        animation: DrawOverlayAnimation
    ) {
        let sweepAnimation: CABasicAnimation
        if direction.isHorizontal {
            let bandWidth = maskLayer.bounds.width
            let startX = direction == .leftToRight ? -bandWidth * 0.5 : bounds.width + bandWidth * 0.5
            let endX = direction == .leftToRight ? bounds.width + bandWidth * 0.5 : -bandWidth * 0.5

            CATransaction.begin()
            CATransaction.setDisableActions(true)
            maskLayer.position = CGPoint(x: endX, y: bounds.midY)
            CATransaction.commit()

            sweepAnimation = CABasicAnimation(keyPath: "position.x")
            sweepAnimation.fromValue = startX
            sweepAnimation.toValue = endX
        } else {
            let bandHeight = maskLayer.bounds.height
            let startY = direction == .topToBottom ? -bandHeight * 0.5 : bounds.height + bandHeight * 0.5
            let endY = direction == .topToBottom ? bounds.height + bandHeight * 0.5 : -bandHeight * 0.5

            CATransaction.begin()
            CATransaction.setDisableActions(true)
            maskLayer.position = CGPoint(x: bounds.midX, y: endY)
            CATransaction.commit()

            sweepAnimation = CABasicAnimation(keyPath: "position.y")
            sweepAnimation.fromValue = startY
            sweepAnimation.toValue = endY
        }
        sweepAnimation.duration = animation.duration
        sweepAnimation.timingFunction = animation.timingFunction
        sweepAnimation.isRemovedOnCompletion = true
        sweepAnimation.fillMode = .removed
        maskLayer.add(sweepAnimation, forKey: "xraySweep")
    }

    private static func pixelDimension(for value: CGFloat, scaleFactor: CGFloat) -> Int {
        guard value.isFinite, scaleFactor.isFinite, value > 0, scaleFactor > 0 else {
            return 0
        }

        let scaled = value * scaleFactor
        guard scaled.isFinite, scaled > 0 else {
            return 0
        }

        return Int(scaled.rounded(.toNearestOrAwayFromZero))
    }
}

private struct DrawOverlayPayload: Decodable {
    let attachmentId: String?
    let closeAttachment: Bool?
    let coordinateSpace: String?
    let items: [DrawOverlayItem]
}

private struct DrawOverlayItem: Decodable {
    let id: String?
    let kind: DrawOverlayKind
    let remove: Bool?
    let rect: DrawOverlayRect?
    let box: DrawOverlayRect?
    let rects: [DrawOverlayRect]?
    let line: DrawOverlayLine?
    let direction: String?
    let shape: String?
    let from: DrawOverlayItemFrom?
    let animation: DrawOverlayAnimation?
    let style: DrawOverlayStyle?
}

private extension DrawOverlayItem {
    var resolvedStyle: DrawOverlayStyle {
        switch kind {
        case .rect:
            return style ?? .defaultRectStyle
        case .line:
            return style ?? .defaultLineStyle
        case .xray:
            return style ?? .defaultLineStyle
        case .spotlight:
            return style ?? .defaultSpotlightStyle
        case .marker:
            return style ?? .defaultMarkerStyle
        }
    }

    var spotlightShape: DrawOverlaySpotlightShape? {
        guard kind == .spotlight else {
            return nil
        }
        let raw = shape?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch raw {
        case nil, "":
            return .rect
        case "rect":
            return .rect
        case "circ", "circle":
            return .circ
        default:
            return nil
        }
    }

    var markerShape: DrawOverlayMarkerShape? {
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

    var markerRect: DrawOverlayRect? {
        rect ?? box
    }

    var resolvedMarkerStyle: DrawOverlayMarkerStyle {
        let source = style ?? .defaultMarkerStyle
        let defaultMarkerColor = DrawOverlayStyle.defaultMarkerStyle.markerColor ?? CGColor(red: 0, green: 0.89, blue: 1, alpha: 1)
        let defaultMarkerSize = DrawOverlayStyle.defaultMarkerStyle.size ?? 4
        let defaultMarkerPadding = DrawOverlayStyle.defaultMarkerStyle.padding ?? 8
        let defaultMarkerRoughness = DrawOverlayStyle.defaultMarkerStyle.roughness ?? 0.22
        let defaultMarkerOpacity = DrawOverlayStyle.defaultMarkerStyle.opacity ?? 1
        let color = source.color.flatMap(DrawOverlayStyle.parseColor)
            ?? source.stroke.flatMap(DrawOverlayStyle.parseColor)
            ?? source.fill.flatMap(DrawOverlayStyle.parseColor)
            ?? defaultMarkerColor
        let size = max(0.5, source.size ?? defaultMarkerSize)
        let padding = max(0, source.padding ?? defaultMarkerPadding)
        let roughness = min(max(source.roughness ?? defaultMarkerRoughness, 0), 1)
        let opacity = min(max(source.opacity ?? defaultMarkerOpacity, 0), 1)
        return DrawOverlayMarkerStyle(color: color, size: size, padding: padding, roughness: roughness, opacity: opacity)
    }

    var scanDirection: DrawOverlayScanDirection {
        guard kind == .xray else {
            return .leftToRight
        }
        return direction.flatMap(DrawOverlayScanDirection.init(rawValue:)) ?? .leftToRight
    }
}

private struct DrawOverlayItemFrom: Decodable {
    // rect from
    let rect: DrawOverlayRect?
    let cornerRadius: CGFloat?
    let stroke: String?
    let fill: String?
    let lineWidth: CGFloat?
    let opacity: CGFloat?
    // line from
    let line: DrawOverlayLine?

    var strokeColor: CGColor? {
        stroke.flatMap(DrawOverlayStyle.parseColor)
    }

    var fillColor: CGColor? {
        fill.flatMap(DrawOverlayStyle.parseColor)
    }
}

private enum DrawOverlayKind: String, Decodable {
    case rect
    case line
    case xray
    case spotlight
    case marker
}

private enum DrawOverlayScanDirection: String {
    case leftToRight
    case rightToLeft
    case topToBottom
    case bottomToTop

    var isHorizontal: Bool {
        switch self {
        case .leftToRight, .rightToLeft:
            return true
        case .topToBottom, .bottomToTop:
            return false
        }
    }
}

fileprivate enum DrawOverlaySpotlightShape: String, Decodable {
    case rect
    case circ
}

private struct DrawOverlayLine: Decodable {
    let from: DrawOverlayPoint
    let to: DrawOverlayPoint
}

private struct DrawOverlayPoint: Decodable {
    let x: CGFloat
    let y: CGFloat

    var cgPoint: CGPoint {
        CGPoint(x: x, y: y)
    }
}

private struct DrawOverlayRect: Decodable {
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat

    var cgRect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

private struct DrawOverlayAnimation: Decodable {
    enum Ease: String, Decodable {
        case linear
        case easeIn
        case easeOut
        case easeInOut
    }

    let durMs: Double?
    let ease: Ease?

    var duration: CFTimeInterval {
        let raw = durMs ?? 250
        return max(raw, 0) / 1000.0
    }

    var timingFunction: CAMediaTimingFunction {
        switch ease ?? .easeInOut {
        case .linear:
            return CAMediaTimingFunction(name: .linear)
        case .easeIn:
            return CAMediaTimingFunction(name: .easeIn)
        case .easeOut:
            return CAMediaTimingFunction(name: .easeOut)
        case .easeInOut:
            return CAMediaTimingFunction(name: .easeInEaseOut)
        }
    }
}

private struct DrawOverlayStyle: Decodable {
    static let defaultRectStyle = DrawOverlayStyle(
        stroke: "#00E5FF",
        fill: "#00E5FF18",
        lineWidth: 2,
        cornerRadius: 8,
        opacity: 1,
        color: nil,
        size: nil,
        padding: nil,
        roughness: nil,
        blur: nil
    )

    static let defaultLineStyle = DrawOverlayStyle(
        stroke: "#00E5FF",
        fill: nil,
        lineWidth: 2,
        cornerRadius: nil,
        opacity: 1,
        color: nil,
        size: nil,
        padding: nil,
        roughness: nil,
        blur: nil
    )
    static let defaultSpotlightStyle = DrawOverlayStyle(
        stroke: nil,
        fill: "#000000B8",
        lineWidth: nil,
        cornerRadius: 18,
        opacity: 1,
        color: nil,
        size: nil,
        padding: nil,
        roughness: nil,
        blur: nil
    )
    static let defaultMarkerStyle = DrawOverlayStyle(
        stroke: nil,
        fill: nil,
        lineWidth: nil,
        cornerRadius: nil,
        opacity: 1,
        color: "#00E5FF",
        size: 4,
        padding: 8,
        roughness: 0.22,
        blur: nil
    )

    let stroke: String?
    let fill: String?
    let lineWidth: CGFloat?
    let cornerRadius: CGFloat?
    let opacity: CGFloat?
    let color: String?
    let size: CGFloat?
    let padding: CGFloat?
    let roughness: CGFloat?
    let blur: CGFloat?

    private static let hexColorPattern = "^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
    private static let rgbColorPattern = "^rgb\\(\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*,\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*,\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*\\)$"
    private static let rgbaColorPattern = "^rgba\\(\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*,\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*,\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*,\\s*([+-]?(?:\\d+|\\d*\\.\\d+|\\.\\d+))\\s*\\)$"

    var strokeColor: CGColor? {
        stroke.flatMap(Self.parseColor)
    }

    var fillColor: CGColor? {
        fill.flatMap(Self.parseColor)
    }

    var markerColor: CGColor? {
        color.flatMap(Self.parseColor)
    }

    fileprivate static func parseColor(_ value: String) -> CGColor? {
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

private enum DrawOverlayMarkerShape: String {
    case rect
    case circ
    case check
    case cross
    case underline
}

private struct DrawOverlayMarkerStyle {
    let color: CGColor
    let size: CGFloat
    let padding: CGFloat
    let roughness: CGFloat
    let opacity: CGFloat
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

    mutating func combine(_ value: CGFloat) {
        combine(Double(value))
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
        state = seed == 0 ? 0x9E3779B97F4A7C15 : seed
    }

    mutating func nextUInt64() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }

    mutating func uniform(_ lower: CGFloat, _ upper: CGFloat) -> CGFloat {
        guard upper > lower else { return lower }
        let unit = CGFloat(Double(nextUInt64()) / Double(UInt64.max))
        return lower + (upper - lower) * unit
    }
}

private struct DrawOverlayRenderState {
    let path: CGPath?
    let strokeColor: CGColor?
    let fillColor: CGColor?
    let lineWidth: CGFloat
    let opacity: Float
    let shadowColor: CGColor?
    let shadowOpacity: Float
    let shadowRadius: CGFloat
}

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
                    finalPath = Self.makeSpotlightPath(in: container.bounds, cutouts: finalViewRects, cornerRadius: resolvedStyle.cornerRadius ?? 18)
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
                case .xray:
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
                    opacity: item.from?.opacity.map(Float.init) ?? shape.opacity
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
                    opacity: item.from?.opacity.map(Float.init) ?? shape.opacity
                )
            }
        case .xray:
            break // xray items are handled separately via launchXrayCapture
        case .spotlight:
            break
        }

        if let presentation = shape.presentation() {
            return DrawOverlayRenderState(
                path: presentation.path ?? shape.path ?? finalPath,
                strokeColor: presentation.strokeColor ?? shape.strokeColor,
                fillColor: presentation.fillColor ?? shape.fillColor,
                lineWidth: presentation.lineWidth,
                opacity: presentation.opacity
            )
        }

        return DrawOverlayRenderState(
            path: shape.path ?? finalPath,
            strokeColor: shape.strokeColor,
            fillColor: shape.fillColor,
            lineWidth: shape.lineWidth,
            opacity: shape.opacity
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

    static func makeSpotlightPath(in bounds: CGRect, cutouts: [CGRect], cornerRadius: CGFloat) -> CGPath {
        let path = CGMutablePath()
        path.addRect(bounds)
        let coalescedCutouts = coalescedSpotlightCutouts(cutouts)
        let usesRoundedCutouts = coalescedCutouts.count == cutouts.count
        for cutout in coalescedCutouts {
            path.addPath(makeRectPath(for: cutout, cornerRadius: usesRoundedCutouts ? cornerRadius : 0))
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
    let rects: [DrawOverlayRect]?
    let line: DrawOverlayLine?
    let direction: String?
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
        }
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
        opacity: 1
    )

    static let defaultLineStyle = DrawOverlayStyle(
        stroke: "#00E5FF",
        fill: nil,
        lineWidth: 2,
        cornerRadius: nil,
        opacity: 1
    )
    static let defaultSpotlightStyle = DrawOverlayStyle(
        stroke: nil,
        fill: "#000000B8",
        lineWidth: nil,
        cornerRadius: 18,
        opacity: 1
    )

    let stroke: String?
    let fill: String?
    let lineWidth: CGFloat?
    let cornerRadius: CGFloat?
    let opacity: CGFloat?

    var strokeColor: CGColor? {
        stroke.flatMap(Self.parseColor)
    }

    var fillColor: CGColor? {
        fill.flatMap(Self.parseColor)
    }

    fileprivate static func parseColor(_ value: String) -> CGColor? {
        let hex = value.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard hex.count == 6 || hex.count == 8, let intValue = UInt64(hex, radix: 16) else {
            return nil
        }

        let r, g, b, a: CGFloat
        if hex.count == 6 {
            r = CGFloat((intValue >> 16) & 0xFF) / 255
            g = CGFloat((intValue >> 8) & 0xFF) / 255
            b = CGFloat(intValue & 0xFF) / 255
            a = 1
        } else {
            r = CGFloat((intValue >> 24) & 0xFF) / 255
            g = CGFloat((intValue >> 16) & 0xFF) / 255
            b = CGFloat((intValue >> 8) & 0xFF) / 255
            a = CGFloat(intValue & 0xFF) / 255
        }

        return CGColor(red: r, green: g, blue: b, alpha: a)
    }
}

private struct DrawOverlayRenderState {
    let path: CGPath?
    let strokeColor: CGColor?
    let fillColor: CGColor?
    let lineWidth: CGFloat
    let opacity: Float
}

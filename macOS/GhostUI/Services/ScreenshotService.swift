import AppKit
import CoreGraphics

/// Screen-recording permission checks and overlay color helpers.
final class ScreenshotService {
    private init() {}

    /// Reliable screen-recording permission check.
    /// CGPreflightScreenCaptureAccess() caches stale results. CGDisplayCreateImage
    /// returns a non-nil but all-black image when the TCC grant is stale (macOS 15).
    /// We capture and sample a pixel from the content area to detect this.
    static func hasScreenRecordingPermission() -> Bool {
        guard let image = CGDisplayCreateImage(CGMainDisplayID()) else {
            return false
        }

        let sampleX = image.width / 2
        let sampleY = image.height / 2
        guard let dp = image.dataProvider, let data = dp.data,
              let ptr = CFDataGetBytePtr(data) else {
            return false
        }

        let bpr = image.bytesPerRow
        let bpp = image.bitsPerPixel / 8
        let offset = sampleY * bpr + sampleX * bpp
        let b = ptr[offset], g = ptr[offset + 1], r = ptr[offset + 2]
        return (r | g | b) != 0
    }

    /// Returns (stroke, fill, badge) colors based on changeAge.
    /// nil age falls back to uniform red (backward compat).
    static func colorsForAge(_ age: Int?) -> (stroke: CGColor, fill: CGColor, badge: CGColor) {
        guard let age else {
            return (
                CGColor(red: 1.0, green: 0.0, blue: 0.0, alpha: 0.8),
                CGColor(red: 1.0, green: 0.0, blue: 0.0, alpha: 0.05),
                CGColor(red: 1.0, green: 0.0, blue: 0.0, alpha: 0.85)
            )
        }

        switch age {
        case 0:
            return (
                CGColor(red: 0.0, green: 0.8, blue: 0.0, alpha: 0.9),
                CGColor(red: 0.0, green: 0.8, blue: 0.0, alpha: 0.08),
                CGColor(red: 0.0, green: 0.7, blue: 0.0, alpha: 0.9)
            )
        case 1:
            return (
                CGColor(red: 1.0, green: 0.6, blue: 0.0, alpha: 0.8),
                CGColor(red: 1.0, green: 0.6, blue: 0.0, alpha: 0.05),
                CGColor(red: 1.0, green: 0.5, blue: 0.0, alpha: 0.85)
            )
        default:
            return (
                CGColor(red: 1.0, green: 0.0, blue: 0.0, alpha: 0.4),
                CGColor(red: 1.0, green: 0.0, blue: 0.0, alpha: 0.02),
                CGColor(red: 1.0, green: 0.0, blue: 0.0, alpha: 0.45)
            )
        }
    }
}

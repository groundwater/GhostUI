import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 1, let targetPid = Int(CommandLine.arguments[1]) else {
    exit(1)
}
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)! as [AnyObject]
for w in info {
    guard let d = w as? [String: AnyObject],
          let layer = d["kCGWindowLayer"] as? Int, layer == 0,
          let p = d["kCGWindowOwnerPID"] as? Int, p == targetPid,
          let wid = d["kCGWindowNumber"] as? Int else { continue }
    print(wid)
    exit(0)
}
exit(1)

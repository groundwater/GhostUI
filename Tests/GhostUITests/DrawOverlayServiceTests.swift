import XCTest
@testable import GhostUI

final class DrawOverlayServiceTests: XCTestCase {
    func testSpotlightPathKeepsOverlappingCutoutsClear() {
        let path = DrawOverlayService.makeSpotlightPath(
            in: CGRect(x: 0, y: 0, width: 300, height: 200),
            cutouts: [
                CGRect(x: 40, y: 40, width: 120, height: 80),
                CGRect(x: 100, y: 40, width: 120, height: 80),
            ],
            cornerRadius: 0
        )

        XCTAssertTrue(path.contains(CGPoint(x: 10, y: 10), using: .evenOdd, transform: .identity))
        XCTAssertFalse(path.contains(CGPoint(x: 60, y: 70), using: .evenOdd, transform: .identity))
        XCTAssertFalse(path.contains(CGPoint(x: 130, y: 70), using: .evenOdd, transform: .identity))
        XCTAssertFalse(path.contains(CGPoint(x: 200, y: 70), using: .evenOdd, transform: .identity))
    }

    func testSpotlightCutoutsAreCoalescedIntoNonOverlappingBands() {
        let rects = DrawOverlayService.coalescedSpotlightCutouts([
            CGRect(x: 40, y: 40, width: 120, height: 80),
            CGRect(x: 100, y: 40, width: 120, height: 80),
            CGRect(x: 100, y: 90, width: 120, height: 60),
        ])

        XCTAssertEqual(rects, [
            CGRect(x: 40, y: 40, width: 180, height: 80),
            CGRect(x: 100, y: 120, width: 120, height: 30),
        ])
    }
}

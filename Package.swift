// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GhostUI",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "GhostUI",
            path: "macOS/GhostUI",
            exclude: [
                "CLIHelper",
                "BuildScripts",
                "Resources/Info.plist",
                "Resources/AppIcon.icns",
                "Resources/Icon",
                "Resources/GhostUI.entitlements",
                "Resources/gui.entitlements",
            ],
            linkerSettings: [
                .linkedFramework("Security"),
                .unsafeFlags(["-Xlinker", "-sectcreate",
                              "-Xlinker", "__TEXT",
                              "-Xlinker", "__info_plist",
                              "-Xlinker", "macOS/GhostUI/Resources/Info.plist"])
            ]
        ),
    ]
)

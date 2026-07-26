// swift-tools-version:5.9
//
// dollyd — DOLLY capture/export sidecar (BUILD_PLAN §2.2, §4).
//
// A standalone Swift executable that owns ScreenCaptureKit, AVAssetWriter, event
// monitoring and the native export renderer. Tauri spawns it as a sidecar and talks to it
// over stdin/stdout with newline-delimited JSON (§3.4).
//
// NOTE: This package is authored on Linux without a Swift toolchain and therefore cannot be
// compiled here. It is a faithful first draft to be built on macOS 14. Every spot that needs
// on-device verification is marked `// TODO(mac):`.
import PackageDescription

let package = Package(
    name: "dollyd",
    platforms: [
        // ScreenCaptureKit stream config APIs used here (sourceRect, captureResolution,
        // streamFilter init) require macOS 13+; a few (SCContentSharingPicker) are 14+ but
        // are not used in the sidecar. Build target is macOS 14 per BUILD_PLAN §10.
        .macOS(.v13)
    ],
    products: [
        .executable(name: "dollyd", targets: ["dollyd"])
    ],
    targets: [
        .executableTarget(
            name: "dollyd",
            path: "Sources/dollyd",
            // Frameworks (ScreenCaptureKit, AVFoundation, CoreImage, CoreMedia, AppKit,
            // VideoToolbox, Metal, CoreGraphics) are all part of the macOS SDK and are
            // linked implicitly by `import` — no linkerSettings needed. Listed here for
            // documentation and in case an explicit link is required on some SDKs.
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreImage"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("AppKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("Metal"),
                .linkedFramework("CoreGraphics")
            ]
        ),
        .testTarget(
            name: "dollydTests",
            dependencies: ["dollyd"],
            path: "Tests/dollydTests"
        )
    ]
)

import Foundation

private enum GhostUICLIBootstrap {
    static func isHelpInvocation() -> Bool {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard !arguments.isEmpty else {
            return false
        }
        return arguments.contains("--help") || arguments.contains("-h") || arguments.first == "help"
    }

    static func helperBundleURL() -> URL {
        Bundle.main.bundleURL
    }

    static func runtimeURL() -> URL {
        helperBundleURL()
            .appendingPathComponent("Contents/MacOS/gui-runtime", isDirectory: false)
    }

    static func helperBundle() -> Bundle? {
        Bundle(url: helperBundleURL())
    }

    static func prepareEnvironment() throws {
        let secret = try DaemonAuthService.shared.sharedSecret()
        setenv("GHOSTUI_AUTH_SECRET", secret, 1)
        if let accessGroup = helperBundle()?.object(forInfoDictionaryKey: "GhostUIKeychainAccessGroup") as? String {
            let trimmed = accessGroup.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                setenv("GHOSTUI_KEYCHAIN_ACCESS_GROUP", trimmed, 1)
            }
        }
    }

    static func execRuntime() -> Never {
        let runtime = runtimeURL()
        guard FileManager.default.isExecutableFile(atPath: runtime.path) else {
            fputs("gui runtime is missing at \(runtime.path)\n", stderr)
            exit(1)
        }

        var argv = CommandLine.arguments
        argv[0] = runtime.path
        let cStrings = argv.map { strdup($0) } + [nil]
        defer {
            for pointer in cStrings where pointer != nil {
                free(pointer)
            }
        }

        let result = cStrings.withUnsafeBufferPointer { buffer in
            execv(runtime.path, UnsafeMutablePointer(mutating: buffer.baseAddress))
        }
        if result == -1 {
            perror("execv")
        }
        exit(1)
    }
}

do {
    if !GhostUICLIBootstrap.isHelpInvocation() {
        try GhostUICLIBootstrap.prepareEnvironment()
    }
    GhostUICLIBootstrap.execRuntime()
} catch {
    fputs("failed to prepare gui auth secret: \(error)\n", stderr)
    exit(1)
}

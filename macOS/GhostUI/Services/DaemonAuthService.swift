import Foundation
import Security

enum DaemonAuthError: Error {
    case randomBytes(OSStatus)
    case encodingFailed
    case unexpectedData
    case missingAccessGroup
    case keychain(OSStatus)
}

final class DaemonAuthService {
    static let shared = DaemonAuthService()

    static let service = "org.ghostvm.GhostUI.local-auth"
    static let account = "daemon-http"

    private var cachedSecret: String?

    private init() {}

    private var accessGroup: String {
        if let accessGroup = ProcessInfo.processInfo.environment["GHOSTUI_KEYCHAIN_ACCESS_GROUP"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !accessGroup.isEmpty {
            return accessGroup
        }
        if let accessGroup = Bundle.main.object(forInfoDictionaryKey: "GhostUIKeychainAccessGroup") as? String {
            let trimmed = accessGroup.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return ""
    }

    private func resolvedAccessGroup() throws -> String {
        let accessGroup = self.accessGroup
        guard !accessGroup.isEmpty else {
            throw DaemonAuthError.missingAccessGroup
        }
        return accessGroup
    }

    func sharedSecret() throws -> String {
        if let cachedSecret {
            return cachedSecret
        }
        if let existing = try loadSecret() {
            cachedSecret = existing
            return existing
        }
        let secret = try generateSecret()
        try storeSecret(secret)
        cachedSecret = secret
        return secret
    }

    private func loadSecret() throws -> String? {
        let accessGroup = try resolvedAccessGroup()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw DaemonAuthError.keychain(status)
        }
        guard let data = result as? Data,
              let secret = String(data: data, encoding: .utf8),
              !secret.isEmpty else {
            throw DaemonAuthError.unexpectedData
        }
        return secret
    }

    private func storeSecret(_ secret: String) throws {
        let accessGroup = try resolvedAccessGroup()
        guard let data = secret.data(using: .utf8) else {
            throw DaemonAuthError.encodingFailed
        }
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecUseDataProtectionKeychain as String: true,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status == errSecSuccess {
            return
        }
        if status == errSecDuplicateItem {
            let matchQuery: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: Self.service,
                kSecAttrAccount as String: Self.account,
                kSecAttrAccessGroup as String: accessGroup,
                kSecUseDataProtectionKeychain as String: true,
            ]
            let attrs: [String: Any] = [kSecValueData as String: data]
            let updateStatus = SecItemUpdate(matchQuery as CFDictionary, attrs as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw DaemonAuthError.keychain(updateStatus)
            }
            return
        }
        throw DaemonAuthError.keychain(status)
    }

    private func generateSecret() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw DaemonAuthError.randomBytes(status)
        }
        return Data(bytes).base64EncodedString()
    }
}

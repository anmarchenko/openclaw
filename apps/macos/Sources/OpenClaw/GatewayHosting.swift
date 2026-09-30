import Foundation

enum GatewayHosting: String, Sendable {
    case app
    case service

    static let defaultsKey = "gatewayHosting"

    static func resolve(stored: String?, bundled: Bool, serviceExists: Bool) -> Self {
        guard bundled else { return .service }
        if let stored, let hosting = Self(rawValue: stored) { return hosting }
        return serviceExists ? .service : .app
    }
}

struct GatewayHostingError: LocalizedError {
    let message: String
    var errorDescription: String? {
        self.message
    }
}

import Foundation

enum CallState: Equatable {
    case idle
    case connecting
    case outgoing(number: String)
    case ringing(number: String)
    case incoming(number: String, displayName: String?)
    case earlyMedia(number: String)
    case connected(number: String)
    case held(number: String)
    case ended(reason: String?)

    var isInCall: Bool {
        switch self {
        case .outgoing, .ringing, .incoming, .earlyMedia, .connected, .held:
            return true
        default:
            return false
        }
    }
}

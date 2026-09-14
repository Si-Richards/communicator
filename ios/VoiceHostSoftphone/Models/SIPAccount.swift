import Foundation

struct SIPAccount: Equatable {
    var username: String
    var password: String
    var realm: String
    var proxy: String?
    var displayName: String?

    var sipURI: String {
        "sip:\(username)@\(realm)"
    }
}

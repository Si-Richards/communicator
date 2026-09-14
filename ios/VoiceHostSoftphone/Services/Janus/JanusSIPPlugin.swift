import Foundation

@MainActor
final class JanusSIPPlugin {
    private let janus: JanusClient

    init(janus: JanusClient) {
        self.janus = janus
    }

    func register(_ account: SIPAccount) async throws {
        var body: [String: Any] = [
            "request": "register",
            "username": account.sipURI,
            "authuser": account.username,
            "secret": account.password,
            "user_agent": AppConfig.userAgent
        ]
        if let displayName = account.displayName, !displayName.isEmpty {
            body["display_name"] = displayName
        }
        if let proxy = account.proxy, !proxy.isEmpty {
            body["proxy"] = proxy.hasPrefix("sip:") || proxy.hasPrefix("sips:") ? proxy : "sip:\(proxy)"
        }
        try await janus.sendPlugin(body: body)
    }

    func unregister() async throws {
        try await janus.sendPlugin(body: ["request": "unregister"])
    }

    func subscribeMessageSummary(ttl: Int = 3600) async throws {
        try await janus.sendPlugin(body: [
            "request": "subscribe",
            "event": "message-summary",
            "accept": "application/simple-message-summary",
            "subscribe_ttl": ttl
        ])
    }

    func call(number: String, realm: String, offerSDP: String) async throws {
        let uri = number.hasPrefix("sip:") ? number : "sip:\(number)@\(realm)"
        try await janus.sendPlugin(
            body: ["request": "call", "uri": uri],
            jsep: ["type": "offer", "sdp": offerSDP, "trickle": true]
        )
    }

    func accept(answerSDP: String) async throws {
        try await janus.sendPlugin(
            body: ["request": "accept"],
            jsep: ["type": "answer", "sdp": answerSDP, "trickle": true]
        )
    }

    func decline(code: Int = 486) async throws {
        try await janus.sendPlugin(body: ["request": "decline", "code": code])
    }

    func hangup() async throws {
        try await janus.sendPlugin(body: ["request": "hangup"])
    }

    func hold() async throws {
        try await janus.sendPlugin(body: ["request": "hold", "direction": "sendonly"])
    }

    func unhold() async throws {
        try await janus.sendPlugin(body: ["request": "unhold"])
    }

    func sendDTMF(_ digit: String, duration: Int = 160) async throws {
        try await janus.sendPlugin(body: [
            "request": "dtmf_info",
            "digit": digit,
            "duration": duration
        ])
    }
}

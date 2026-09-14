import Foundation

@MainActor
final class JanusClient: ObservableObject {
    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case failed(String)
    }

    enum ClientError: LocalizedError {
        case notConnected
        case invalidResponse(String)
        case janusError(String)

        var errorDescription: String? {
            switch self {
            case .notConnected:
                return "Janus WebSocket is not connected."
            case .invalidResponse(let message):
                return "Invalid Janus response: \(message)"
            case .janusError(let message):
                return "Janus error: \(message)"
            }
        }
    }

    @Published private(set) var connectionState: ConnectionState = .disconnected

    var onPluginEvent: (([String: Any], [String: Any]?) -> Void)?
    var onRemoteCandidate: (([String: Any]) -> Void)?

    private let serverURL: URL
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var keepaliveTask: Task<Void, Never>?
    private var apiSecret: String?

    private(set) var sessionID: UInt64?
    private(set) var handleID: UInt64?

    private var pending: [String: CheckedContinuation<[String: Any], Error>] = [:]

    init(serverURL: URL) {
        self.serverURL = serverURL
    }

    func connect(apiSecret: String? = nil) async throws {
        guard socket == nil else { return }
        connectionState = .connecting
        self.apiSecret = apiSecret?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty

        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        let session = URLSession(configuration: configuration)
        let socket = session.webSocketTask(with: serverURL, protocols: ["janus-protocol"])
        self.socket = socket
        socket.resume()

        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }

        do {
            let create = try await request(["janus": "create"])
            guard
                let data = create["data"] as? [String: Any],
                let id = Self.uint64(data["id"])
            else {
                throw ClientError.invalidResponse("missing session id")
            }
            sessionID = id

            let attach = try await request([
                "janus": "attach",
                "plugin": AppConfig.janusPlugin,
                "session_id": id
            ])
            guard
                let attachData = attach["data"] as? [String: Any],
                let handle = Self.uint64(attachData["id"])
            else {
                throw ClientError.invalidResponse("missing SIP plugin handle id")
            }
            handleID = handle
            connectionState = .connected
            startKeepalive()
        } catch {
            connectionState = .failed(error.localizedDescription)
            disconnect()
            throw error
        }
    }

    func disconnect() {
        keepaliveTask?.cancel()
        keepaliveTask = nil
        receiveTask?.cancel()
        receiveTask = nil

        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        sessionID = nil
        handleID = nil

        for (_, continuation) in pending {
            continuation.resume(throwing: ClientError.notConnected)
        }
        pending.removeAll()
        connectionState = .disconnected
    }

    func sendPlugin(body: [String: Any], jsep: [String: Any]? = nil) async throws {
        guard let sessionID, let handleID else { throw ClientError.notConnected }
        var message: [String: Any] = [
            "janus": "message",
            "session_id": sessionID,
            "handle_id": handleID,
            "transaction": transaction()
        ]
        message["body"] = body
        if let jsep { message["jsep"] = jsep }
        applySecret(to: &message)
        try await sendRaw(message)
    }

    func sendTrickle(candidate: [String: Any]) async throws {
        guard let sessionID, let handleID else { throw ClientError.notConnected }
        var message: [String: Any] = [
            "janus": "trickle",
            "session_id": sessionID,
            "handle_id": handleID,
            "transaction": transaction(),
            "candidate": candidate
        ]
        applySecret(to: &message)
        try await sendRaw(message)
    }

    private func request(_ base: [String: Any]) async throws -> [String: Any] {
        var message = base
        let transaction = transaction()
        message["transaction"] = transaction
        applySecret(to: &message)

        return try await withCheckedThrowingContinuation { continuation in
            pending[transaction] = continuation
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.sendRaw(message)
                } catch {
                    if let pending = self.pending.removeValue(forKey: transaction) {
                        pending.resume(throwing: error)
                    }
                }
            }
        }
    }

    private func sendRaw(_ object: [String: Any]) async throws {
        guard let socket else { throw ClientError.notConnected }
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let text = String(data: data, encoding: .utf8) else {
            throw ClientError.invalidResponse("unable to encode JSON")
        }
        try await socket.send(.string(text))
    }

    private func receiveLoop() async {
        guard let socket else { return }
        while !Task.isCancelled {
            do {
                let message = try await socket.receive()
                let text: String
                switch message {
                case .string(let value): text = value
                case .data(let data): text = String(decoding: data, as: UTF8.self)
                @unknown default: continue
                }
                handle(text)
            } catch {
                if !Task.isCancelled {
                    connectionState = .failed(error.localizedDescription)
                }
                break
            }
        }
    }

    private func handle(_ text: String) {
        guard
            let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        let janus = object["janus"] as? String

        if let transaction = object["transaction"] as? String,
           janus != "ack",
           let continuation = pending.removeValue(forKey: transaction) {
            if janus == "error" {
                let error = object["error"] as? [String: Any]
                continuation.resume(throwing: ClientError.janusError(error?["reason"] as? String ?? "unknown error"))
            } else {
                continuation.resume(returning: object)
            }
            return
        }

        if janus == "event",
           let pluginData = object["plugindata"] as? [String: Any],
           let payload = pluginData["data"] as? [String: Any] {
            onPluginEvent?(payload, object["jsep"] as? [String: Any])
            return
        }

        if janus == "trickle", let candidate = object["candidate"] as? [String: Any] {
            onRemoteCandidate?(candidate)
        }
    }

    private func startKeepalive() {
        keepaliveTask?.cancel()
        keepaliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                guard let self, let sessionID = self.sessionID else { return }
                var message: [String: Any] = [
                    "janus": "keepalive",
                    "session_id": sessionID,
                    "transaction": self.transaction()
                ]
                self.applySecret(to: &message)
                try? await self.sendRaw(message)
            }
        }
    }

    private func applySecret(to message: inout [String: Any]) {
        if let apiSecret { message["apisecret"] = apiSecret }
    }

    private func transaction() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    private static func uint64(_ value: Any?) -> UInt64? {
        if let value = value as? UInt64 { return value }
        if let value = value as? Int { return UInt64(value) }
        if let value = value as? NSNumber { return value.uint64Value }
        return nil
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

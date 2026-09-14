import Foundation

struct CallRecord: Identifiable, Codable, Equatable {
    enum Direction: String, Codable {
        case incoming
        case outgoing
    }

    enum Result: String, Codable {
        case completed
        case missed
        case declined
        case failed
        case cancelled
    }

    let id: UUID
    let direction: Direction
    let number: String
    let displayName: String?
    let startedAt: Date
    let duration: TimeInterval
    let result: Result

    init(
        id: UUID = UUID(),
        direction: Direction,
        number: String,
        displayName: String? = nil,
        startedAt: Date,
        duration: TimeInterval,
        result: Result
    ) {
        self.id = id
        self.direction = direction
        self.number = number
        self.displayName = displayName
        self.startedAt = startedAt
        self.duration = duration
        self.result = result
    }

    var durationText: String? {
        guard duration > 0 else { return nil }
        let total = Int(duration.rounded(.down))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    var resultText: String {
        switch result {
        case .completed: return direction == .incoming ? "Incoming" : "Outgoing"
        case .missed: return "Missed"
        case .declined: return "Declined"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        }
    }
}

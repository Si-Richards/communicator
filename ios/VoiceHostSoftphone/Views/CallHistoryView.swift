import SwiftUI

struct CallHistoryView: View {
    @ObservedObject var model: PhoneViewModel
    @Binding var selectedTab: Int

    var body: some View {
        NavigationStack {
            Group {
                if model.callHistory.isEmpty {
                    ContentUnavailableView(
                        "No Recent Calls",
                        systemImage: "clock.arrow.circlepath",
                        description: Text("Incoming, outgoing and missed calls will appear here.")
                    )
                } else {
                    List {
                        ForEach(model.callHistory) { record in
                            callRow(record)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    model.dialledNumber = record.number
                                    selectedTab = 0
                                }
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button(role: .destructive) {
                                        model.deleteCallRecord(id: record.id)
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                    Button {
                                        model.dialledNumber = record.number
                                        selectedTab = 0
                                        Task { await model.placeCall() }
                                    } label: {
                                        Label("Call", systemImage: "phone.fill")
                                    }
                                    .tint(.green)
                                }
                        }
                        .onDelete(perform: model.deleteCallRecords)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Recents")
            .toolbar {
                if !model.callHistory.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("Clear Call History", role: .destructive) {
                                model.clearCallHistory()
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                }
            }
        }
    }

    private func callRow(_ record: CallRecord) -> some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(iconBackground(for: record))
                    .frame(width: 42, height: 42)
                Image(systemName: iconName(for: record))
                    .foregroundStyle(iconForeground(for: record))
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(record.displayName?.isEmpty == false ? record.displayName! : record.number)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(record.result == .missed ? .red : .primary)

                HStack(spacing: 5) {
                    Image(systemName: record.direction == .incoming ? "arrow.down.left" : "arrow.up.right")
                    Text(record.resultText)
                    if let duration = record.durationText {
                        Text("• \(duration)")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 6) {
                Text(record.startedAt, format: .dateTime.hour().minute())
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(record.startedAt, format: .dateTime.day().month(.abbreviated))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            Button {
                model.dialledNumber = record.number
                selectedTab = 0
                Task { await model.placeCall() }
            } label: {
                Image(systemName: "phone.circle.fill")
                    .font(.title2)
            }
            .buttonStyle(.plain)
            .disabled(!model.isRegistered)
        }
        .padding(.vertical, 4)
    }

    private func iconName(for record: CallRecord) -> String {
        switch record.result {
        case .missed: return "phone.down.fill"
        case .declined: return "xmark"
        case .failed: return "exclamationmark"
        case .cancelled: return "phone.down"
        case .completed: return "phone.fill"
        }
    }

    private func iconBackground(for record: CallRecord) -> Color {
        switch record.result {
        case .missed, .failed: return .red.opacity(0.12)
        case .declined, .cancelled: return .secondary.opacity(0.12)
        case .completed: return .green.opacity(0.12)
        }
    }

    private func iconForeground(for record: CallRecord) -> Color {
        switch record.result {
        case .missed, .failed: return .red
        case .declined, .cancelled: return .secondary
        case .completed: return .green
        }
    }
}

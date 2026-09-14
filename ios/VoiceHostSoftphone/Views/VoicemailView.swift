import SwiftUI

struct VoicemailView: View {
    @ObservedObject var model: PhoneViewModel
    @Binding var selectedTab: Int

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 16) {
                        ZStack {
                            Circle()
                                .fill(model.voicemailWaiting ? Color.red.opacity(0.12) : Color.secondary.opacity(0.12))
                                .frame(width: 54, height: 54)
                            Image(systemName: model.voicemailWaiting ? "recordingtape.circle.fill" : "recordingtape")
                                .font(.title2)
                                .foregroundStyle(model.voicemailWaiting ? .red : .secondary)
                        }

                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.voicemailWaiting ? "Voicemail Waiting" : "No New Voicemail")
                                .font(.headline)
                            Text(summaryText)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()
                    }
                    .padding(.vertical, 4)

                    HStack {
                        Text("MWI status")
                        Spacer()
                        Text(model.voicemailSubscriptionStatus)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Mailbox")
                }

                Section {
                    Button {
                        selectedTab = 0
                        Task { await model.callVoicemail() }
                    } label: {
                        Label("Call Voicemail", systemImage: "phone.fill")
                    }
                    .disabled(!model.canCallVoicemail)

                    if model.voicemailAccessNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Label("Set the voicemail number or feature code in Settings.", systemImage: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        LabeledContent("Access number", value: model.voicemailAccessNumber)
                    }
                } header: {
                    Text("Manage by Phone")
                }

                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Visual voicemail", systemImage: "waveform")
                            .font(.headline)
                        Text("Message-summary tells the app whether messages are waiting and, where supplied by the SIP platform, the new and saved message counts. Listing, playing, marking and deleting individual recordings requires the VoiceHost voicemail API/storage service and will plug into this screen next.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle("Voicemail")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.refreshVoicemailStatus() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(!model.isRegistered)
                    .accessibilityLabel("Refresh voicemail status")
                }
            }
        }
    }

    private var summaryText: String {
        if model.voicemailNewCount > 0 || model.voicemailOldCount > 0 {
            let newLabel = model.voicemailNewCount == 1 ? "1 new message" : "\(model.voicemailNewCount) new messages"
            let oldLabel = model.voicemailOldCount == 1 ? "1 saved message" : "\(model.voicemailOldCount) saved messages"
            return "\(newLabel), \(oldLabel)"
        }

        if model.voicemailWaiting {
            return "The SIP server reports at least one waiting message."
        }

        return "The SIP server is not currently reporting waiting messages."
    }
}

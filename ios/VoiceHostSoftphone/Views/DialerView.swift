import SwiftUI

struct DialerView: View {
    @ObservedObject var model: PhoneViewModel

    private let keys = [
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
        ["*", "0", "#"]
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                statusHeader
                Spacer(minLength: 8)

                TextField("Number", text: $model.dialledNumber)
                    .font(.system(size: 34, weight: .medium, design: .rounded))
                    .multilineTextAlignment(.center)
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)

                dialPad

                if case .incoming(let number, let displayName) = model.callState {
                    incomingControls(number: number, displayName: displayName)
                } else if model.callState.isInCall {
                    inCallControls
                } else {
                    Button {
                        Task { await model.placeCall() }
                    } label: {
                        Image(systemName: "phone.fill")
                            .font(.title2)
                            .frame(width: 72, height: 72)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.circle)
                    .tint(.green)
                    .disabled(!model.isRegistered || model.dialledNumber.isEmpty)
                }

                Spacer()
            }
            .padding()
            .navigationTitle(model.extensionDisplayName)
            .navigationBarTitleDisplayMode(.large)
            .alert("Softphone", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.clearError() } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.errorMessage ?? "Unknown error")
            }
        }
    }

    private var statusHeader: some View {
        HStack {
            Circle()
                .fill(model.isRegistered ? Color.green : Color.secondary)
                .frame(width: 10, height: 10)
            Text(model.registrationStatus)
                .foregroundStyle(.secondary)
            Spacer()
            callStatus
        }
    }

    @ViewBuilder
    private var callStatus: some View {
        switch model.callState {
        case .idle: EmptyView()
        case .connecting: Text("Connecting")
        case .outgoing(let n): Text("Calling \(n)")
        case .ringing(let n): Text("Ringing \(n)")
        case .incoming(let n, _): Text("Incoming \(n)")
        case .earlyMedia(let n): Text("Progress \(n)")
        case .connected(let n): Text("Connected \(n)")
        case .held(let n): Text("Held \(n)")
        case .ended(let reason): Text(reason ?? "Call ended")
        }
    }

    private var dialPad: some View {
        VStack(spacing: 12) {
            ForEach(keys, id: \.self) { row in
                HStack(spacing: 20) {
                    ForEach(row, id: \.self) { digit in
                        Button {
                            model.dialledNumber.append(digit)
                            if model.callState.isInCall {
                                Task { await model.sendDTMF(digit) }
                            }
                        } label: {
                            Text(digit)
                                .font(.system(size: 30, weight: .medium, design: .rounded))
                                .frame(width: 72, height: 72)
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.circle)
                    }
                }
            }
        }
    }

    private var inCallControls: some View {
        VStack(spacing: 16) {
            HStack(spacing: 18) {
                Button(model.isMuted ? "Unmute" : "Mute") { model.toggleMute() }
                    .buttonStyle(.bordered)
                Button("Hold") { Task { await model.toggleHold() } }
                    .buttonStyle(.bordered)
            }
            Button(role: .destructive) {
                Task { await model.hangup() }
            } label: {
                Label("End call", systemImage: "phone.down.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func incomingControls(number: String, displayName: String?) -> some View {
        VStack(spacing: 12) {
            Text(displayName ?? number)
                .font(.title2.bold())
            if displayName != nil { Text(number).foregroundStyle(.secondary) }
            HStack(spacing: 28) {
                Button(role: .destructive) {
                    Task { await model.rejectIncomingCall() }
                } label: {
                    Image(systemName: "phone.down.fill")
                        .frame(width: 60, height: 60)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)

                Button {
                    Task { await model.answerIncomingCall() }
                } label: {
                    Image(systemName: "phone.fill")
                        .frame(width: 60, height: 60)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .tint(.green)
            }
        }
    }
}

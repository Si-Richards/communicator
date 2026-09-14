import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: PhoneViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Nickname", text: $model.extensionNickname)
                        .textInputAutocapitalization(.words)
                    TextField("Username / extension", text: $model.sipUsername)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $model.sipPassword)
                    TextField("Realm", text: $model.sipRealm)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Proxy (optional)", text: $model.sipProxy)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("SIP account")
                } footer: {
                    Text("The nickname is shown at the top of the Phone screen. If it is blank, the SIP extension is shown instead.")
                }

                Section("Janus") {
                    TextField("WebSocket URL", text: $model.janusURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("API secret (development only)", text: $model.janusAPISecret)
                    Text("The Janus API secret is deliberately not compiled into the app. Production access should use backend-issued short-lived credentials or server-side policy.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section {
                    if model.isRegistered {
                        Button("Disconnect", role: .destructive) { model.disconnect() }
                    } else {
                        Button("Connect & Register") {
                            Task { await model.connectAndRegister() }
                        }
                        .disabled(!model.canRegister)
                    }
                } footer: {
                    Text("Status: \(model.registrationStatus)")
                }
            }
            .navigationTitle("Settings")
        }
    }
}

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

                Section {
                    Toggle("Do Not Disturb", isOn: $model.doNotDisturb)
                } header: {
                    Text("Calling")
                } footer: {
                    Text("When enabled, this softphone automatically declines incoming calls and records them as missed. Server-side DND will be added later for account-wide/background call handling.")
                }

                Section {
                    TextField("Voicemail number / feature code", text: $model.voicemailAccessNumber)
                        .keyboardType(.phonePad)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    HStack {
                        Text("MWI subscription")
                        Spacer()
                        Text(model.voicemailSubscriptionStatus)
                            .foregroundStyle(.secondary)
                    }

                    if model.isRegistered {
                        Button("Refresh Voicemail Status") {
                            Task { await model.refreshVoicemailStatus() }
                        }
                    }
                } header: {
                    Text("Voicemail")
                } footer: {
                    Text("The voicemail tab uses SIP message-summary notifications for the waiting indicator. Set the VoiceHost voicemail access number or feature code used by this extension.")
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

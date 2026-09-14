import SwiftUI

@main
struct VoiceHostSoftphoneApp: App {
    @StateObject private var phone = PhoneViewModel()
    @State private var selectedTab = 0

    var body: some Scene {
        WindowGroup {
            TabView(selection: $selectedTab) {
                DialerView(model: phone)
                    .tabItem { Label("Phone", systemImage: "phone.fill") }
                    .tag(0)

                CallHistoryView(model: phone, selectedTab: $selectedTab)
                    .tabItem { Label("Recents", systemImage: "clock.fill") }
                    .tag(1)

                VoicemailView(model: phone, selectedTab: $selectedTab)
                    .tabItem {
                        Label(
                            "Voicemail",
                            systemImage: phone.voicemailWaiting ? "recordingtape.circle.fill" : "recordingtape"
                        )
                    }
                    .tag(2)

                SettingsView(model: phone)
                    .tabItem { Label("Settings", systemImage: "gear") }
                    .tag(3)
            }
        }
    }
}

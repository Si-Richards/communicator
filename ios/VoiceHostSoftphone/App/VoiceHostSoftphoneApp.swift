import SwiftUI

@main
struct VoiceHostSoftphoneApp: App {
    @StateObject private var phone = PhoneViewModel()

    var body: some Scene {
        WindowGroup {
            TabView {
                DialerView(model: phone)
                    .tabItem { Label("Phone", systemImage: "phone.fill") }

                SettingsView(model: phone)
                    .tabItem { Label("Settings", systemImage: "gear") }
            }
        }
    }
}

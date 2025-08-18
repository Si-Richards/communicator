The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

## 🚀 What the App Does
- A browser-based softphone using **Janus WebRTC Gateway** and **SIP**.
- Users can:
  - Register a SIP account
  - Dial numbers
  - Answer/reject calls
  - Send DTMF
  - View contacts & call history
  - Manage settings (audio, video, notifications)
- Optional features:
  - Local/remote video
  - Screen share
  - Ringtones
  - Notifications
  - Persistent settings/history in `localStorage`

---

## 🛠 Tech Stack
- **Frontend**: React 18, Vite, TypeScript, TailwindCSS, shadcn/Radix UI
- **Routing**: react-router-dom
- **State**: React Context Providers (no Redux)
- **Janus/WebRTC**: Loaded dynamically via `src/lib/janusLoader.ts` and consumed from `src/contexts/JanusContext.tsx`
- **Dev Server**: Vite (`port: 8080` via `vite.config.ts`)

---

## 📂 App Entry & Composition
- `src/main.tsx`: Renders `<App />` into `#root`
- `src/App.tsx`: Composes top-level providers:
  - React Query  
  - SettingsProvider  
  - NotificationBootstrap  
  - ContactsProvider  
  - CallHistoryProvider  
  - Tooltip + Toasters  
  - JanusProvider  
  - Router + Layout
- `src/components/Layout.tsx`: Sidebar + header (connection status) + main content area

---

## 🧩 Navigation & Layout
- **Sidebar**: `src/components/AppSidebar.tsx`  
  - Links: Dialpad, Contacts, History, Voicemail, Messages, SMS, Settings  
  - Do Not Disturb toggle in footer (moon icon collapsed, labeled switch expanded)
- **Header**: Connection indicator + Reconnect button (if disconnected)

---

## 📡 Janus + SIP Integration
- Loaded via `src/lib/janusLoader.ts` (loads adapter.js & Janus scripts)
- Orchestrated in `src/contexts/JanusContext.tsx`
- Connects to **`wss://devrtc.voicehost.io:443`**
- Attaches **`janus.plugin.sip`**
- SIP realm: `hpbx.sipconvergence.co.uk` (hard-coded currently)
- Credentials: set in Settings > SIP tab
- Call states: `disconnected`, `connecting`, `connected`, `calling`, `incoming`, `incall`, etc.
- Features:
  - Incoming calls (toast: accept/reject)
  - Call waiting, busy, timeout, SIP error handling
  - Manage **local/remote audio/video** streams
  - Video start/stop, camera switch, screen share
  - DTMF, hold/resume, hangup
  - Audio Quality Optimizer (optional DSP)
  - Ringtones via `ringtoneManager`
  - Notifications via `notificationManager`
  - Call history logged to `localStorage`

---

## 📞 Dialers & Call Flow
- **Simple dialer**: `src/components/CallInterface.tsx`  
  - Phone input + dial pad  
  - In-call controls: mute, hold, keypad (DTMF), video toggle, camera switch, screen share  
  - Local/remote video rendering via `VideoSurface`
- **Multi-call UI**: `src/components/MultiCallInterface.tsx` + `src/contexts/SimpleMultiCallContext.tsx`  
  - UI for multiple calls (currently maps to single active call)

---

## ⚙️ Settings & Device Management
- **Settings state**: `src/contexts/SettingsContext.tsx` (persists to `localStorage`)
- **Pages**:
  - Audio Quality (sample rate, EC/NS/AGC, jitter buffer, network stats)
  - Devices (mic/speaker selection + test tools)
  - Video (camera selection, resolution, test camera)
  - SIP (credentials, Register/Unregister, status)
  - Notifications (toggle + preview)
  - Logs (live logs, search, export)
  - About / Advanced

**Helpers:**
- `audioDeviceManager.ts`: enumerate devices, test mic/speakers, optimal constraints
- `videoDeviceManager.ts`: enumerate/test cameras, get constraints
- `audioQualityOptimizer.ts`: DSP processing + quality stats
- `ringtoneManager.ts`: manage tones
- `notificationManager.ts`: wraps Notification API

---

## 🧱 UI Building Blocks
- Shadcn/Radix UI-based components (`src/components/ui/`)
- Key elements:
  - Dialpad (`dialpad.tsx`)
  - CallButton (gradient circle)
  - VideoSurface (`<video>` wrapper with mirroring option)

---

## 🗂 Routing & Pages
- `src/pages/*.tsx`
  - Dial.tsx → MultiCallInterface
  - Contacts.tsx → CRUD, quick actions, import/export
  - History.tsx → filters, call stats, quick call
  - Voicemail, Messages, SMS, NotFound (stubs for extension)

---



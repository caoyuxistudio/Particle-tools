# Particle Player (iOS)

The iPhone shell around the web player at
`https://caoyuxistudio.github.io/Particle-tools/player/`.

The piece itself is the web player — every line of rendering lives in
`packages/editor` and is deployed with the site. This app only adds what an
iPhone web page cannot have: the whole screen (no status bar, no Home
indicator), a display that never sleeps, and no browser between the piece and
the glass. Change the player, push, relaunch the app: no reinstall.

## Files

| File | What it is |
|---|---|
| `project.yml` | The project, as [XcodeGen](https://github.com/yonaskolb/XcodeGen) reads it. Edit this, not the `.xcodeproj`. |
| `ParticlePlayer.xcodeproj` | Generated from `project.yml` (`xcodegen generate`). Committed so Xcode opens it directly. |
| `ParticlePlayer/PlayerWebView.swift` | The WKWebView, configured as a display: inline autoplaying media, no scrolling or zoom, gyroscope granted, inspectable. |
| `ParticlePlayer/PlayerScreen.swift` | Full-screen layout, status bar and Home indicator hidden, idle timer off. |
| `ParticlePlayer/PlayerSource.swift` | The URL. Override with a launch argument `-PlayerURL https://…` for a test build. |

## Running it on the phone

1. Open `ParticlePlayer.xcodeproj` in Xcode. The phone runs an iOS beta, so the
   Xcode has to be the matching beta (iOS 27 → Xcode 27 beta); the simulator
   works with any Xcode that has an iOS 26 runtime.
2. Target ParticlePlayer → Signing & Capabilities → pick your Team. Signing is
   automatic; nothing else to fill in.
3. Plug the phone in, pick it as the run destination, press Run. The first
   time, iOS asks you to trust the developer (Settings → General → VPN &
   Device Management) and to enable Developer Mode.
4. In the app: COPY the piece in the editor, tap the screen, Paste.

## Debugging

The web view is inspectable: with the phone connected, Safari on the Mac →
Develop → the phone → the player page opens Web Inspector against the app.
The Perf and Gyro panels work as they do in Safari (tap the screen).

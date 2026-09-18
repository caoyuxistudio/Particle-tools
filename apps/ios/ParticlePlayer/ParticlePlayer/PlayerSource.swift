import Foundation

/// Where the player is loaded from.
///
/// The first version points at the published site, so a change to the player
/// reaches every phone on the next launch without a reinstall. A later version
/// can ship the player's files inside the app and load them from the bundle.
///
/// Override for a test build without touching code: a launch argument
/// `-PlayerURL https://…` (Xcode scheme → Arguments), or a `PlayerURL`
/// value in UserDefaults.
enum PlayerSource {
    static let defaultURL = URL(string: "https://caoyuxistudio.github.io/Particle-tools/player/")!

    static var url: URL {
        if let override = UserDefaults.standard.string(forKey: "PlayerURL"),
           let url = URL(string: override) {
            return url
        }
        return defaultURL
    }
}

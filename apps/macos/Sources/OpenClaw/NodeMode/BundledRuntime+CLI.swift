import Darwin
import Foundation
import OSLog

extension BundledRuntime {
    private static let shimSignature = "# OpenClaw.app managed CLI (bundled runtime)"
    private static let cliLogger = Logger(subsystem: "ai.openclaw", category: "bundled-runtime.cli")

    func installCLI(bundle: Bundle, profile: AppProfile, homeDirectory: URL) {
        let fileManager = FileManager.default
        let state = profile.stateDirectoryURL(homeDirectory: homeDirectory)
        let bin = state.appendingPathComponent("bin")
        let command = bin.appendingPathComponent("openclaw")
        do {
            try fileManager.createDirectory(at: bin, withIntermediateDirectories: true)
            let attributes = try? fileManager.attributesOfItem(atPath: command.path)
            let existing = attributes == nil ? nil : try? String(contentsOf: command, encoding: .utf8)
            if attributes == nil || (attributes?[.type] as? FileAttributeType == .typeRegular
                && existing.map { Self.isManagedShim($0, stateDirectory: state) } == true)
            {
                let shim = Self.cliShim(profile: profile, homeDirectory: homeDirectory)
                if existing != shim {
                    try shim.write(to: command, atomically: true, encoding: .utf8)
                    try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: command.path)
                }
                Self.installShellPath(bin: bin, homeDirectory: homeDirectory)
            } else {
                Self.cliLogger.warning("Keeping operator-managed terminal CLI at \(command.path, privacy: .public)")
            }
        } catch {
            Self.cliLogger.warning("Terminal CLI setup failed: \(error.localizedDescription, privacy: .public)")
        }

        do {
            let source = bundle.bundleURL.appendingPathComponent("Contents/MacOS/openclaw-mac")
            guard fileManager.isExecutableFile(atPath: source.path) else {
                throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: source.path])
            }
            let macCommand = bin.appendingPathComponent("openclaw-mac")
            if let existing = try? fileManager.destinationOfSymbolicLink(atPath: macCommand.path) {
                if existing != source.path {
                    Self.cliLogger.warning("Keeping existing macOS CLI link at \(macCommand.path, privacy: .public)")
                }
                return
            }
            if !fileManager.fileExists(atPath: macCommand.path) {
                try fileManager.createSymbolicLink(at: macCommand, withDestinationURL: source)
            } else {
                Self.cliLogger.warning("Keeping operator-managed macOS CLI at \(macCommand.path, privacy: .public)")
            }
        } catch {
            Self.cliLogger.warning("macOS CLI link setup failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func cliShim(profile: AppProfile, homeDirectory: URL) -> String {
        let current = Self(root: profile.stateDirectoryURL(homeDirectory: homeDirectory)
            .appendingPathComponent("runtime/current"))
        let profileLine = profile.name.map { "export OPENCLAW_PROFILE=\(Self.shellQuote($0))\n" } ?? ""
        let cli = current.packageRoot.appendingPathComponent("openclaw.mjs")
        return """
        #!/bin/sh
        \(Self.shimSignature)
        \(profileLine)export OPENCLAW_SQLITE_LIBRARY=\(Self.shellQuote(current.sqliteLibrary.path))
        exec \(Self.shellQuote(current.bun.path)) \(Self.shellQuote(cli.path)) "$@"

        """
    }

    static func isManagedShim(_ text: String, stateDirectory: URL) -> Bool {
        if text.hasPrefix("#!/bin/sh\n\(self.shimSignature)\n") { return true }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count == 4, lines[0] == "#!/usr/bin/env bash", lines[1] == "set -euo pipefail",
              lines[3].isEmpty
        else { return false }
        let prefix = "exec \"\(stateDirectory.path)/tools/node/bin/node\" \""
        let suffix = "/lib/node_modules/openclaw/dist/entry.js\" \"$@\""
        guard lines[2].hasPrefix(prefix), lines[2].hasSuffix(suffix) else { return false }
        let packagePrefix = String(lines[2].dropFirst(prefix.count).dropLast(suffix.count))
        // install-cli.sh owns node and versioned node-* trees; a custom script stays operator-owned.
        let tools = stateDirectory.appendingPathComponent("tools").path + "/"
        guard packagePrefix.hasPrefix(tools) else { return false }
        let node = packagePrefix.dropFirst(tools.count)
        return (node == "node" || node.hasPrefix("node-")) && !node.contains("/") && !node.contains("\"")
    }

    private static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func installShellPath(bin: URL, homeDirectory: URL) {
        let fileManager = FileManager.default
        let exists: (String) -> Bool = { fileManager.fileExists(atPath: homeDirectory.appendingPathComponent($0).path) }
        let bashLogin = exists(".bash_profile") ? ".bash_profile" : exists(".bash_login") ? ".bash_login" : ".profile"
        let fish = ".config/fish/conf.d/openclaw.fish"
        let shell = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh").lastPathComponent
        let primary: [String] = switch shell {
        case "bash": [".bashrc", bashLogin]
        case "zsh": [".zshrc", ".zprofile"]
        case "fish": [fish]
        default: []
        }
        guard !primary.isEmpty else {
            Self.cliLogger.warning("Unrecognized shell; add \(bin.path, privacy: .public) to your shell PATH manually")
            return
        }
        let candidates = [".bashrc", bashLogin, ".zshrc", ".zprofile", fish]
        let targets = Set(primary + candidates.filter(exists))
        let escaped = bin.path
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "`", with: "\\`")
        for target in targets {
            let original = homeDirectory.appendingPathComponent(target)
            do {
                let resolved = original.resolvingSymlinksInPath()
                guard resolved.path.hasPrefix(homeDirectory.resolvingSymlinksInPath().path + "/") else {
                    throw CocoaError(.fileWriteNoPermission, userInfo: [NSFilePathErrorKey: original.path])
                }
                let attributes = try? fileManager.attributesOfItem(atPath: resolved.path)
                if let attributes {
                    guard attributes[.type] as? FileAttributeType == .typeRegular,
                          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid()
                    else { throw CocoaError(.fileWriteNoPermission, userInfo: [NSFilePathErrorKey: original.path]) }
                }
                let line = target == fish ? "fish_add_path -- \"\(escaped)\"" : "export PATH=\"\(escaped):$PATH\""
                let current = attributes == nil ? "" : try String(contentsOf: resolved, encoding: .utf8)
                if current.components(separatedBy: "\n").first == line { continue }
                let remainder = current.components(separatedBy: "\n").filter { $0 != line }.joined(separator: "\n")
                try fileManager.createDirectory(
                    at: resolved.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
                try (line + "\n" + remainder).write(to: resolved, atomically: true, encoding: .utf8)
                if let mode = attributes?[.posixPermissions] {
                    try fileManager.setAttributes([.posixPermissions: mode], ofItemAtPath: resolved.path)
                }
            } catch {
                Self.cliLogger.warning("Shell PATH setup skipped \(original.path, privacy: .public): " +
                    "\(error.localizedDescription, privacy: .public). " +
                    "Add \(bin.path, privacy: .public) to PATH manually.")
            }
        }
    }
}

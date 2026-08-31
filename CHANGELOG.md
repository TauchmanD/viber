# Changelog

All notable changes to Tmux Agent Grid are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project currently uses the version declared in `package.json` and `src-tauri/tauri.conf.json`.

## [Unreleased]

### Added

- Top-bar SSH tunnel management with persistent route definitions, local-only port binding, SSH-agent or identity-file authentication, live process status, and per-tunnel on/off toggles.
- Top-bar running-application inventory with live service counts, Docker Compose and local-project grouping, published-port shortcuts, and persistent per-group opening URLs.
- Configurable arrow-key navigation for spatial terminal focus and previous/next project switching, with persistent bindings, conflict detection, and reset controls in Settings.
- Escape-key navigation from Apps, Tunnels, Repository, and Activity views back to the terminal grid.
- Full remote workspaces through persisted OpenSSH Host profiles, including remote tmux terminals, Git operations, repository browsing, Docker and process discovery, automatic loopback port forwarding, connection tests, and VS Code/Cursor remote launch.

### Fixed

- Fall back to software rendering automatically when no `/dev/dri` render node is present, so the app no longer hangs with an invisible window when a WSLg host's GPU passthrough (`dxgkrnl`) is stuck. Documented the underlying WSL glitch and the `wsl --shutdown` fix in the README.
- OMP and Chromium helper listeners no longer appear as user applications or opening URLs.
- Newly created agent and terminal windows receive keyboard focus immediately.
- Project switches focus the first available terminal, and hovering a terminal window moves keyboard focus to it.

## [0.2.0] - 2026-08-26

### Added

- OMP as the default agent harness, including migration from the legacy exact `codex` project default.
- Structured OMP status detection through terminal breadcrumbs and session JSONL events.
- Color-coded project status squares for working, ready, needs-input, attention, exited, and stopped windows.
- Editable project settings through the project context menu.
- Persistent drag-and-drop project ordering.
- Resizable sidebar width and project/window section proportions with fullscreen-safe persistence.
- Compact portrait mode with project and chat navigation.
- Native chat popout windows that return to their original layout position when closed.
- Application settings dialog with persistent terminal font sizing.
- Icon-based top toolbar and compact navigation controls.
- Git sidebar with branch selection, working-tree state, upstream, ahead/behind counts, refresh, fast-forward pull, and push/publish actions.
- Repository browser with complete Git-visible source tree, documentation filtering, Markdown preview, copy support, and preferred-editor launch.
- Color-coded repository Git graph across all branches with commit selection, refs, parents, author, message, statistics, and changed-file details.
- Per-window activity timeline, prompt tracking, process changes, attributed listening ports, and handoff snapshots.
- JavaScript layout tests and expanded Rust integration tests for tmux, OMP, Git, repository listing, branch switching, pull, push, and graph parsing.
- Automatic post-build installation to `~/.local/bin/tmux-agent-grid`.
- Safe `update.sh` workflow for fast-forward pulls, locked dependency installation, release builds, and local binary updates.
- Linux dependency, OMP setup, development, test, and release-build documentation.

### Changed

- Reworked the interface around a dark near-black palette with violet navigation accents and semantic status colors.
- Moved quick Git controls to the bottom of the left sidebar.
- Moved preferred-editor launch out of project rows and into the repository browser and project context menu.
- Made compact mode a focused mobile-style layout rather than only hiding the sidebar.
- Made normal-mode chat popouts use a desktop-sized window.
- Updated repository browsing to honor `.gitignore` while preserving tracked extensionless files.
- Made release builds copy required frontend vendor assets before compiling.

### Fixed

- Sidebar section position resetting after entering and leaving fullscreen.
- New agent windows inheriting the old exact `codex` project default.
- Narrow layouts reserving hidden sidebar grid space.
- Compact topbar overflow and pointer-capture cleanup during sidebar resizing.
- Repository panel refresh synchronization when changing projects or opening conflicting views.
- Chat reconnection after closing a native popout.
- Portable desktop launcher execution without a hard-coded user home directory.

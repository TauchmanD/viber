# Tmux Agent Grid

A Linux Tauri desktop application for organizing persistent tmux terminals and coding agents into draggable, tiled projects.

## Features

- Projects group related agent and terminal windows under a default directory and command.
- Right-click a project name to edit its settings; drag project rows to persist a custom order.
- Project status squares show one color-coded state per open window: working, ready, needs input, attention, exited, or stopped.
- OMP is the default coding-agent command. OMP status is read from its terminal breadcrumb and structured session log instead of inferred from terminal redraws.
- Codex sessions retain explicit rollout-state detection and full-conversation handoff forks.
- Every window runs in a persistent tmux session and survives closing the application.
- Windows can be dragged, split, swapped, resized, maximized, automatically tiled, or popped into a separate native window.
- Compact mode provides a pinned `390×780` portrait window with hamburger navigation between projects and chats.
- Per-project layouts, sidebar width, and sidebar section proportions persist between launches.
- Activity timelines retain prompts, process changes, ports, and handoffs for up to 30 days.
- Listening TCP ports are attributed to their owning tmux pane and can be opened or copied from the UI.
- Terminal font size is configured under Settings or with `Ctrl++`, `Ctrl+-`, `Ctrl+0`, and `Ctrl+mouse wheel`.
- `Ctrl+Shift+C` copies terminal selections while `Ctrl+C` remains available for interrupts.
- Shift+Tab is forwarded as back-tab, and Shift+Enter inserts a new line in agent chats.

## Supported platform

The application currently targets Linux desktops. Its persistence and process-status backend directly uses `tmux`, `/proc`, and Linux socket information.

Windows is not a native target. The practical Windows option is Linux under WSL2 with WSLg; see [Windows support](#windows-support).

## Requirements

Required to build and run:

- Linux desktop session with WebKitGTK 4.1 support
- Node.js 20 or newer and npm
- Stable Rust toolchain, including Cargo
- `tmux` available on `PATH`
- Tauri v2 Linux system libraries

Runtime agent commands are configurable per project. `omp` must be on `PATH` to use the default OMP integration. Codex, Claude, OpenCode, and other interactive commands are optional alternatives. Git is optional but required for complete handoff repository snapshots.

### Debian or Ubuntu dependencies

These packages follow the official [Tauri v2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/) and add tmux:

```bash
sudo apt update
sudo apt install tmux libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### Arch Linux dependencies

```bash
sudo pacman -Syu
sudo pacman -S --needed tmux webkit2gtk-4.1 base-devel curl wget file \
  openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

For other distributions, install the equivalent WebKitGTK 4.1 development package, compiler toolchain, OpenSSL development headers, app-indicator library, librsvg, and tmux. Consult the current [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) when package names differ.

### Rust

Install stable Rust with rustup:

```bash
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
```

Restart the shell afterward, or load Cargo immediately:

```bash
source "$HOME/.cargo/env"
```

Confirm the toolchain:

```bash
rustc --version
cargo --version
```

### Node.js

Install Node.js 20 or newer using the Node.js LTS installer, your distribution, or a version manager. Confirm both executables:

```bash
node --version
npm --version
```

## Installation from source

Clone the repository and install the locked JavaScript dependencies:

```bash
git clone https://github.com/TauchmanD/viber.git tmux-agent-grid
cd tmux-agent-grid
npm ci
```

Run the checks before building:

```bash
npm run check
npm test
```

Build the optimized standalone application:

```bash
npm run build -- --no-bundle
```

The build writes and installs the executable at:

```text
src-tauri/target/release/tmux-agent-grid
~/.local/bin/tmux-agent-grid
```

Ensure the local binary directory is on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that export to your shell profile if necessary, then launch:

```bash
tmux-agent-grid
```

### Optional desktop launcher

After the release build, install the launcher and icon for the current user:

```bash
install -Dm644 tmux-agent-grid.desktop \
  "$HOME/.local/share/applications/tmux-agent-grid.desktop"
install -Dm644 public/icon.svg \
  "$HOME/.local/share/icons/hicolor/scalable/apps/tmux-agent-grid.svg"
```

Log out and back in, or refresh the desktop application database if the launcher does not appear immediately.

## Development

Install dependencies once with `npm ci`, then start the Tauri development application:

```bash
npm run dev
```

The development command copies the locked xterm.js assets from `node_modules` into the ignored `public/vendor` directory before starting `tauri dev`.

Application state is stored in Tauri's per-user application-data directory. Project pane layouts and UI preferences are stored in the webview's local storage. tmux sessions remain active after the webview or application closes.

## Checks and tests

Run JavaScript syntax checks and the Rust compile check:

```bash
npm run check
```

Run JavaScript unit tests and Rust tests:

```bash
npm test
```

The Rust suite includes short-lived tmux lifecycle tests, so tmux must be installed and usable by the current user.

## Release builds

### Standalone executable

```bash
npm run build -- --no-bundle
```

This performs the frontend vendor copy, optimized Tauri build, and post-build installation to `~/.local/bin/tmux-agent-grid`.

### AppImage

```bash
npm run build
```

The configured bundle target is AppImage. Bundle output is written below:

```text
src-tauri/target/release/bundle/appimage/
```

Build distributable AppImages on the oldest supported Linux distribution so the executable does not accidentally require newer glibc or system-library versions.

## Windows support

The current backend launches tmux directly and uses Linux-specific process and socket APIs, so merely cross-compiling does not create a functional native Windows build.

To run under Windows, install the Linux requirements inside WSL2, enable WSLg, keep the repository in the WSL filesystem, and run `npm run dev` or the Linux release build there. Native Windows support would require replacing tmux with a Windows session host such as a ConPTY-based service.

## Project structure

```text
public/                  Plain HTML, CSS, and JavaScript frontend
public/ui-layout.js      Shared, testable UI sizing constraints
scripts/copy-vendor.mjs  Frontend dependency copy step
scripts/install-local.mjs
                         Release installation into ~/.local/bin
src-tauri/src/           Rust state, PTY, tmux, status, and Tauri commands
tests/                   Node.js frontend unit tests
src-tauri/tauri.conf.json
                         Desktop window and bundle configuration
```

Generated frontend vendor files, local dependencies, build artifacts, application state, and legacy `.data` state are intentionally excluded from Git.

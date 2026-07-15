# Tmux Agent Grid

A lightweight Tauri desktop application for organizing persistent terminals and coding agents into draggable, tiled projects.

## Features

- Projects group related terminal windows under a default directory and agent command.
- The project sidebar shows how many agents have recent terminal activity without opening the project.
- Windows can run a coding agent or a normal interactive terminal.
- Every window runs in a persistent tmux session, so it survives closing the app.
- Live status distinguishes running, waiting, exited, ready-terminal, and stopped states.
- Windows can be dragged, split, swapped, resized, maximized, or automatically tiled.
- Layouts are saved separately for each project.

## Requirements

The application currently targets Linux desktops. To build it you need:

- Node.js 20 or newer and npm
- The stable Rust toolchain, including Cargo
- tmux available on `PATH`
- Tauri's Linux system libraries

On Debian or Ubuntu, install tmux and the current Tauri v2 prerequisites with:

```bash
sudo apt update
sudo apt install tmux libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Install Rust with [rustup](https://rustup.rs/) and install the Node.js LTS release if they are not already present. Tauri also lists packages for Arch, Fedora, openSUSE, Alpine, and other distributions in its [official prerequisites guide](https://v2.tauri.app/start/prerequisites/).

## Development

Clone the repository, then install the locked JavaScript dependencies:

```bash
git clone <repository-url>
cd tmux-agent-grid
npm ci
```

If Cargo was just installed and is not yet available in the shell, reload the shell or run:

```bash
source ~/.cargo/env
```

Start the development application:

```bash
npm run dev
```

`npm run dev` copies xterm.js from `node_modules` into the generated `public/vendor` directory before starting Tauri.

## Checks and tests

Run the JavaScript syntax check and Rust compile check:

```bash
npm run check
```

Run the Rust tests:

```bash
npm test
```

The session lifecycle test starts short-lived tmux sessions, so tmux must be installed and usable by the current user.

## Release build

Build an optimized standalone executable:

```bash
npm run build -- --no-bundle
```

The binary is written to:

```text
src-tauri/target/release/tmux-agent-grid
```

To build the configured AppImage bundle instead, run:

```bash
npm run build
```

AppImages should be built on an older supported Linux distribution so they do not accidentally depend on system libraries newer than those on the target machines.

## Windows support

Not as a native Windows application today. Tauri and the PTY library support Windows, but this application's persistence and process-status backend directly launches the `tmux` executable. The tmux project supports Unix-like platforms and does not provide a native Windows build.

The practical Windows option is to build and run the Linux application inside WSL2 with WSLg. Install the Linux requirements above inside the WSL distribution, keep the repository in the WSL filesystem, and run `npm run dev` there. A Windows-native release would require replacing the tmux backend with a Windows session host (for example, a ConPTY-based service); merely cross-compiling the current source is not enough.

## Project structure

```text
public/                 Plain HTML, CSS, and JavaScript frontend
scripts/copy-vendor.mjs Frontend dependency copy step
src-tauri/src/          Rust state, PTY, tmux, and Tauri commands
src-tauri/tauri.conf.json
                        Desktop window and bundle configuration
```

Application state is stored in Tauri's per-user application data directory. Project layouts are stored in the webview's local storage. Local dependencies, build artifacts, copied vendor files, and legacy `.data` state are intentionally excluded from Git.

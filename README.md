# Chat Wrapper

Unofficial Google Chat desktop app (Electron) with background notifications.

## Download Now

Download the latest version from the [releases page](https://github.com/Smef/chat-wrapper/releases).

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) (this project uses pnpm for package management, pinned via the `devEngines.packageManager` field in [package.json](package.json))

Follow the instructions on the [pnpm website](https://pnpm.io/installation) to install pnpm.

## Installing

Clone the repo and install dependencies:

```bash
pnpm install
```

## Developing

Launch the app in Electron:

```bash
pnpm start
```

This runs `electron .`, which starts the app using [src/main.js](src/main.js) as the entry point. Restart the command after making changes, since there's no hot-reload configured.

## Building

Package the app for distribution with [electron-builder](https://www.electron.build/):

```bash
pnpm dist
```

Build output is written to `dist/`. Platform-specific targets are configured in the `build` field of [package.json](package.json):

- **macOS**: `.dmg` (arm64/Intel)
- **Windows**: NSIS installer
- **Linux**: AppImage

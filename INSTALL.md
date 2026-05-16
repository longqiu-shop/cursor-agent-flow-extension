# Installation Guide

## Quick Install (Recommended)

### Step 1: Download the Extension

1. Go to [Releases](https://github.com/jolocity/cursor-agent-scheduler/releases)
2. Download the latest `cursor-agent-scheduler-*.vsix` file

### Step 2: Install in Cursor

1. Open **Cursor**
2. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
3. Type: `Extensions: Install from VSIX...`
4. Select the downloaded `.vsix` file
5. Click **Reload** when prompted

That's it! The extension is now installed.

---

## Install from Source

If you want to build it yourself or contribute:

### Prerequisites

- [Cursor](https://cursor.sh) IDE
- [Node.js](https://nodejs.org/) 18 or higher
- [pnpm](https://pnpm.io/)

### Steps

1. **Clone the repository:**
   ```bash
   git clone https://github.com/jolocity/cursor-agent-scheduler.git
   cd cursor-agent-scheduler
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```

3. **Build the extension:**
   ```bash
   pnpm run compile
   ```

4. **Package as VSIX:**
   ```bash
   pnpm run package
   ```
   This creates `cursor-agent-scheduler-1.0.0.vsix` in the project root.

5. **Install the VSIX:**
   - Open Cursor
   - Press `Cmd+Shift+P` / `Ctrl+Shift+P`
   - Run: `Extensions: Install from VSIX...`
   - Select the `.vsix` file

---

## Development Mode

To run the extension in development mode (for contributing):

1. Clone and install dependencies (steps 1-2 above)
2. Open the project folder in Cursor
3. Press `F5` to launch Extension Development Host
4. The extension will be active in the new window

---

## Verify Installation

After installation, you should see:

1. **"Agent Schedules"** in the sidebar (Activity Bar)
2. Commands available in Command Palette:
   - `Agent Schedules: Add Schedule`
   - `Agent Schedules: Test Execution`
   - etc.

If you don't see these, try:
- Reload Cursor (`Cmd+R` / `Ctrl+R`)
- Check if the extension is enabled in Extensions view

---

## Troubleshooting

### Extension not appearing?

1. Check Extensions view (`Cmd+Shift+X`) - is it installed and enabled?
2. Reload Cursor window
3. Check Output panel for errors: `View` → `Output` → Select "Cursor Agent Scheduler"

### Build errors?

- Make sure Node.js 18+ is installed: `node --version`
- Delete `node_modules`, then run `pnpm install` again
- Check that TypeScript compiles: `pnpm run compile`

### Installation from VSIX fails?

- Make sure you're using Cursor (not VS Code) - the extension is Cursor-specific
- Try installing from Command Palette instead of drag-and-drop
- Check that the `.vsix` file isn't corrupted (re-download if needed)

---

## Need Help?

- Open an [Issue](https://github.com/jolocity/cursor-agent-scheduler/issues)
- Check the [README](README.md) for usage instructions

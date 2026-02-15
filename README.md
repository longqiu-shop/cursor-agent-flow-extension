# Cursor Agent Scheduler

A VS Code extension for [Cursor](https://cursor.sh) that lets you schedule and automatically run AI agent prompts using cron schedules.

## Features

- **Schedule AI Prompts**: Set up cron-based schedules to run prompts automatically
- **Inline Prompts**: Write prompts directly in the schedule configuration
- **Command Files**: Reference reusable command definitions from `.cursor/commands/`
- **Variable Substitution**: Use `{datetime}`, `{date}`, `{time}`, `{timestamp}` in prompts
- **Run History**: Track execution history and results
- **Shareable Schedules**: Store schedules in `.cursor/agent-schedules.json` for team sharing

## Installation

### Option 1: Install from Cursor Marketplace (Easiest)

1. Open Cursor
2. Go to Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`)
3. Search for "Cursor Agent Scheduler"
4. Click **Install**

The extension will be available from [Open VSX](https://open-vsx.org/) once published.

### Option 2: Install from VSIX Package

1. Download the latest `.vsix` file from [Releases](https://github.com/jolocity/cursor-agent-scheduler/releases)
2. Open Cursor
3. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
4. Run: `Extensions: Install from VSIX...`
5. Select the downloaded `.vsix` file
6. Reload Cursor when prompted

### Option 2: Install from Source (Development)

1. Clone this repository:
   ```bash
   git clone https://github.com/jolocity/cursor-agent-scheduler.git
   cd cursor-agent-scheduler
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Compile the extension:
   ```bash
   npm run compile
   ```

4. Package the extension:
   ```bash
   npm run package
   ```
   This creates a `.vsix` file in the project root.

5. Install the VSIX in Cursor:
   - Open Command Palette (`Cmd+Shift+P`)
   - Run: `Extensions: Install from VSIX...`
   - Select the generated `.vsix` file

### Option 3: Development Mode

For active development:

1. Clone and install (steps 1-2 from Option 2)
2. Open the project in Cursor
3. Press `F5` to launch Extension Development Host
4. The extension will be active in the new window

## Usage

### Creating a Schedule

1. Open Command Palette (`Cmd+Shift+P`)
2. Run "Agent Schedules: Add Schedule"
3. Configure your schedule:
   - **Name**: A descriptive name
   - **Cron Schedule**: When to run (e.g., `0 9 * * *` for 9 AM daily)
   - **Target**: Choose "Inline Prompt" or "Command File"
   - **Prompt**: Your AI prompt (supports variables like `{datetime}`)

### Cron Schedule Examples

| Schedule | Description |
|----------|-------------|
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour |
| `0 9 * * *` | Daily at 9 AM |
| `0 9 * * 1-5` | Weekdays at 9 AM |
| `0 0 * * 0` | Weekly on Sunday |

### Variable Substitution

Use these variables in your prompts:

- `{datetime}` - Current date and time (e.g., `2026-01-18-10-30-00`)
- `{date}` - Current date (e.g., `2026-01-18`)
- `{time}` - Current time (e.g., `10:30:00`)
- `{timestamp}` - Unix timestamp

Example prompt:
```
Create a file called report-{datetime}.md with a summary of today's tasks
```

### Command Files

Create reusable command definitions in `.cursor/commands/`:

```markdown
---
id: daily-report
name: Daily Report
description: Generate a daily status report
---

# Daily Report Generator

Create a markdown file with today's date containing:
1. Summary of completed tasks
2. Pending items
3. Blockers
```

### Schedule Configuration

Schedules are stored in `.cursor/agent-schedules.json`:

```json
{
  "schedules": [
    {
      "id": "unique-id",
      "name": "Daily Report",
      "enabled": true,
      "cronSchedule": "0 9 * * 1-5",
      "targetType": "prompt",
      "inlinePrompt": "Generate a status report for {date}",
      "executionMode": "ide"
    }
  ]
}
```

## Commands

| Command | Description |
|---------|-------------|
| Agent Schedules: Add Schedule | Create a new schedule |
| Agent Schedules: Edit | Edit an existing schedule |
| Agent Schedules: Run Now | Execute a schedule immediately |
| Agent Schedules: Enable | Enable a disabled schedule |
| Agent Schedules: Disable | Disable a schedule |
| Agent Schedules: View Run History | View execution history |
| Agent Schedules: Test Execution | Test agent execution with a sample prompt |

## How It Works

The extension uses Cursor's internal VS Code commands to execute prompts:

1. Opens the chat with the prompt pre-filled using `workbench.action.chat.open`
2. Submits the prompt using `composer.triggerCreateWorktreeButton`
3. Monitors for file changes to track execution results

## Requirements

- [Cursor](https://cursor.sh) IDE
- Node.js 18+

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (auto-compile on changes)
npm run watch

# Package extension as .vsix
npm run package

# Run extension in development mode
Press F5 in Cursor
```

## Building for Distribution

To create a distributable `.vsix` package:

```bash
npm install
npm run package
```

This will create `cursor-agent-scheduler-1.0.0.vsix` in the project root, which can be shared and installed in Cursor.

## License

MIT

## Publishing

This extension is published to [Open VSX](https://open-vsx.org/), which Cursor uses as its extension marketplace.

See [PUBLISH.md](PUBLISH.md) for instructions on how to publish updates.

## Contributing

Contributions welcome! Please open an issue or PR.

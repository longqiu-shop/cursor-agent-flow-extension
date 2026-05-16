# Configuring Additional Command Directories

The Cursor Agent Scheduler extension can load commands from multiple locations:

## Default Locations

1. **Workspace folders**: `.cursor/commands` in each open workspace
2. **User home directory**: `~/.cursor/commands` (if it exists)

## Adding Custom Command Directories

To load commands from additional directories (like your Personal/AI-Assistant folder), add them to your VS Code settings:

### Method 1: Using Settings UI

1. Open VS Code Settings (`Cmd+,` or `Ctrl+,`)
2. Search for "Agent Schedules"
3. Find "Additional Command Directories"
4. Click "Edit in settings.json"
5. Add your directory path(s):

```json
{
  "agentSchedules.additionalCommandDirectories": [
    "~/Dropbox/Personal/Jose Lopez/AI-Assistant/.cursor/commands"
  ]
}
```

### Method 2: Direct settings.json Edit

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Type "Preferences: Open User Settings (JSON)"
3. Add the configuration:

```json
{
  "agentSchedules.additionalCommandDirectories": [
    "~/Dropbox/Personal/Jose Lopez/AI-Assistant/.cursor/commands"
  ]
}
```

## Path Format

- **Absolute paths**: `/Users/jolocity/Dropbox/Personal/Jose Lopez/AI-Assistant/.cursor/commands`
- **Home directory shortcut**: `~/Dropbox/Personal/Jose Lopez/AI-Assistant/.cursor/commands`
- **Relative paths**: Resolved relative to the workspace folder

## Multiple Directories

You can specify multiple directories:

```json
{
  "agentSchedules.additionalCommandDirectories": [
    "~/Dropbox/Personal/Jose Lopez/AI-Assistant/.cursor/commands",
    "~/Documents/MyCommands/.cursor/commands",
    "/absolute/path/to/commands"
  ]
}
```

## Reloading Commands

After adding directories:
1. The extension will automatically reload commands when files change
2. Or manually reload using: `Agent Schedules: Reload Commands`

## Example

To load your Personal/AI-Assistant commands:

```json
{
  "agentSchedules.additionalCommandDirectories": [
    "~/Dropbox/Personal/Jose Lopez/AI-Assistant/.cursor/commands"
  ]
}
```

After saving, your commands from that directory (like `classroom-daily.md`, `business-runner.md`, etc.) will be available in all Cursor sessions!

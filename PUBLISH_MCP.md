# Publishing to Open VSX using Playwright MCP Server

This guide shows how to use the Playwright MCP server tools to automate publishing your extension to Open VSX.

## Prerequisites

1. VSIX file packaged: `cursor-agent-scheduler-1.0.0.vsix`
2. Playwright MCP server running (configured in `~/.cursor/mcp.json`)
3. Open VSX account (GitHub OAuth)

## MCP Tool Sequence

Execute these Playwright MCP tools in order:

### Step 1: Navigate to Open VSX
```json
{
  "tool": "browser_navigate",
  "inputs": {
    "url": "https://open-vsx.org/"
  }
}
```

### Step 2: Wait for page load
```json
{
  "tool": "browser_wait_for",
  "inputs": {
    "state": "networkidle",
    "timeout": 30
  }
}
```

### Step 3: Get page snapshot (to see current state)
```json
{
  "tool": "browser_snapshot",
  "inputs": {}
}
```

### Step 4: Click Sign In (if not already signed in)
```json
{
  "tool": "browser_click",
  "inputs": {
    "element": "text=Sign In",
    "button": "left"
  }
}
```

**Note:** You may need to complete GitHub OAuth manually at this point.

### Step 5: Wait for authentication
```json
{
  "tool": "browser_wait_for",
  "inputs": {
    "url": "open-vsx.org",
    "timeout": 60
  }
}
```

### Step 6: Navigate to namespaces page
```json
{
  "tool": "browser_navigate",
  "inputs": {
    "url": "https://open-vsx.org/user-settings/namespaces"
  }
}
```

### Step 7: Wait for page load
```json
{
  "tool": "browser_wait_for",
  "inputs": {
    "state": "networkidle",
    "timeout": 30
  }
}
```

### Step 8: Navigate to publish page
```json
{
  "tool": "browser_navigate",
  "inputs": {
    "url": "https://open-vsx.org/publish"
  }
}
```

### Step 9: Wait for publish page
```json
{
  "tool": "browser_wait_for",
  "inputs": {
    "state": "networkidle",
    "timeout": 30
  }
}
```

### Step 10: Upload VSIX file
```json
{
  "tool": "browser_upload",
  "inputs": {
    "element": "input[type='file']",
    "paths": ["/Users/jolocity/Documents/cursor-agent-scheduler/cursor-agent-scheduler-1.0.0.vsix"]
  }
}
```

**Alternative:** If `browser_upload` is not available, use:
```json
{
  "tool": "browser_click",
  "inputs": {
    "element": "input[type='file']",
    "button": "left"
  }
}
```
Then manually select the file, or use `browser_type` to set the file path.

### Step 11: Wait for upload processing
```json
{
  "tool": "browser_wait_for",
  "inputs": {
    "timeout": 5
  }
}
```

### Step 12: Click Publish button
```json
{
  "tool": "browser_click",
  "inputs": {
    "element": "button:has-text('Publish')",
    "button": "left"
  }
}
```

### Step 13: Wait for success confirmation
```json
{
  "tool": "browser_wait_for",
  "inputs": {
    "text": "success",
    "timeout": 60
  }
}
```

### Step 14: Get final snapshot to verify
```json
{
  "tool": "browser_snapshot",
  "inputs": {}
}
```

## Using with Cursor AI

You can ask Cursor AI to execute these steps using the Playwright MCP tools. For example:

> "Use Playwright MCP to navigate to open-vsx.org, sign in, and publish the extension cursor-agent-scheduler-1.0.0.vsix"

## Troubleshooting

- **Element not found**: Use `browser_snapshot` to see the current page state and adjust selectors
- **Upload fails**: Try using `browser_type` to set the file input value directly
- **OAuth required**: Complete GitHub sign-in manually when prompted
- **Timeout errors**: Increase timeout values in `browser_wait_for` calls

## Verification

After publishing, verify at:
- https://open-vsx.org/extension/jolocity/cursor-agent-scheduler
- Wait 5-10 minutes for it to appear in Cursor's extension marketplace

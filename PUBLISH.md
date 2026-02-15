# Publishing to Cursor Extension Marketplace

Cursor uses **Open VSX** as its extension marketplace. To make your extension available in Cursor, you need to publish it to Open VSX.

## Prerequisites

1. **Open VSX Account**: Create an account at [open-vsx.org](https://open-vsx.org/)
2. **Personal Access Token**: Generate a token for publishing (see steps below)
3. **Published Extension**: Your extension must be packaged as a `.vsix` file

## Quick Start (Automated)

### Option A: Using CLI Script (Recommended)

The easiest way to publish is using the automated CLI script:

```bash
npm run publish:openvsx
```

This will:
1. Check if VSIX file exists (builds it if needed)
2. Prompt for your Open VSX access token
3. Publish the extension automatically

**Or with token:**
```bash
npm run publish:openvsx -- --token YOUR_ACCESS_TOKEN
```

### Option B: Using Playwright Automation

For a more visual, step-by-step automation:

```bash
npm run publish:automate
```

This opens a browser and automates the publishing flow. You may need to complete GitHub OAuth manually.

---

## Manual Publishing Guide

If you prefer to publish manually or the automation doesn't work:

### Step 1: Create Open VSX Account

1. Go to [open-vsx.org](https://open-vsx.org/)
2. Click **Sign In** (top right)
3. Sign in with GitHub (recommended) or create an account
4. Complete your profile

### Step 2: Generate Personal Access Token

1. Go to your [Open VSX profile](https://open-vsx.org/user-settings/namespaces)
2. Click **Create Publisher** (if you haven't already)
3. Create a namespace (e.g., `jolocity` - must match your `package.json` publisher)
4. Go to **Access Tokens** section
5. Click **Create Token**
6. Copy the token (you'll need it for publishing)

### Step 3: Install Publishing Tool

Install the Open VSX CLI:

```bash
npm install -g @openvsx/cli
```

Or use npx (no global install needed):

```bash
npx @openvsx/cli publish
```

### Step 4: Package Your Extension

Make sure your extension is built and packaged:

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package as VSIX
npm run package
```

This creates `cursor-agent-scheduler-1.0.0.vsix` in the project root.

### Step 5: Publish to Open VSX

**Option A: Using CLI (Recommended)**

```bash
# Using npx (no global install)
npx @openvsx/cli publish cursor-agent-scheduler-1.0.0.vsix -p YOUR_ACCESS_TOKEN

# Or if installed globally
ovsx publish cursor-agent-scheduler-1.0.0.vsix -p YOUR_ACCESS_TOKEN
```

**Option B: Using Web Interface**

1. Go to [open-vsx.org](https://open-vsx.org/)
2. Navigate to your namespace
3. Click **Publish Extension**
4. Upload your `.vsix` file
5. Fill in metadata if needed

### Step 6: Verify Publication

1. Visit your extension page: `https://open-vsx.org/extension/jolocity/cursor-agent-scheduler`
2. Check that all metadata is correct
3. Test installation in Cursor (may take a few minutes to appear)

## Publishing Checklist

Before publishing, verify:

- [ ] `package.json` has correct `publisher` field (matches Open VSX namespace)
- [ ] `package.json` has `repository`, `homepage`, and `bugs` URLs
- [ ] Extension version is correct and follows semver
- [ ] README.md is complete and helpful
- [ ] LICENSE file exists
- [ ] Extension compiles without errors
- [ ] Extension works in Cursor (test with F5)
- [ ] All dependencies are listed in `package.json`

## Updating Your Extension

To publish an update:

1. Update version in `package.json` (e.g., `1.0.0` → `1.0.1`)
2. Update CHANGELOG.md (if you have one)
3. Rebuild and package:
   ```bash
   npm run compile
   npm run package
   ```
4. Publish the new `.vsix` file:
   ```bash
   npx @openvsx/cli publish cursor-agent-scheduler-1.0.1.vsix -p YOUR_ACCESS_TOKEN
   ```

## Troubleshooting

### "Publisher namespace not found"

- Make sure you've created a namespace on Open VSX
- The namespace must match the `publisher` field in `package.json`
- Check your namespace at: https://open-vsx.org/user-settings/namespaces

### "Extension already exists"

- Update the version number in `package.json`
- Rebuild and republish

### Extension not appearing in Cursor

- Wait 5-10 minutes for propagation
- Check that extension is published on Open VSX
- Verify it's compatible with Cursor (uses standard VS Code APIs)
- Try searching for it by full name: `jolocity.cursor-agent-scheduler`

### Publishing fails

- Verify your access token is correct
- Check that `.vsix` file is valid (try installing it manually first)
- Ensure all required fields in `package.json` are present

## Resources

- [Open VSX Documentation](https://github.com/eclipse/openvsx/wiki)
- [Open VSX Publishing Guide](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions)
- [Cursor Extension Forum](https://forum.cursor.com/t/adding-extensions-to-cursor/132598)

## Notes

- **No manual submission to Cursor required** - once on Open VSX, it automatically appears in Cursor
- Extensions are free to publish on Open VSX
- Cursor users can install directly from the Extensions view
- Updates are handled automatically when you publish new versions

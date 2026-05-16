"use strict";
/**
 * Playwright script to automate publishing to Open VSX
 *
 * Usage:
 *   pnpm exec playwright test scripts/publish-to-openvsx.ts --headed
 *
 * Note: Some steps (like GitHub OAuth) may require manual interaction
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const test_1 = require("@playwright/test");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const EXTENSION_NAME = 'cursor-agent-scheduler';
const VERSION = '1.0.0';
const VSIX_FILE = `${EXTENSION_NAME}-${VERSION}.vsix`;
const VSIX_PATH = path.join(process.cwd(), VSIX_FILE);
test_1.test.describe('Publish to Open VSX', () => {
    (0, test_1.test)('Publish extension to Open VSX', async ({ page }) => {
        // Check if VSIX file exists
        if (!fs.existsSync(VSIX_PATH)) {
            throw new Error(`VSIX file not found: ${VSIX_PATH}\nRun 'pnpm run package' first.`);
        }
        console.log(`📦 Publishing ${VSIX_FILE} to Open VSX...`);
        // Step 1: Navigate to Open VSX
        console.log('🌐 Navigating to Open VSX...');
        await page.goto('https://open-vsx.org/');
        // Step 2: Sign in
        console.log('🔐 Signing in...');
        const signInButton = page.locator('text=Sign In').first();
        if (await signInButton.isVisible()) {
            await signInButton.click();
            // Wait for GitHub OAuth - user may need to complete this manually
            console.log('⏳ Waiting for GitHub OAuth...');
            console.log('⚠️  Please complete GitHub sign-in manually if needed');
            await page.waitForURL(/open-vsx\.org/, { timeout: 60000 });
        }
        // Step 3: Navigate to user settings/namespace
        console.log('👤 Navigating to user settings...');
        await page.goto('https://open-vsx.org/user-settings/namespaces');
        // Wait for page to load
        await page.waitForLoadState('networkidle');
        // Step 4: Check if namespace exists, create if not
        const namespaceInput = page.locator('input[placeholder*="namespace"], input[name*="namespace"]').first();
        if (await namespaceInput.isVisible()) {
            console.log('📝 Creating namespace...');
            await namespaceInput.fill('jolocity');
            const createButton = page.locator('button:has-text("Create"), button:has-text("Submit")').first();
            if (await createButton.isVisible()) {
                await createButton.click();
                await page.waitForTimeout(2000);
            }
        }
        else {
            console.log('✅ Namespace already exists or not needed');
        }
        // Step 5: Navigate to publish page
        console.log('📤 Navigating to publish page...');
        await page.goto('https://open-vsx.org/user-settings/publisher-agreement');
        // Accept agreement if needed
        const acceptButton = page.locator('button:has-text("Accept"), button:has-text("Agree")').first();
        if (await acceptButton.isVisible()) {
            console.log('📋 Accepting publisher agreement...');
            await acceptButton.click();
            await page.waitForTimeout(1000);
        }
        // Navigate to publish extension page
        await page.goto('https://open-vsx.org/');
        // Look for publish button or navigate directly
        const publishLink = page.locator('a:has-text("Publish"), a[href*="publish"]').first();
        if (await publishLink.isVisible()) {
            await publishLink.click();
        }
        else {
            // Try direct navigation
            await page.goto('https://open-vsx.org/publish');
        }
        await page.waitForLoadState('networkidle');
        // Step 6: Upload VSIX file
        console.log('📎 Uploading VSIX file...');
        const fileInput = page.locator('input[type="file"]').first();
        if (await fileInput.isVisible()) {
            await fileInput.setInputFiles(VSIX_PATH);
            console.log(`✅ Uploaded ${VSIX_FILE}`);
            await page.waitForTimeout(2000);
        }
        else {
            console.log('⚠️  File input not found. You may need to upload manually.');
            console.log(`   File location: ${VSIX_PATH}`);
        }
        // Step 7: Fill in metadata if needed
        console.log('📝 Checking for metadata fields...');
        const nameField = page.locator('input[name*="name"], input[placeholder*="name"]').first();
        if (await nameField.isVisible()) {
            await nameField.fill(EXTENSION_NAME);
        }
        // Step 8: Submit/Upload
        const submitButton = page.locator('button:has-text("Publish"), button:has-text("Upload"), button:has-text("Submit")').first();
        if (await submitButton.isVisible()) {
            console.log('🚀 Submitting extension...');
            await submitButton.click();
            // Wait for success message or redirect
            await page.waitForTimeout(5000);
            // Check for success indicators
            const successMessage = page.locator('text=/success|published|uploaded/i').first();
            if (await successMessage.isVisible({ timeout: 10000 })) {
                console.log('✅ Extension published successfully!');
            }
            else {
                console.log('⚠️  Please verify publication manually');
            }
        }
        else {
            console.log('⚠️  Submit button not found. Please complete publication manually.');
        }
        // Keep browser open for manual verification
        console.log('\n✅ Automation complete!');
        console.log('📋 Please verify:');
        console.log('   1. Extension is published on Open VSX');
        console.log('   2. Check: https://open-vsx.org/extension/jolocity/cursor-agent-scheduler');
        console.log('   3. Wait 5-10 minutes for it to appear in Cursor');
        // Keep page open for 30 seconds for manual verification
        await page.waitForTimeout(30000);
    });
});
//# sourceMappingURL=publish-to-openvsx.js.map
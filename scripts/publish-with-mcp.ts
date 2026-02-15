/**
 * Script to publish extension to Open VSX using Playwright
 * This script can be run directly with ts-node or through the Playwright MCP server
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const EXTENSION_NAME = 'cursor-agent-scheduler';
const VERSION = '1.0.0';
const VSIX_FILE = `${EXTENSION_NAME}-${VERSION}.vsix`;
const VSIX_PATH = path.join(process.cwd(), VSIX_FILE);

async function publishToOpenVSX() {
  // Check if VSIX file exists
  if (!fs.existsSync(VSIX_PATH)) {
    throw new Error(`VSIX file not found: ${VSIX_PATH}\nRun 'npm run package' first.`);
  }

  console.log(`📦 Publishing ${VSIX_FILE} to Open VSX...`);

  // Launch browser
  const browser = await chromium.launch({ 
    headless: false, // Keep visible for manual OAuth steps
    channel: 'chrome' // Use Chrome if available
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Step 1: Navigate to Open VSX
    console.log('🌐 Navigating to Open VSX...');
    await page.goto('https://open-vsx.org/');
    
    // Step 2: Sign in
    console.log('🔐 Signing in...');
    const signInButton = page.locator('text=Sign In').first();
    if (await signInButton.isVisible({ timeout: 5000 })) {
      await signInButton.click();
      
      // Wait for GitHub OAuth - user may need to complete this manually
      console.log('⏳ Waiting for GitHub OAuth...');
      console.log('⚠️  Please complete GitHub sign-in manually if needed');
      await page.waitForURL(/open-vsx\.org/, { timeout: 60000 });
    } else {
      console.log('✅ Already signed in or sign-in button not found');
    }

    // Step 3: Navigate to user settings/namespace
    console.log('👤 Navigating to user settings...');
    await page.goto('https://open-vsx.org/user-settings/namespaces');
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Step 4: Check if namespace exists, create if not
    const namespaceInput = page.locator('input[placeholder*="namespace"], input[name*="namespace"]').first();
    if (await namespaceInput.isVisible({ timeout: 5000 })) {
      console.log('📝 Creating namespace...');
      await namespaceInput.fill('jolocity');
      
      const createButton = page.locator('button:has-text("Create"), button:has-text("Submit")').first();
      if (await createButton.isVisible({ timeout: 2000 })) {
        await createButton.click();
        await page.waitForTimeout(2000);
      }
    } else {
      console.log('✅ Namespace already exists or not needed');
    }

    // Step 5: Navigate to publish page
    console.log('📤 Navigating to publish page...');
    await page.goto('https://open-vsx.org/user-settings/publisher-agreement');
    
    // Accept agreement if needed
    const acceptButton = page.locator('button:has-text("Accept"), button:has-text("Agree")').first();
    if (await acceptButton.isVisible({ timeout: 5000 })) {
      console.log('📋 Accepting publisher agreement...');
      await acceptButton.click();
      await page.waitForTimeout(1000);
    }

    // Navigate to publish extension page
    await page.goto('https://open-vsx.org/');
    
    // Look for publish button or navigate directly
    const publishLink = page.locator('a:has-text("Publish"), a[href*="publish"]').first();
    if (await publishLink.isVisible({ timeout: 5000 })) {
      await publishLink.click();
    } else {
      // Try direct navigation
      await page.goto('https://open-vsx.org/publish');
    }

    await page.waitForLoadState('networkidle');

    // Step 6: Upload VSIX file
    console.log('📎 Uploading VSIX file...');
    const fileInput = page.locator('input[type="file"]').first();
    
    if (await fileInput.isVisible({ timeout: 5000 })) {
      await fileInput.setInputFiles(VSIX_PATH);
      console.log(`✅ Uploaded ${VSIX_FILE}`);
      await page.waitForTimeout(2000);
    } else {
      console.log('⚠️  File input not found. You may need to upload manually.');
      console.log(`   File location: ${VSIX_PATH}`);
    }

    // Step 7: Fill in metadata if needed
    console.log('📝 Checking for metadata fields...');
    const nameField = page.locator('input[name*="name"], input[placeholder*="name"]').first();
    if (await nameField.isVisible({ timeout: 2000 })) {
      await nameField.fill(EXTENSION_NAME);
    }

    // Step 8: Submit/Upload
    const submitButton = page.locator('button:has-text("Publish"), button:has-text("Upload"), button:has-text("Submit")').first();
    if (await submitButton.isVisible({ timeout: 5000 })) {
      console.log('🚀 Submitting extension...');
      await submitButton.click();
      
      // Wait for success message or redirect
      await page.waitForTimeout(5000);
      
      // Check for success indicators
      const successMessage = page.locator('text=/success|published|uploaded/i').first();
      if (await successMessage.isVisible({ timeout: 10000 })) {
        console.log('✅ Extension published successfully!');
      } else {
        console.log('⚠️  Please verify publication manually');
      }
    } else {
      console.log('⚠️  Submit button not found. Please complete publication manually.');
    }

    // Keep browser open for manual verification
    console.log('\n✅ Automation complete!');
    console.log('📋 Please verify:');
    console.log('   1. Extension is published on Open VSX');
    console.log('   2. Check: https://open-vsx.org/extension/jolocity/cursor-agent-scheduler');
    console.log('   3. Wait 5-10 minutes for it to appear in Cursor');
    
    // Keep page open for 30 seconds for manual verification
    console.log('\n⏳ Keeping browser open for 30 seconds for verification...');
    await page.waitForTimeout(30000);
    
  } catch (error) {
    console.error('❌ Error during automation:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Run if executed directly
if (require.main === module) {
  publishToOpenVSX().catch(console.error);
}

export { publishToOpenVSX };

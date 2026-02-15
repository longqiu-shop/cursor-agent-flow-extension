#!/usr/bin/env node
/**
 * CLI wrapper for Open VSX publishing
 * 
 * This script uses the Open VSX CLI to publish the extension.
 * Alternative to the Playwright automation.
 * 
 * Usage:
 *   npm run publish:openvsx
 *   npm run publish:openvsx -- --token YOUR_TOKEN
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const EXTENSION_NAME = 'cursor-agent-scheduler';
const VERSION = require('../package.json').version;
const VSIX_FILE = `${EXTENSION_NAME}-${VERSION}.vsix`;
const VSIX_PATH = path.join(process.cwd(), VSIX_FILE);

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log('🚀 Publishing to Open VSX\n');

  // Check if VSIX exists
  if (!fs.existsSync(VSIX_PATH)) {
    console.error(`❌ VSIX file not found: ${VSIX_PATH}`);
    console.log('📦 Building extension...\n');
    
    // Try to build it
    child_process.execSync('npm run package', { stdio: 'inherit' });
    
    if (!fs.existsSync(VSIX_PATH)) {
      console.error('❌ Failed to create VSIX file');
      process.exit(1);
    }
  }

  console.log(`✅ Found VSIX: ${VSIX_FILE}\n`);

  // Get access token
  let token = process.argv.find(arg => arg.startsWith('--token='))?.split('=')[1];
  
  if (!token) {
    token = process.env.OPENVSX_TOKEN || process.env.OVSX_PAT;
  }

  if (!token) {
    console.log('🔑 Open VSX Access Token required');
    console.log('   Get it from: https://open-vsx.org/user-settings/tokens');
    console.log('   Or set OPENVSX_TOKEN or OVSX_PAT\n');
    token = await prompt('Enter your Open VSX access token: ');
  }

  if (!token) {
    console.error('❌ Access token required');
    process.exit(1);
  }

  // Publish using ovsx (https://www.npmjs.com/package/ovsx)
  console.log(`\n📤 Publishing ${VSIX_FILE} to Open VSX...\n`);
  
  try {
    child_process.execSync(
      `npx ovsx publish "${VSIX_PATH}" --pat "${token}"`,
      { stdio: 'inherit' }
    );
    
    console.log('\n✅ Extension published successfully!');
    console.log(`\n📋 Next steps:`);
    console.log(`   1. Verify: https://open-vsx.org/extension/jolocity/${EXTENSION_NAME}`);
    console.log(`   2. Wait 5-10 minutes for it to appear in Cursor`);
    console.log(`   3. Search for "Cursor Agent Scheduler" in Cursor Extensions`);
    
  } catch (error) {
    console.error('\n❌ Publishing failed');
    console.error(error);
    process.exit(1);
  }
}

main().catch(console.error);

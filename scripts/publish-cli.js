#!/usr/bin/env node
"use strict";
/**
 * CLI wrapper for Open VSX publishing
 *
 * This script uses the Open VSX CLI to publish the extension.
 * Alternative to the Playwright automation.
 *
 * Usage:
 *   pnpm run publish:openvsx
 *   pnpm run publish:openvsx -- --token YOUR_TOKEN
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
const child_process = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
const EXTENSION_NAME = 'cursor-agent-scheduler';
const VERSION = require('../package.json').version;
const VSIX_FILE = `${EXTENSION_NAME}-${VERSION}.vsix`;
const VSIX_PATH = path.join(process.cwd(), VSIX_FILE);
async function prompt(question) {
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
        child_process.execSync('pnpm run package', { stdio: 'inherit' });
        if (!fs.existsSync(VSIX_PATH)) {
            console.error('❌ Failed to create VSIX file');
            process.exit(1);
        }
    }
    console.log(`✅ Found VSIX: ${VSIX_FILE}\n`);
    // Get access token
    let token = process.argv.find(arg => arg.startsWith('--token='))?.split('=')[1];
    if (!token) {
        token = process.env.OPENVSX_TOKEN;
    }
    if (!token) {
        console.log('🔑 Open VSX Access Token required');
        console.log('   Get it from: https://open-vsx.org/user-settings/tokens\n');
        token = await prompt('Enter your Open VSX access token: ');
    }
    if (!token) {
        console.error('❌ Access token required');
        process.exit(1);
    }
    // Publish
    console.log(`\n📤 Publishing ${VSIX_FILE} to Open VSX...\n`);
    try {
        child_process.execSync(`pnpm dlx ovsx publish "${VSIX_PATH}" --pat "${token}"`, { stdio: 'inherit' });
        console.log('\n✅ Extension published successfully!');
        console.log(`\n📋 Next steps:`);
        console.log(`   1. Verify: https://open-vsx.org/extension/jolocity/${EXTENSION_NAME}`);
        console.log(`   2. Wait 5-10 minutes for it to appear in Cursor`);
        console.log(`   3. Search for "Cursor Agent Scheduler" in Cursor Extensions`);
    }
    catch (error) {
        console.error('\n❌ Publishing failed');
        console.error(error);
        process.exit(1);
    }
}
main().catch(console.error);
//# sourceMappingURL=publish-cli.js.map
/**
 * Cursor Agent Executor
 * 
 * Executes prompts in Cursor's AI agent using discovered VS Code commands.
 * 
 * Key Discovery:
 * - Open chat with prompt: workbench.action.chat.open { query: prompt }
 * - Submit/execute: composer.triggerCreateWorktreeButton
 */

import * as vscode from 'vscode';

export interface AgentExecutionResult {
  success: boolean;
  output: string;
  filesCreated?: string[];
  error?: string;
}

export class CursorAgentExecutor {
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Cursor Agent Scheduler');
  }

  /**
   * Execute a prompt using Cursor's AI agent
   */
  async executePrompt(prompt: string): Promise<AgentExecutionResult> {
    this.log(`Executing prompt: ${prompt.substring(0, 50)}...`);

    const filesBefore = await this.getWorkspaceFiles();

    try {
      // Step 1: Open chat with prompt pre-filled
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
      this.log('Chat opened with prompt');

      // Wait for chat to fully open
      await this.wait(1000);

      // Step 2: Submit/execute the prompt
      await this.submitPrompt();

      // Step 3: Wait for agent execution
      await this.waitForExecution();

      // Step 4: Check results
      const filesAfter = await this.getWorkspaceFiles();
      const newFiles = filesAfter.filter(f => !filesBefore.includes(f));

      if (newFiles.length > 0) {
        this.log(`Created ${newFiles.length} file(s): ${newFiles.join(', ')}`);
      }

      return {
        success: true,
        output: `Execution complete. ${newFiles.length} new file(s) created.`,
        filesCreated: newFiles
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`Error: ${errorMsg}`);
      
      return {
        success: false,
        output: '',
        error: errorMsg
      };
    }
  }

  /**
   * Submit the prompt using the discovered working command
   */
  private async submitPrompt(): Promise<void> {
    try {
      await vscode.commands.executeCommand('composer.triggerCreateWorktreeButton');
      this.log('Prompt submitted');
    } catch (err) {
      // Fallback commands if primary fails
      const fallbacks = ['composer.resumeCurrentChat', 'composer.sendToAgent'];
      for (const cmd of fallbacks) {
        try {
          await vscode.commands.executeCommand(cmd);
          this.log(`Submitted via fallback: ${cmd}`);
          return;
        } catch {
          // Continue to next fallback
        }
      }
    }
  }

  /**
   * Wait for agent execution to complete
   */
  private async waitForExecution(): Promise<void> {
    const waitTime = 15000; // 15 seconds default
    const interval = 3000;
    let waited = 0;

    while (waited < waitTime) {
      await this.wait(interval);
      waited += interval;
    }
  }

  /**
   * Get workspace files for comparison
   */
  private async getWorkspaceFiles(): Promise<string[]> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return [];

      const pattern = new vscode.RelativePattern(workspaceFolder, '**/*');
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 2000);
      return files.map(f => vscode.workspace.asRelativePath(f)).sort();
    } catch {
      return [];
    }
  }

  /**
   * Helper: Wait for specified milliseconds
   */
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Log to output channel
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[CursorAgent] ${message}`);
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  /**
   * Show output channel
   */
  showOutput(): void {
    this.outputChannel.show();
  }
}

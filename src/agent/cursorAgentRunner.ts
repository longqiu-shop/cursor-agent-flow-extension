/**
 * Cursor Agent Runner - Executes prompts using Cursor's AI agent
 * 
 * Key Discovery:
 * - Open chat with prompt: workbench.action.chat.open { query: prompt }
 * - Submit/execute: composer.triggerCreateWorktreeButton
 */

import * as vscode from 'vscode';
import { Schedule, Command } from '../types';

export interface AgentExecutionResult {
  success: boolean;
  output: string;
  filesChanged?: number;
  error?: string;
}

export interface AgentSubmitOptions {
  title?: string;
  freshChat?: boolean;
  submitMode?: 'worktree' | 'currentWorkspace';
}

export interface AgentSubmitResult {
  success: boolean;
  output: string;
  error?: string;
}

export class CursorAgentRunner {
  async submitPrompt(prompt: string, options: AgentSubmitOptions = {}): Promise<AgentSubmitResult> {
    try {
      if (options.freshChat) {
        try {
          await vscode.commands.executeCommand('composer.createNewComposerTab');
          await this.wait(500);
        } catch (error) {
          console.warn('[CursorAgentRunner] Failed to create new composer tab:', error);
        }
      }

      console.log(`[CursorAgentRunner] Opening chat${options.title ? `: ${options.title}` : ''}`);
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
      await this.wait(1000);

      if (options.submitMode === 'currentWorkspace') {
        await vscode.commands.executeCommand('composer.sendToAgent');
      } else {
        await vscode.commands.executeCommand('composer.triggerCreateWorktreeButton');
      }

      return {
        success: true,
        output: 'Prompt submitted. Waiting for workflow artifact.'
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Execute a prompt using Cursor's agent system
   */
  async executePrompt(schedule: Schedule, prompt: string): Promise<AgentExecutionResult> {
    console.log(`[CursorAgentRunner] Executing prompt for schedule: ${schedule.name}`);
    
    if (schedule.executionMode === 'cloud') {
      return {
        success: false,
        output: '',
        error: 'Cloud execution is not yet supported. Please use local IDE mode.'
      };
    }

    return this.executeInIDE(prompt);
  }

  /**
   * Execute a command using Cursor's agent system
   */
  async executeCommand(schedule: Schedule, command: Command): Promise<AgentExecutionResult> {
    console.log(`[CursorAgentRunner] Executing command: ${command.id}`);
    const prompt = this.buildCommandPrompt(command);
    return this.executePrompt(schedule, prompt);
  }

  /**
   * Build prompt from command definition
   */
  private buildCommandPrompt(command: Command): string {
    let prompt = '';
    
    if (command.sections?.role) {
      prompt += `Role: ${command.sections.role}\n\n`;
    }
    
    if (command.sections?.context) {
      prompt += `Context: ${command.sections.context}\n\n`;
    }
    
    prompt += command.instructions;
    
    if (command.sections?.rules) {
      prompt += `\n\nRules:\n${command.sections.rules}`;
    }
    
    if (command.sections?.tasks) {
      prompt += `\n\nTasks:\n${command.sections.tasks}`;
    }
    
    return prompt;
  }

  /**
   * Execute prompt in local IDE using discovered Cursor commands
   */
  private async executeInIDE(prompt: string): Promise<AgentExecutionResult> {
    try {
      // Get initial files for comparison
      const filesBefore = await this.getWorkspaceFiles();
      console.log(`[CursorAgentRunner] Files before: ${filesBefore.length}`);
      
      // Step 1: Open chat with prompt pre-filled
      console.log(`[CursorAgentRunner] Opening chat with prompt...`);
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
      
      // Wait for chat to fully open
      await this.wait(1000);
      
      // Step 2: Submit the prompt
      console.log(`[CursorAgentRunner] Submitting prompt...`);
      try {
        await vscode.commands.executeCommand('composer.triggerCreateWorktreeButton');
        console.log(`[CursorAgentRunner] ✅ Prompt submitted`);
      } catch {
        // Fallback to alternative submit commands
        try {
          await vscode.commands.executeCommand('composer.resumeCurrentChat');
        } catch {
          await vscode.commands.executeCommand('composer.sendToAgent');
        }
      }
      
      // Step 3: Wait for agent execution
      console.log(`[CursorAgentRunner] Waiting for agent execution...`);
      await this.wait(15000);
      
      // Step 4: Check for new files
      const filesAfter = await this.getWorkspaceFiles();
      const newFiles = filesAfter.filter(f => !filesBefore.includes(f));
      
      console.log(`[CursorAgentRunner] Files after: ${filesAfter.length}`);
      if (newFiles.length > 0) {
        console.log(`[CursorAgentRunner] New files: ${newFiles.join(', ')}`);
      }
      
      return {
        success: true,
        output: newFiles.length > 0 
          ? `Created ${newFiles.length} file(s): ${newFiles.join(', ')}`
          : 'Prompt submitted. Check Cursor for agent response.',
        filesChanged: newFiles.length
      };
      
    } catch (error) {
      console.error('[CursorAgentRunner] Execution failed:', error);
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get list of files in workspace
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
   * Substitute variables in prompt template
   */
  substituteVariables(template: string, variables: Record<string, string> = {}): string {
    const defaults: Record<string, string> = {
      datetime: new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19),
      date: new Date().toISOString().split('T')[0],
      time: new Date().toTimeString().split(' ')[0],
      timestamp: Date.now().toString(),
      ...variables
    };

    let result = template;
    for (const [key, value] of Object.entries(defaults)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
  }
}

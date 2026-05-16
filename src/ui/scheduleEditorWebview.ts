/**
 * Webview panel for editing schedules
 */

import * as vscode from 'vscode';
import { Schedule, TargetType } from '../types';
import { CommandRegistry } from '../commands/commandRegistry';
import { SkillRegistry } from '../commands/skillRegistry';
import { AgentRegistry } from '../commands/agentRegistry';
import { WorkflowRegistry } from '../workflow/workflowRegistry';
import { SchedulerService } from '../scheduler/schedulerService';
import { StorageManager } from '../storage/storageManager';
import { validateCronExpression, getCronDescription, getNextRunTimeFormatted } from '../utils/cronUtils';
import * as uuid from 'uuid';

interface WebviewMessage {
  type: string;
  data?: unknown;
}

export class ScheduleEditorWebview {
  private panel: vscode.WebviewPanel | undefined;
  private commandRegistry: CommandRegistry;
  private skillRegistry: SkillRegistry;
  private agentRegistry: AgentRegistry;
  private workflowRegistry: WorkflowRegistry;
  private schedulerService: SchedulerService;
  private storageManager: StorageManager;
  private schedule: Schedule | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    commandRegistry: CommandRegistry,
    skillRegistry: SkillRegistry,
    agentRegistry: AgentRegistry,
    workflowRegistry: WorkflowRegistry,
    schedulerService: SchedulerService,
    storageManager: StorageManager
  ) {
    this.commandRegistry = commandRegistry;
    this.skillRegistry = skillRegistry;
    this.agentRegistry = agentRegistry;
    this.workflowRegistry = workflowRegistry;
    this.schedulerService = schedulerService;
    this.storageManager = storageManager;
  }

  /**
   * Open the editor for a new schedule
   */
  openNew(): void {
    const schedule: Schedule = {
      id: uuid.v4(),
      name: 'New Schedule',
      enabled: true,
      cron: '0 0 * * *',
      targetType: 'prompt',
      promptTemplate: '',
      executionMode: 'ide',
      outputConfig: {
        type: 'none'
      },
      metadata: {
        createdAt: new Date().toISOString()
      }
    };
    this.open(schedule);
  }

  /**
   * Open the editor for an existing schedule
   */
  open(schedule: Schedule): void {
    this.schedule = schedule;

    const panel = vscode.window.createWebviewPanel(
      'scheduleEditor',
      schedule.id ? `Edit: ${schedule.name}` : 'New Schedule',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel = panel;
    panel.webview.html = this.getWebviewContent(panel.webview);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        await this.handleMessage(message);
      },
      null,
      this.disposables
    );

    // Handle panel close
    panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      null,
      this.disposables
    );
  }

  /**
   * Handle messages from webview
   */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'getInitialData':
        this.sendInitialData();
        break;
      case 'getCommands':
      case 'getContextByType':
        this.sendContextByType();
        break;
      case 'validateCron':
        if (message.data && typeof message.data === 'object' && 'cron' in message.data) {
          this.validateCron(String(message.data.cron));
        }
        break;
      case 'save':
        if (message.data && typeof message.data === 'object') {
          await this.saveSchedule(message.data as Partial<Schedule>);
        }
        break;
      case 'testRun':
        if (message.data && typeof message.data === 'object') {
          await this.testRun(message.data as Partial<Schedule>);
        }
        break;
    }
  }

  /**
   * Send initial data to webview
   */
  private sendInitialData(): void {
    if (!this.panel || !this.schedule) {
      return;
    }

    this.panel.webview.postMessage({
      type: 'initialData',
      data: {
        schedule: this.schedule,
        contextByType: this.getAllContextData()
      }
    });
  }

  /**
   * Send context lists (commands, skills, agents) to webview
   */
  private sendContextByType(): void {
    if (!this.panel) return;
    this.panel.webview.postMessage({
      type: 'contextByType',
      data: this.getAllContextData()
    });
  }

  /**
   * Get context items (commands, skills, or agents) for webview by target type
   */
  private getContextData(targetType: TargetType): Array<{ filePath: string; commandId: string; description?: string }> {
    if (targetType === 'workflow') {
      return this.workflowRegistry.getAll().map(workflow => ({
        filePath: workflow.filePath,
        commandId: workflow.id,
        description: workflow.description
      }));
    }

    const items =
      targetType === 'command' ? this.commandRegistry.getAllCommands() :
      targetType === 'skill' ? this.skillRegistry.getAll() :
      targetType === 'agent' ? this.agentRegistry.getAll() : [];
    return items.map(cmd => ({
      filePath: cmd.filePath,
      commandId: cmd.id,
      description: cmd.description
    }));
  }

  /** All context data keyed by target type for the webview */
  private getAllContextData(): Record<TargetType, Array<{ filePath: string; commandId: string; description?: string }>> {
    return {
      prompt: [],
      command: this.getContextData('command'),
      skill: this.getContextData('skill'),
      agent: this.getContextData('agent'),
      workflow: this.getContextData('workflow')
    };
  }

  /**
   * Validate cron expression
   */
  private validateCron(cron: string): void {
    if (!this.panel) {
      return;
    }

    const validation = validateCronExpression(cron);
    const description = validation.valid ? getCronDescription(cron) : '';
    const nextRun = validation.valid ? getNextRunTimeFormatted(cron) : '';

    this.panel.webview.postMessage({
      type: 'cronValidation',
      data: {
        valid: validation.valid,
        error: validation.error,
        description,
        nextRun
      }
    });
  }

  /**
   * Save schedule
   */
  private async saveSchedule(data: Partial<Schedule>): Promise<void> {
    if (!this.schedule) {
      const errorMsg = 'No schedule data available';
      if (this.panel) {
        this.panel.webview.postMessage({
          type: 'saveError',
          data: { error: errorMsg }
        });
      }
      vscode.window.showErrorMessage(`Failed to save schedule: ${errorMsg}`);
      return;
    }

    try {
      // Validate required fields
      if (!data.name || !data.cron || !data.targetType || !data.executionMode || !data.outputConfig) {
        throw new Error('Missing required fields: name, cron, targetType, executionMode, and outputConfig are required');
      }

      // Validate target-specific fields
      if (data.targetType === 'prompt' && !data.promptTemplate) {
        throw new Error('Prompt template is required when target type is "prompt"');
      }

      if (['command', 'skill', 'agent'].includes(data.targetType || '') && !data.commandRef) {
        throw new Error('Context reference is required when target type is command, skill, or agent');
      }

      if (data.targetType === 'workflow') {
        if (!data.workflowRef) {
          throw new Error('Workflow reference is required when target type is "workflow"');
        }
        if (data.executionMode === 'cloud') {
          throw new Error('Workflow schedules are only supported in Local IDE mode');
        }
      }

      // Ensure id exists (for new schedules, use the one from this.schedule)
      const scheduleId = this.schedule.id || (data as Schedule).id;
      if (!scheduleId) {
        throw new Error('Schedule ID is missing');
      }

      const updated: Schedule = {
        id: scheduleId,
        name: data.name,
        enabled: data.enabled !== undefined ? data.enabled : this.schedule.enabled,
        cron: data.cron,
        timezone: data.timezone,
        targetType: data.targetType,
        promptTemplate: data.promptTemplate,
        commandRef: data.commandRef,
        workflowRef: data.workflowRef,
        executionMode: data.executionMode,
        workspaceFolder: data.workspaceFolder || this.schedule.workspaceFolder,
        outputConfig: data.outputConfig,
        constraints: data.constraints,
        metadata: {
          ...this.schedule.metadata,
          updatedAt: new Date().toISOString(),
          createdAt: this.schedule.metadata?.createdAt || new Date().toISOString()
        }
      };

      // Check if this is an update or new schedule
      const schedules = await this.storageManager.loadSchedules();
      const isUpdate = schedules.some(s => s.id === scheduleId);

      if (isUpdate) {
        await this.schedulerService.updateSchedule(updated);
      } else {
        await this.schedulerService.addSchedule(updated);
      }

      if (this.panel) {
        this.panel.webview.postMessage({
          type: 'saveSuccess'
        });
      }

      vscode.window.showInformationMessage(`Schedule "${updated.name}" saved successfully`);
      this.panel?.dispose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to save schedule:', error);
      if (this.panel) {
        this.panel.webview.postMessage({
          type: 'saveError',
          data: { error: message }
        });
      }
      vscode.window.showErrorMessage(`Failed to save schedule: ${message}`);
    }
  }

  /**
   * Test run schedule
   */
  private async testRun(data: Partial<Schedule>): Promise<void> {
    if (!this.schedule) {
      return;
    }

    try {
      const testSchedule: Schedule = {
        ...this.schedule,
        ...data,
        id: `test_${Date.now()}`,
        name: `[TEST] ${this.schedule.name}`
      };

      await this.schedulerService.runScheduleDirect(testSchedule);
      
      if (this.panel) {
        this.panel.webview.postMessage({
          type: 'testRunStarted'
        });
      }

      vscode.window.showInformationMessage('Test run started');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (this.panel) {
        this.panel.webview.postMessage({
          type: 'testRunError',
          data: { error: message }
        });
      }
      vscode.window.showErrorMessage(`Failed to start test run: ${message}`);
    }
  }

  /**
   * Get webview HTML content
   */
  private getWebviewContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Schedule Editor</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
        }
        input[type="text"], textarea, select {
            width: 100%;
            padding: 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
        }
        textarea {
            min-height: 100px;
            font-family: var(--vscode-editor-font-family);
        }
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        button {
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .preset-btn {
            padding: 4px 8px;
            font-size: 11px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            cursor: pointer;
        }
        .preset-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .error {
            color: var(--vscode-errorForeground);
            font-size: 12px;
            margin-top: 5px;
        }
        .info {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            margin-top: 5px;
        }
        .conditional {
            margin-left: 20px;
            padding-left: 20px;
            border-left: 2px solid var(--vscode-input-border);
        }
    </style>
</head>
<body>
    <h1>Schedule Editor</h1>
    
    <form id="scheduleForm">
        <div class="form-group">
            <label for="name">Name *</label>
            <input type="text" id="name" required>
        </div>

        <div class="form-group">
            <div class="checkbox-group">
                <input type="checkbox" id="enabled">
                <label for="enabled">Enabled</label>
            </div>
        </div>

        <div class="form-group">
            <label for="cron">Schedule *</label>
            <div style="margin-bottom: 10px;">
                <label style="font-weight: normal; font-size: 12px;">Quick Presets:</label>
                <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 5px;">
                    <button type="button" class="preset-btn" data-cron="*/15 * * * *">Every 15 Minutes</button>
                    <button type="button" class="preset-btn" data-cron="*/30 * * * *">Every 30 Minutes</button>
                    <button type="button" class="preset-btn" data-cron="0 * * * *">Every Hour</button>
                    <button type="button" class="preset-btn" data-cron="0 */4 * * *">Every 4 Hours</button>
                    <button type="button" class="preset-btn" data-cron="0 */6 * * *">Every 6 Hours</button>
                    <button type="button" class="preset-btn" data-cron="0 */12 * * *">Every 12 Hours</button>
                    <button type="button" class="preset-btn" data-cron="0 0 * * *">Daily (Midnight)</button>
                    <button type="button" class="preset-btn" data-cron="0 9 * * *">Daily (9 AM)</button>
                    <button type="button" class="preset-btn" data-cron="0 0 * * 1">Weekly (Monday)</button>
                    <button type="button" class="preset-btn" data-cron="0 9 * * 1-5">Weekdays (9 AM)</button>
                    <button type="button" class="preset-btn" data-cron="0 0 1 * *">Monthly (1st)</button>
                </div>
            </div>
            <div style="display: flex; gap: 10px; align-items: flex-start;">
                <div style="flex: 1;">
                    <label for="cron" style="display: block; margin-bottom: 5px; font-size: 12px;">Cron Expression:</label>
                    <input type="text" id="cron" placeholder="0 0 * * *" required style="width: 100%;">
                    <div id="cronError" class="error"></div>
                    <div id="cronInfo" class="info"></div>
                </div>
                <div style="flex: 1;">
                    <label style="display: block; margin-bottom: 5px; font-size: 12px;">Or use visual builder:</label>
                    <div id="cronBuilder" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <div>
                            <label for="cronMinute" style="font-size: 11px;">Minute:</label>
                            <input type="text" id="cronMinute" placeholder="0" value="0" style="width: 100%;">
                        </div>
                        <div>
                            <label for="cronHour" style="font-size: 11px;">Hour:</label>
                            <input type="text" id="cronHour" placeholder="0" value="0" style="width: 100%;">
                        </div>
                        <div>
                            <label for="cronDay" style="font-size: 11px;">Day of Month:</label>
                            <input type="text" id="cronDay" placeholder="*" value="*" style="width: 100%;">
                        </div>
                        <div>
                            <label for="cronMonth" style="font-size: 11px;">Month:</label>
                            <input type="text" id="cronMonth" placeholder="*" value="*" style="width: 100%;">
                        </div>
                        <div style="grid-column: 1 / -1;">
                            <label for="cronWeekday" style="font-size: 11px;">Day of Week:</label>
                            <select id="cronWeekday" style="width: 100%;">
                                <option value="*">Every day</option>
                                <option value="0">Sunday</option>
                                <option value="1">Monday</option>
                                <option value="2">Tuesday</option>
                                <option value="3">Wednesday</option>
                                <option value="4">Thursday</option>
                                <option value="5">Friday</option>
                                <option value="6">Saturday</option>
                                <option value="1-5">Weekdays (Mon-Fri)</option>
                                <option value="0,6">Weekends (Sat-Sun)</option>
                            </select>
                        </div>
                        <div style="grid-column: 1 / -1;">
                            <button type="button" id="buildCronBtn" class="secondary" style="width: 100%;">Build Cron Expression</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div class="form-group">
            <label for="timezone">Timezone (optional)</label>
            <input type="text" id="timezone" placeholder="America/New_York">
        </div>

        <div class="form-group">
            <label for="targetType">Target Type *</label>
            <select id="targetType" required>
                <option value="prompt">Inline Prompt</option>
                <option value="command">Cursor Command</option>
                <option value="skill">Skill</option>
                <option value="agent">Agent</option>
                <option value="workflow">Workflow</option>
            </select>
        </div>

        <div id="promptSection" class="conditional">
            <div class="form-group">
                <label for="promptTemplate">Prompt Template *</label>
                <textarea id="promptTemplate" placeholder="Enter your prompt template here..."></textarea>
            </div>
        </div>

        <div id="contextSection" class="conditional" style="display: none;">
            <div class="form-group">
                <label for="commandFile">File</label>
                <select id="commandFile">
                    <option value="">Select a file...</option>
                </select>
            </div>
            <div class="form-group">
                <label for="commandId">ID</label>
                <select id="commandId">
                    <option value="">Select...</option>
                </select>
            </div>
            <div id="commandPreview" class="info"></div>
        </div>

        <div class="form-group">
            <label for="executionMode">Execution Mode *</label>
            <select id="executionMode" required>
                <option value="ide">Local IDE</option>
                <option value="cloud">Cloud Agent</option>
            </select>
        </div>

        <div class="form-group">
            <label for="outputType">Output Type *</label>
            <select id="outputType" required>
                <option value="none">No Output</option>
                <option value="markdown">Markdown Report</option>
                <option value="diff">Diff View</option>
                <option value="pr">Pull Request</option>
            </select>
        </div>

        <div id="outputLocationSection" class="conditional" style="display: none;">
            <div class="form-group">
                <label for="outputLocation">Output Location</label>
                <input type="text" id="outputLocation" placeholder="path/to/output.md">
            </div>
        </div>

        <div class="form-group">
            <label>Safety Constraints (optional)</label>
            <div class="form-group" style="margin-left: 20px;">
                <label for="maxRuntime">Max Runtime (seconds)</label>
                <input type="number" id="maxRuntime" min="0">
            </div>
            <div class="form-group" style="margin-left: 20px;">
                <label for="maxFilesChanged">Max Files Changed</label>
                <input type="number" id="maxFilesChanged" min="0">
            </div>
        </div>

        <div class="button-group">
            <button type="button" id="testRunBtn" class="secondary">Test Run</button>
            <button type="submit">Save</button>
            <button type="button" id="cancelBtn" class="secondary">Cancel</button>
        </div>
    </form>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let contextByType = { prompt: [], command: [], skill: [], agent: [], workflow: [] };
        let schedule = null;

        // Load initial data
        vscode.postMessage({ type: 'getInitialData' });
        vscode.postMessage({ type: 'getContextByType' });

        // Listen for messages
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'initialData':
                    schedule = message.data.schedule;
                    contextByType = message.data.contextByType || contextByType;
                    loadSchedule();
                    loadContext();
                    break;
                case 'contextByType':
                    contextByType = message.data || contextByType;
                    loadContext();
                    break;
                case 'cronValidation':
                    updateCronValidation(message.data);
                    break;
                case 'saveSuccess':
                    vscode.postMessage({ type: 'close' });
                    break;
                case 'saveError':
                    alert('Error: ' + message.data.error);
                    break;
                case 'testRunStarted':
                    alert('Test run started!');
                    break;
                case 'testRunError':
                    alert('Test run error: ' + message.data.error);
                    break;
            }
        });

        function loadSchedule() {
            if (!schedule) return;
            document.getElementById('name').value = schedule.name || '';
            document.getElementById('enabled').checked = schedule.enabled !== false;
            document.getElementById('cron').value = schedule.cron || '0 0 * * *';
            document.getElementById('timezone').value = schedule.timezone || '';
            document.getElementById('targetType').value = schedule.targetType || 'prompt';
            document.getElementById('executionMode').value = schedule.executionMode || 'ide';
            document.getElementById('outputType').value = schedule.outputConfig?.type || 'none';
            document.getElementById('outputLocation').value = schedule.outputConfig?.location || '';
            document.getElementById('promptTemplate').value = schedule.promptTemplate || '';
            document.getElementById('maxRuntime').value = schedule.constraints?.maxRuntime || '';
            document.getElementById('maxFilesChanged').value = schedule.constraints?.maxFilesChanged || '';
            
            updateTargetType();
            updateOutputType();
            loadContext();
            
            const contextRef = schedule.targetType === 'workflow' ? schedule.workflowRef : schedule.commandRef;
            if (contextRef) {
                document.getElementById('commandFile').value = contextRef.filePath;
                updateCommandIds();
                document.getElementById('commandId').value = contextRef.commandId || contextRef.workflowId;
            }
            
            // Initialize cron builder after loading schedule
            setTimeout(initializeCronBuilder, 100);
        }

        function getCommandsForType() {
            const targetType = document.getElementById('targetType').value;
            return contextByType[targetType] || [];
        }

        function loadContext() {
            const commandFileSelect = document.getElementById('commandFile');
            const commands = getCommandsForType();
            const files = [...new Set(commands.map(c => c.filePath))];
            commandFileSelect.innerHTML = '<option value="">Select a file...</option>';
            files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                commandFileSelect.appendChild(option);
            });
            
            const contextRef = schedule?.targetType === 'workflow' ? schedule?.workflowRef : schedule?.commandRef;
            if (contextRef && document.getElementById('targetType').value === schedule.targetType) {
                commandFileSelect.value = contextRef.filePath;
                updateCommandIds();
                document.getElementById('commandId').value = contextRef.commandId || contextRef.workflowId || '';
            }
        }

        function updateCommandIds() {
            const filePath = document.getElementById('commandFile').value;
            const commandIdSelect = document.getElementById('commandId');
            const commands = getCommandsForType();
            commandIdSelect.innerHTML = '<option value="">Select...</option>';
            
            if (filePath) {
                const fileCommands = commands.filter(c => c.filePath === filePath);
                fileCommands.forEach(cmd => {
                    const option = document.createElement('option');
                    option.value = cmd.commandId;
                    option.textContent = cmd.commandId + (cmd.description ? ' - ' + cmd.description : '');
                    commandIdSelect.appendChild(option);
                });
            }
        }

        function updateTargetType() {
            const targetType = document.getElementById('targetType').value;
            document.getElementById('promptSection').style.display = targetType === 'prompt' ? 'block' : 'none';
            const showContext = ['command', 'skill', 'agent', 'workflow'].includes(targetType);
            document.getElementById('contextSection').style.display = showContext ? 'block' : 'none';
            if (showContext) loadContext();
        }

        function updateOutputType() {
            const outputType = document.getElementById('outputType').value;
            document.getElementById('outputLocationSection').style.display = 
                (outputType === 'markdown' || outputType === 'pr') ? 'block' : 'none';
        }

        function updateCronValidation(data) {
            const errorDiv = document.getElementById('cronError');
            const infoDiv = document.getElementById('cronInfo');
            
            if (data.valid) {
                errorDiv.textContent = '';
                infoDiv.textContent = data.description + (data.nextRun ? ' (Next: ' + data.nextRun + ')' : '');
            } else {
                errorDiv.textContent = data.error || 'Invalid cron expression';
                infoDiv.textContent = '';
            }
        }

        // Event listeners
        document.getElementById('targetType').addEventListener('change', updateTargetType);
        document.getElementById('outputType').addEventListener('change', updateOutputType);
        document.getElementById('commandFile').addEventListener('change', updateCommandIds);
        
        // Preset buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const cron = btn.getAttribute('data-cron');
                if (cron) {
                    document.getElementById('cron').value = cron;
                    parseCronToBuilder(cron);
                    vscode.postMessage({ type: 'validateCron', data: { cron } });
                }
            });
        });

        // Cron builder
        document.getElementById('buildCronBtn').addEventListener('click', () => {
            const minute = document.getElementById('cronMinute').value || '0';
            const hour = document.getElementById('cronHour').value || '0';
            const day = document.getElementById('cronDay').value || '*';
            const month = document.getElementById('cronMonth').value || '*';
            const weekday = document.getElementById('cronWeekday').value || '*';
            const cron = minute + ' ' + hour + ' ' + day + ' ' + month + ' ' + weekday;
            document.getElementById('cron').value = cron;
            vscode.postMessage({ type: 'validateCron', data: { cron } });
        });

        // Parse cron expression to builder fields
        function parseCronToBuilder(cron) {
            const parts = cron.trim().split(/[ \\t]+/);
            if (parts.length >= 5) {
                document.getElementById('cronMinute').value = parts[0] || '0';
                document.getElementById('cronHour').value = parts[1] || '0';
                document.getElementById('cronDay').value = parts[2] || '*';
                document.getElementById('cronMonth').value = parts[3] || '*';
                document.getElementById('cronWeekday').value = parts[4] || '*';
            }
        }

        // Initialize builder from cron if exists (called after schedule loads)
        function initializeCronBuilder() {
            const cronInput = document.getElementById('cron');
            if (cronInput && cronInput.value) {
                parseCronToBuilder(cronInput.value);
            }
        }
        
        document.getElementById('cron').addEventListener('input', e => {
            const cron = e.target.value;
            parseCronToBuilder(cron);
            vscode.postMessage({ type: 'validateCron', data: { cron } });
        });

        document.getElementById('scheduleForm').addEventListener('submit', e => {
            e.preventDefault();
            const data = {
                name: document.getElementById('name').value,
                enabled: document.getElementById('enabled').checked,
                cron: document.getElementById('cron').value,
                timezone: document.getElementById('timezone').value || undefined,
                targetType: document.getElementById('targetType').value,
                executionMode: document.getElementById('executionMode').value,
                outputConfig: {
                    type: document.getElementById('outputType').value,
                    location: document.getElementById('outputLocation').value || undefined
                },
                constraints: {}
            };

            if (data.targetType === 'prompt') {
                data.promptTemplate = document.getElementById('promptTemplate').value;
            } else {
                const filePath = document.getElementById('commandFile').value;
                const commandId = document.getElementById('commandId').value;
                if (filePath && commandId) {
                    if (data.targetType === 'workflow') {
                        data.workflowRef = { filePath, workflowId: commandId };
                    } else {
                        data.commandRef = { filePath, commandId };
                    }
                }
            }

            const maxRuntime = document.getElementById('maxRuntime').value;
            const maxFilesChanged = document.getElementById('maxFilesChanged').value;
            if (maxRuntime) data.constraints.maxRuntime = parseInt(maxRuntime);
            if (maxFilesChanged) data.constraints.maxFilesChanged = parseInt(maxFilesChanged);
            if (Object.keys(data.constraints).length === 0) data.constraints = undefined;

            vscode.postMessage({ type: 'save', data });
        });

        document.getElementById('testRunBtn').addEventListener('click', () => {
            const data = {
                name: document.getElementById('name').value,
                enabled: true,
                cron: document.getElementById('cron').value,
                timezone: document.getElementById('timezone').value || undefined,
                targetType: document.getElementById('targetType').value,
                executionMode: document.getElementById('executionMode').value,
                outputConfig: {
                    type: document.getElementById('outputType').value,
                    location: document.getElementById('outputLocation').value || undefined
                }
            };

            if (data.targetType === 'prompt') {
                data.promptTemplate = document.getElementById('promptTemplate').value;
            } else {
                const filePath = document.getElementById('commandFile').value;
                const commandId = document.getElementById('commandId').value;
                if (filePath && commandId) {
                    if (data.targetType === 'workflow') {
                        data.workflowRef = { filePath, workflowId: commandId };
                    } else {
                        data.commandRef = { filePath, commandId };
                    }
                }
            }

            vscode.postMessage({ type: 'testRun', data });
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'close' });
        });
    </script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

/**
 * Run history view for displaying execution history
 */

import * as vscode from 'vscode';
import { RunRecord } from '../types';
import { StorageManager } from '../storage/storageManager';

export class RunHistoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly runRecord: RunRecord,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(getRunTitle(runRecord), collapsibleState);

    this.tooltip = getRunTooltip(runRecord);
    this.description = getRunDescription(runRecord);
    this.iconPath = getRunIcon(runRecord);
    this.contextValue = 'runRecord';
  }
}

function getRunTitle(runRecord: RunRecord): string {
  const date = new Date(runRecord.startedAt);
  return `${runRecord.scheduleName} - ${date.toLocaleString()}`;
}

function getRunDescription(runRecord: RunRecord): string {
  const parts: string[] = [];
  
  if (runRecord.status === 'success') {
    parts.push('✓ Success');
  } else if (runRecord.status === 'failure') {
    parts.push('✗ Failed');
  } else if (runRecord.status === 'running') {
    parts.push('⟳ Running');
  } else {
    parts.push('⊘ Skipped');
  }

  if (runRecord.executionTime) {
    parts.push(`${runRecord.executionTime.toFixed(1)}s`);
  }

  if (runRecord.filesChanged !== undefined) {
    parts.push(`${runRecord.filesChanged} files`);
  }

  return parts.join(' • ');
}

function getRunTooltip(runRecord: RunRecord): string {
  const lines: string[] = [
    `Schedule: ${runRecord.scheduleName}`,
    `Status: ${runRecord.status}`,
    `Started: ${new Date(runRecord.startedAt).toLocaleString()}`
  ];

  if (runRecord.finishedAt) {
    lines.push(`Finished: ${new Date(runRecord.finishedAt).toLocaleString()}`);
  }

  if (runRecord.executionTime) {
    lines.push(`Duration: ${runRecord.executionTime.toFixed(2)}s`);
  }

  if (runRecord.filesChanged !== undefined) {
    lines.push(`Files Changed: ${runRecord.filesChanged}`);
  }

  if (runRecord.targetType === 'command' && runRecord.commandId) {
    lines.push(`Command: ${runRecord.commandId}`);
  }

  if (runRecord.summary) {
    lines.push(`Summary: ${runRecord.summary}`);
  }

  if (runRecord.error) {
    lines.push(`Error: ${runRecord.error}`);
  }

  if (runRecord.outputLocation) {
    lines.push(`Output: ${runRecord.outputLocation}`);
  }

  return lines.join('\n');
}

function getRunIcon(runRecord: RunRecord): vscode.ThemeIcon {
  switch (runRecord.status) {
    case 'success':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    case 'failure':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'running':
      return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue'));
    default:
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.grey'));
  }
}

export class RunHistoryView implements vscode.TreeDataProvider<RunHistoryTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<RunHistoryTreeItem | undefined | null | void> = new vscode.EventEmitter<RunHistoryTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<RunHistoryTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private filterScheduleId: string | undefined;

  constructor(private storageManager: StorageManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setFilter(scheduleId?: string): void {
    this.filterScheduleId = scheduleId;
    this.refresh();
  }

  getTreeItem(element: RunHistoryTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RunHistoryTreeItem): RunHistoryTreeItem[] {
    if (element) {
      return []; // No children for now
    }

    let records: RunRecord[];
    if (this.filterScheduleId) {
      records = this.storageManager.getRunHistoryForSchedule(this.filterScheduleId);
    } else {
      records = this.storageManager.getRunHistory();
    }

    // Sort by startedAt descending (most recent first)
    records.sort((a, b) => 
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );

    return records.map(record => 
      new RunHistoryTreeItem(record, vscode.TreeItemCollapsibleState.None)
    );
  }

  /**
   * Show run details in a webview
   */
  showRunDetails(runRecord: RunRecord): void {
    const panel = vscode.window.createWebviewPanel(
      'runDetails',
      `Run: ${runRecord.scheduleName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true
      }
    );

    panel.webview.html = this.getRunDetailsHtml(panel.webview, runRecord);
  }

  private getRunDetailsHtml(webview: vscode.Webview, runRecord: RunRecord): string {
    const nonce = this.getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Run Details</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        .detail-row {
            margin-bottom: 15px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-input-border);
        }
        .detail-label {
            font-weight: bold;
            margin-bottom: 5px;
            color: var(--vscode-descriptionForeground);
        }
        .detail-value {
            margin-top: 5px;
        }
        .status-success { color: var(--vscode-charts-green); }
        .status-failure { color: var(--vscode-charts-red); }
        .status-running { color: var(--vscode-charts-blue); }
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
        }
    </style>
</head>
<body>
    <h1>Run Details</h1>
    
    <div class="detail-row">
        <div class="detail-label">Schedule Name</div>
        <div class="detail-value">${escapeHtml(runRecord.scheduleName)}</div>
    </div>

    <div class="detail-row">
        <div class="detail-label">Status</div>
        <div class="detail-value status-${runRecord.status}">${escapeHtml(runRecord.status.toUpperCase())}</div>
    </div>

    <div class="detail-row">
        <div class="detail-label">Started At</div>
        <div class="detail-value">${new Date(runRecord.startedAt).toLocaleString()}</div>
    </div>

    ${runRecord.finishedAt ? `
    <div class="detail-row">
        <div class="detail-label">Finished At</div>
        <div class="detail-value">${new Date(runRecord.finishedAt).toLocaleString()}</div>
    </div>
    ` : ''}

    ${runRecord.executionTime ? `
    <div class="detail-row">
        <div class="detail-label">Execution Time</div>
        <div class="detail-value">${runRecord.executionTime.toFixed(2)} seconds</div>
    </div>
    ` : ''}

    <div class="detail-row">
        <div class="detail-label">Target Type</div>
        <div class="detail-value">${escapeHtml(runRecord.targetType)}</div>
    </div>

    ${runRecord.commandId ? `
    <div class="detail-row">
        <div class="detail-label">Command ID</div>
        <div class="detail-value">${escapeHtml(runRecord.commandId)}</div>
    </div>
    ` : ''}

    ${runRecord.filesChanged !== undefined ? `
    <div class="detail-row">
        <div class="detail-label">Files Changed</div>
        <div class="detail-value">${runRecord.filesChanged}</div>
    </div>
    ` : ''}

    ${runRecord.summary ? `
    <div class="detail-row">
        <div class="detail-label">Summary</div>
        <div class="detail-value"><pre>${escapeHtml(runRecord.summary)}</pre></div>
    </div>
    ` : ''}

    ${runRecord.error ? `
    <div class="detail-row">
        <div class="detail-label">Error</div>
        <div class="detail-value status-failure"><pre>${escapeHtml(runRecord.error)}</pre></div>
    </div>
    ` : ''}

    ${runRecord.outputLocation ? `
    <div class="detail-row">
        <div class="detail-label">Output Location</div>
        <div class="detail-value">${escapeHtml(runRecord.outputLocation)}</div>
    </div>
    ` : ''}
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
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (m) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return map[m];
  });
}

import * as vscode from 'vscode';
import { WorkflowRun, WorkflowStepRun } from '../types';
import { loadWorkflowRunTimeline, WorkflowRunTimelineEvent } from './workflowRunTimeline';

export class WorkflowRunDetailsView {
  show(run: WorkflowRun): void {
    const panel = vscode.window.createWebviewPanel(
      'workflowRunDetails',
      `Workflow: ${run.workflowName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: false
      }
    );

    panel.webview.html = this.getHtml(panel.webview, run);
  }

  private getHtml(webview: vscode.Webview, run: WorkflowRun): string {
    const timeline = loadWorkflowRunTimeline(run.runDir);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
  <title>Workflow Run</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }
    .detail-row {
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-input-border);
    }
    .detail-label {
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .status-succeeded { color: var(--vscode-charts-green); }
    .status-failed, .status-timedOut { color: var(--vscode-charts-red); }
    .status-running, .status-pending { color: var(--vscode-charts-blue); }
    .status-blocked, .status-interrupted { color: var(--vscode-charts-yellow); }
    .status-cancelled { color: var(--vscode-descriptionForeground); }
    table {
      border-collapse: collapse;
      width: 100%;
      margin-top: 12px;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-input-border);
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(run.workflowName)}</h1>
  <div class="detail-row">
    <div class="detail-label">Status</div>
    <div class="status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</div>
  </div>
  <div class="detail-row">
    <div class="detail-label">Run ID</div>
    <code>${escapeHtml(run.id)}</code>
  </div>
  <div class="detail-row">
    <div class="detail-label">Workflow ID</div>
    <code>${escapeHtml(run.workflowId)}</code>
  </div>
  <div class="detail-row">
    <div class="detail-label">Started</div>
    <div>${new Date(run.startedAt).toLocaleString()}</div>
  </div>
  ${run.finishedAt ? `
  <div class="detail-row">
    <div class="detail-label">Finished</div>
    <div>${new Date(run.finishedAt).toLocaleString()}</div>
  </div>
  ` : ''}
  ${run.currentStepId ? `
  <div class="detail-row">
    <div class="detail-label">Current Step</div>
    <code>${escapeHtml(run.currentStepId)}</code>
  </div>
  ` : ''}
  ${run.error ? `
  <div class="detail-row">
    <div class="detail-label">Error</div>
    <div class="status-failed">${escapeHtml(run.error)}</div>
  </div>
  ` : ''}
  <div class="detail-row">
    <div class="detail-label">Run Directory</div>
    <code>${escapeHtml(run.runDir)}</code>
  </div>
  <h2>Steps</h2>
  <table>
    <thead>
      <tr>
        <th>Step</th>
        <th>Type</th>
        <th>Status</th>
        <th>Artifact</th>
        <th>Notes</th>
      </tr>
    </thead>
    <tbody>
      ${run.steps.map(step => this.renderStepRow(step, 0)).join('')}
    </tbody>
  </table>
  ${this.renderTimeline(timeline)}
</body>
</html>`;
  }

  private renderStepRow(step: WorkflowStepRun, depth: number): string {
    const notes = step.blockedReason ?? step.error ?? '';
    const label = `${'  '.repeat(depth)}${step.title ?? step.definitionId}`;
    const row = `<tr>
      <td><code>${escapeHtml(label)}</code></td>
      <td>${escapeHtml(step.type)}</td>
      <td class="status-${escapeHtml(step.status)}">${escapeHtml(step.status)}</td>
      <td>${escapeHtml(step.outputArtifact ?? step.expectedArtifact ?? '')}</td>
      <td>${escapeHtml(notes)}</td>
    </tr>`;
    return row + (step.childRuns ?? []).map(child => this.renderStepRow(child, depth + 1)).join('');
  }

  private renderTimeline(timeline: WorkflowRunTimelineEvent[]): string {
    if (timeline.length === 0) {
      return '';
    }

    return `<h2>Plan Timeline</h2>
  <table>
    <thead>
      <tr>
        <th>Time</th>
        <th>Event</th>
        <th>Summary</th>
      </tr>
    </thead>
    <tbody>
      ${timeline.map(event => `<tr>
        <td>${new Date(event.timestamp).toLocaleString()}</td>
        <td><code>${escapeHtml(event.type)}</code></td>
        <td>${escapeHtml(event.summary)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
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

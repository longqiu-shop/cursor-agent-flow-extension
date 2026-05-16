import * as vscode from 'vscode';

export class WorkflowCancellationController implements vscode.Disposable {
  private source = new vscode.CancellationTokenSource();
  private disposed = false;

  get token(): vscode.CancellationToken {
    return this.source.token;
  }

  cancel(): void {
    if (!this.disposed) {
      this.source.cancel();
    }
  }

  dispose(): void {
    if (!this.disposed) {
      this.source.dispose();
      this.disposed = true;
    }
  }
}

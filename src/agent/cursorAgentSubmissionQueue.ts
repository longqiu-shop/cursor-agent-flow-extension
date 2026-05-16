import * as vscode from 'vscode';

interface QueueEntry<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  token?: vscode.CancellationToken;
  started: boolean;
}

export class CursorAgentSubmissionQueue {
  private queue: QueueEntry<unknown>[] = [];
  private running = false;

  enqueue<T>(run: () => Promise<T>, token?: vscode.CancellationToken): Promise<T> {
    if (token?.isCancellationRequested) {
      return Promise.reject(new Error('Submission cancelled before it was queued'));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        run,
        resolve,
        reject,
        token,
        started: false
      };

      const disposable = token?.onCancellationRequested(() => {
        if (!entry.started) {
          this.queue = this.queue.filter(item => item !== entry);
          reject(new Error('Submission cancelled before it started'));
        }
        disposable?.dispose();
      });

      this.queue.push(entry as QueueEntry<unknown>);
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry) {
          continue;
        }
        if (entry.token?.isCancellationRequested) {
          entry.reject(new Error('Submission cancelled before it started'));
          continue;
        }

        entry.started = true;
        try {
          entry.resolve(await entry.run());
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

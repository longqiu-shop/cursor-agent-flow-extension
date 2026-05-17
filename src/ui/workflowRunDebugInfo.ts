import * as fs from 'fs';
import * as path from 'path';

export interface WorkflowRunDebugFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

export function loadWorkflowRunDebugFiles(runDir: string): WorkflowRunDebugFile[] {
  if (!path.isAbsolute(runDir) || !fs.existsSync(runDir)) {
    return [];
  }

  return listDebugFiles(runDir, runDir).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function listDebugFiles(rootDir: string, currentDir: string): WorkflowRunDebugFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap(entry => {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      return listDebugFiles(rootDir, absolutePath);
    }
    if (!entry.isFile()) {
      return [];
    }

    try {
      const stat = fs.statSync(absolutePath);
      return [{
        relativePath: path.relative(rootDir, absolutePath),
        absolutePath,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      }];
    } catch {
      return [];
    }
  });
}

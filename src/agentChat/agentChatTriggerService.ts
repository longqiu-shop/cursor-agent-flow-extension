import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const AGENT_CHAT_REQUESTS_DIR = '.cursor/agent-flow-requests';
export const GLOBAL_AGENT_CHAT_REQUESTS_DIR = path.join(os.homedir(), '.cursor', 'agent-flow-requests');
export const START_AGENTIC_WORKFLOW_REQUEST_TYPE = 'startAgenticWorkflow';

export type AgentChatTriggerStatus = 'started' | 'failed' | 'ignored';

export interface AgentChatTriggerResult {
  requestId: string;
  status: AgentChatTriggerStatus;
  runId?: string;
  error?: string;
}

type StartAgenticWorkflow = (goal: string) => Promise<string>;

const REQUEST_ID_PATTERN = /^start-agentic-workflow-\d{14}$/;
const REQUEST_KEYS = ['goal', 'requestId', 'type'];

export function listAgentChatRequestFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory)
      .filter(fileName => fileName.endsWith('.json') && !fileName.endsWith('.result.json'))
      .map(fileName => path.join(directory, fileName));
  } catch {
    return [];
  }
}

export class AgentChatTriggerService {
  private readonly processedRequestIds = new Set<string>();

  constructor(private readonly startAgenticWorkflow: StartAgenticWorkflow) {}

  async processRequestFile(filePath: string): Promise<AgentChatTriggerResult> {
    const fileName = path.basename(filePath);
    if (!fileName.endsWith('.json') || fileName.endsWith('.result.json')) {
      return {
        requestId: this.requestIdFromFileName(fileName),
        status: 'ignored',
        error: 'Not an agent chat trigger request file'
      };
    }

    const requestIdFromFile = this.requestIdFromFileName(fileName);
    const validation = this.readAndValidateRequest(filePath, requestIdFromFile);
    if (!validation.ok) {
      return this.writeResult(filePath, {
        requestId: requestIdFromFile,
        status: 'failed',
        error: validation.error
      });
    }

    const { requestId, goal } = validation.request;
    if (this.processedRequestIds.has(requestId)) {
      return {
        requestId,
        status: 'ignored',
        error: `Request already processed: ${requestId}`
      };
    }
    if (fs.existsSync(this.resultPathForRequest(filePath, requestId))) {
      this.processedRequestIds.add(requestId);
      return {
        requestId,
        status: 'ignored',
        error: `Result already exists for request: ${requestId}`
      };
    }
    this.processedRequestIds.add(requestId);

    try {
      const runId = await this.startAgenticWorkflow(goal);
      if (!runId || runId.trim().length === 0) {
        throw new Error('Workflow start returned an empty run id');
      }
      return this.writeResult(filePath, {
        requestId,
        status: 'started',
        runId
      });
    } catch (error) {
      return this.writeResult(filePath, {
        requestId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private readAndValidateRequest(filePath: string, expectedRequestId: string): (
    | { ok: true; request: { requestId: string; goal: string } }
    | { ok: false; error: string }
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      return {
        ok: false,
        error: `Invalid request JSON: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    if (!this.isRecord(parsed)) {
      return { ok: false, error: 'Request must be a JSON object' };
    }

    const keys = Object.keys(parsed).sort();
    if (!this.sameKeys(keys, REQUEST_KEYS)) {
      return {
        ok: false,
        error: `Request must contain exactly these top-level fields: ${REQUEST_KEYS.join(', ')}`
      };
    }

    if (parsed.type !== START_AGENTIC_WORKFLOW_REQUEST_TYPE) {
      return {
        ok: false,
        error: `Unsupported request type: ${String(parsed.type)}`
      };
    }

    if (typeof parsed.requestId !== 'string' || parsed.requestId.trim().length === 0) {
      return { ok: false, error: 'requestId must be a non-empty string' };
    }
    if (parsed.requestId !== expectedRequestId) {
      return {
        ok: false,
        error: `requestId must match filename: expected ${expectedRequestId}, received ${parsed.requestId}`
      };
    }
    if (!REQUEST_ID_PATTERN.test(parsed.requestId)) {
      return {
        ok: false,
        error: 'requestId must use the start-agentic-workflow-YYYYMMDDHHmmss format'
      };
    }

    if (typeof parsed.goal !== 'string' || parsed.goal.trim().length === 0) {
      return { ok: false, error: 'goal must be a non-empty string' };
    }

    return {
      ok: true,
      request: {
        requestId: parsed.requestId,
        goal: parsed.goal.trim()
      }
    };
  }

  private writeResult(requestFilePath: string, result: AgentChatTriggerResult): AgentChatTriggerResult {
    if (result.status === 'started' && (!result.runId || result.runId.trim().length === 0)) {
      throw new Error('Started trigger result requires a non-empty runId');
    }
    if ((result.status === 'failed' || result.status === 'ignored') && (!result.error || result.error.trim().length === 0)) {
      throw new Error(`${result.status} trigger result requires a non-empty error`);
    }

    const resultPath = this.resultPathForRequest(requestFilePath, result.requestId);
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    const tmpPath = `${resultPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmpPath, resultPath);
    return result;
  }

  private resultPathForRequest(requestFilePath: string, requestId: string): string {
    return path.join(path.dirname(requestFilePath), `${requestId}.result.json`);
  }

  private requestIdFromFileName(fileName: string): string {
    return fileName.endsWith('.json') ? fileName.slice(0, -'.json'.length) : fileName;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private sameKeys(actual: string[], expected: string[]): boolean {
    return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
  }
}

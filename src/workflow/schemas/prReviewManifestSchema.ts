import { SchemaValidationResult, WorkflowSchemaRegistry } from '../workflowSchemaRegistry';

export const INDEX_SERVING_PR_REVIEW_MANIFEST_SCHEMA_ID = 'indexServing.prReviewManifest';

export function registerIndexServingPrReviewSchemas(registry: WorkflowSchemaRegistry): void {
  registry.register(INDEX_SERVING_PR_REVIEW_MANIFEST_SCHEMA_ID, validatePrReviewManifest);
}

export interface PrReviewManifest {
  prs: PrReviewTarget[];
}

export interface PrReviewTarget {
  number: number;
  title?: string;
  url: string;
  author?: string;
  channelName?: string;
  slackPermalink?: string;
  reason: string;
  threadStatus?: string;
}

export function validatePrReviewManifest(value: unknown): SchemaValidationResult<PrReviewManifest> {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return {
      valid: false,
      errors: ['indexServing.prReviewManifest must be an object']
    };
  }

  if (!Array.isArray(value.prs)) {
    return {
      valid: false,
      errors: ['indexServing.prReviewManifest.prs must be an array']
    };
  }

  const seenNumbers = new Set<number>();
  value.prs.forEach((item, index) => {
    const targetErrors = validatePrReviewTarget(item, index);
    errors.push(...targetErrors);

    if (isRecord(item) && typeof item.number === 'number') {
      if (seenNumbers.has(item.number)) {
        errors.push(`indexServing.prReviewManifest.prs[${index}].number duplicates PR #${item.number}`);
      }
      seenNumbers.add(item.number);
    }
  });

  return {
    valid: errors.length === 0,
    value: errors.length === 0 ? {
      ...value,
      prs: value.prs as PrReviewTarget[]
    } : undefined,
    errors
  };
}

function validatePrReviewTarget(value: unknown, index: number): string[] {
  const errors: string[] = [];
  const prefix = `indexServing.prReviewManifest.prs[${index}]`;

  if (!isRecord(value)) {
    return [`${prefix} must be an object`];
  }

  if (!Number.isInteger(value.number) || typeof value.number !== 'number' || value.number <= 0) {
    errors.push(`${prefix}.number must be a positive integer`);
  }

  if (typeof value.url !== 'string' || value.url.trim().length === 0) {
    errors.push(`${prefix}.url is required`);
  } else {
    const urlNumber = getGithubPullRequestNumber(value.url);
    if (urlNumber === undefined) {
      errors.push(`${prefix}.url must match https://github.com/<owner>/<repo>/pull/<number>`);
    } else if (typeof value.number === 'number' && urlNumber !== value.number) {
      errors.push(`${prefix}.url PR number ${urlNumber} does not match number ${value.number}`);
    }
  }

  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    errors.push(`${prefix}.reason is required`);
  }

  validateOptionalString(value, 'title', prefix, errors);
  validateOptionalString(value, 'author', prefix, errors);
  validateOptionalString(value, 'channelName', prefix, errors);
  validateOptionalString(value, 'slackPermalink', prefix, errors);
  validateOptionalString(value, 'threadStatus', prefix, errors);

  return errors;
}

function getGithubPullRequestNumber(url: string): number | undefined {
  const match = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
  if (!match) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function validateOptionalString(
  value: Record<string, unknown>,
  field: keyof PrReviewTarget,
  prefix: string,
  errors: string[]
): void {
  if (value[field] !== undefined && typeof value[field] !== 'string') {
    errors.push(`${prefix}.${field} must be a string when provided`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

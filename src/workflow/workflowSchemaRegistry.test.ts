import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowSchemaRegistry } from './workflowSchemaRegistry';

const prReviewManifestSchema = {
  $id: 'indexServing.prReviewManifest',
  type: 'object',
  required: ['prs'],
  additionalProperties: false,
  properties: {
    prs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'repo', 'url', 'reason'],
        additionalProperties: false,
        properties: {
          number: {
            type: 'integer',
            minimum: 1
          },
          repo: {
            type: 'string',
            enum: ['world', 'index-serving']
          },
          url: {
            type: 'string',
            minLength: 1,
            pattern: '^https://github\\.com/[^/\\s]+/[^/\\s]+/pull/[0-9]+(?:[/?#].*)?$'
          },
          reason: {
            type: 'string',
            minLength: 1
          }
        }
      }
    }
  }
};

test('registers and validates file-backed JSON schemas', () => {
  const registry = new WorkflowSchemaRegistry();
  const registration = registry.registerJsonSchema(prReviewManifestSchema, 'pr-review-manifest.schema.json');

  assert.deepEqual(registration, {
    valid: true,
    value: 'indexServing.prReviewManifest',
    errors: []
  });
  assert.equal(registry.has('indexServing.prReviewManifest'), true);

  const result = registry.validate('indexServing.prReviewManifest', {
    prs: [
      {
        number: 123,
        repo: 'world',
        url: 'https://github.com/Shopify/world/pull/123',
        reason: 'Tagged me for review'
      },
      {
        number: 456,
        repo: 'index-serving',
        url: 'https://github.com/Shopify/index-serving/pull/456',
        reason: 'Asked for approval'
      }
    ]
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value, {
    prs: [
      {
        number: 123,
        repo: 'world',
        url: 'https://github.com/Shopify/world/pull/123',
        reason: 'Tagged me for review'
      },
      {
        number: 456,
        repo: 'index-serving',
        url: 'https://github.com/Shopify/index-serving/pull/456',
        reason: 'Asked for approval'
      }
    ]
  });
});

test('reports tight JSON schema validation errors for unsupported PR manifest values', () => {
  const registry = new WorkflowSchemaRegistry();
  registry.registerJsonSchema(prReviewManifestSchema);

  const result = registry.validate('indexServing.prReviewManifest', {
    prs: [
      {
        number: 0,
        repo: 'shopify',
        url: 'not-a-pr-url',
        reason: ''
      },
      {
        number: 2,
        repo: 'world',
        url: 'https://github.com/Shopify/world/pull/2',
        extra: true
      }
    ],
    extraRoot: true
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'indexServing.prReviewManifest.prs[0].number must be >= 1',
    'indexServing.prReviewManifest.prs[0].repo must be one of: world, index-serving',
    'indexServing.prReviewManifest.prs[0].url must match pattern ^https://github\\.com/[^/\\s]+/[^/\\s]+/pull/[0-9]+(?:[/?#].*)?$',
    'indexServing.prReviewManifest.prs[0].reason must have length >= 1',
    'indexServing.prReviewManifest.prs[1].reason is required',
    'indexServing.prReviewManifest.prs[1].extra is not allowed',
    'indexServing.prReviewManifest.extraRoot is not allowed'
  ]);
});

test('clears only file-backed JSON schemas and preserves built-in validators', () => {
  const registry = new WorkflowSchemaRegistry();
  registry.register('workflow.stepStatus', value => ({
    valid: value === 'ok',
    value,
    errors: value === 'ok' ? [] : ['not ok']
  }));
  registry.registerJsonSchema(prReviewManifestSchema);

  registry.clearJsonSchemas();

  assert.equal(registry.has('indexServing.prReviewManifest'), false);
  assert.equal(registry.has('workflow.stepStatus'), true);
  assert.deepEqual(registry.validate('workflow.stepStatus', 'ok'), {
    valid: true,
    value: 'ok',
    errors: []
  });
});

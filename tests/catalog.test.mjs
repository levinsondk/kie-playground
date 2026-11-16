import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import {
  ROOT, SOURCE, discoverDocuments, resolvePointer, resolveSchema, parseOpenApi,
  documentedModelIds, importDocument, fetchText, atomicJson, syncCatalog,
} from '../scripts/sync-catalog.mjs';

const metadata = { name: 'Test model', family: 'Tests', description: 'Index description', docsUrl: 'https://docs.kie.ai/market/tests/model.md' };
const indexFor = (url = metadata.docsUrl) => `- Image    Models > Tests [Test model](${url}): Description\n`;
function apiDocument({ id = 'official/model', endpoint = '/api/v1/jobs/createTask' } = {}) {
  return `\n\`\`\`json\n${JSON.stringify({ openapi: '3.0.1', paths: { [endpoint]: { post: { operationId: 'documented-legacy-operation', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['model', 'input'], properties: {
    model: { type: 'string', enum: [id] }, callBackUrl: { type: 'string' },
    input: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, enabled: { type: 'boolean', default: false }, model: { type: 'string', enum: ['pro', 'max'] } } },
  } } } } } } } } })}\n\`\`\`\n`;
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const compile = schema => new Ajv({ strict: false, allErrors: true, validateFormats: false, allowUnionTypes: true }).compile(schema);

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'kie-catalog-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('official index discovery handles variable whitespace and excludes Chinese/callback/non-image pages', () => {
  const index = `${indexFor()}${indexFor()}- Image Models > Tests [中文](https://docs.kie.ai/cn/market/tests.md): x\n- Image Models > Legacy [Callback](https://docs.kie.ai/legacy/callback.md): x\n- Video Models > Tests [Video](https://docs.kie.ai/market/video.md): x\n- Image Models > Tests [Unofficial](https://example.com/test.md): x\n`;
  const result = discoverDocuments(index);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].family, 'Tests');
  assert.equal(result.excluded.length, 4);
  assert.throws(() => discoverDocuments('# Empty'), /no English image-model/);
});

test('local references decode URI fragments and JSON-pointer escapes in the correct order', () => {
  const document = { components: { schemas: { 'a b/~': { type: 'boolean', default: false } } } };
  assert.deepEqual(resolvePointer(document, '#/components/schemas/a%20b~1~0'), { type: 'boolean', default: false });
  assert.equal(resolvePointer(document, '#'), document);
  assert.throws(() => resolvePointer(document, '#/missing'), /Unresolved/);
  assert.throws(() => resolvePointer(document, 'https://example.com/schema'), /Only local/);
});

test('recursive refs and allOf expose all nested properties and union every required list', () => {
  const document = { components: { schemas: {
    'base input': { type: 'object', properties: { prompt: { type: 'string' }, toggle: { type: 'boolean', default: false } }, required: ['prompt'] },
    item: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  } } };
  const schema = resolveSchema({ allOf: [
    { $ref: '#/components/schemas/base%20input' },
    { properties: { images: { type: 'array', items: { $ref: '#/components/schemas/item' } } }, required: ['images'] },
  ], properties: { prompt: { minLength: 2 }, nested: { allOf: [{ properties: { a: { type: 'boolean' } }, required: ['a'] }, { properties: { b: { type: 'integer' } }, required: ['b'] }] } }, required: ['nested'] }, document);
  assert.deepEqual(schema.required, ['prompt', 'images', 'nested']);
  assert.deepEqual(schema.properties.prompt, { type: 'string', minLength: 2 });
  assert.equal(schema.properties.toggle.default, false);
  assert.deepEqual(schema.properties.nested.required, ['a', 'b']);
  assert.deepEqual(schema.properties.images.items.required, ['url']);
  const check = compile(schema);
  assert.equal(check({ prompt: 'ok', images: [{ url: 'x' }], nested: { a: false, b: 1 } }), true);
  assert.equal(check({ prompt: 'ok', images: [{}], nested: { a: false } }), false);
});

test('allOf preserves conflicting constraints instead of overwriting them', () => {
  const schema = resolveSchema({ allOf: [{ type: 'string', minLength: 2, pattern: '^a' }, { minLength: 3, maxLength: 4, pattern: 'z$' }] }, {});
  const check = compile(schema);
  assert.equal(check('abz'), true);
  for (const value of ['az', 'abzzzz', 'abx', 'xbz']) assert.equal(check(value), false, value);
  assert.equal(schema.minLength, 3);
});

test('allOf does not relax additionalProperties restrictions when exposing properties', () => {
  const original = { allOf: [
    { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
    { properties: { b: { type: 'string' } }, required: ['b'] },
  ] };
  const resolved = resolveSchema(original, {});
  assert.deepEqual(Object.keys(resolved.properties), ['a', 'b']);
  const before = compile(original), after = compile(resolved);
  for (const value of [{}, { a: 'x' }, { b: 'y' }, { a: 'x', b: 'y' }, { c: 1 }]) assert.equal(after(value), before(value));
});

test('circular and missing references fail explicitly rather than dropping schemas', () => {
  const document = { components: { schemas: { loop: { $ref: '#/components/schemas/loop' } } } };
  assert.throws(() => resolveSchema({ $ref: '#/components/schemas/loop' }, document), /Circular/);
  assert.throws(() => resolveSchema({ $ref: '#/components/schemas/missing' }, document), /Unresolved/);
});

test('examples and extension values remain data, never become defaults or schema references', () => {
  const schema = { type: 'object', properties: { toggle: { type: 'boolean', example: false, description: 'Defaults to false.' } }, example: { $ref: 'literal text' }, 'x-data': { $ref: 'not a schema' } };
  assert.deepEqual(resolveSchema(schema, {}), schema);
  assert.equal(Object.hasOwn(resolveSchema(schema, {}).properties.toggle, 'default'), false);
});

test('IDs come only from documented const/enum/default, never titles/examples/operation slugs', () => {
  assert.deepEqual(documentedModelIds({ enum: ['one', 'two'] }), ['one', 'two']);
  assert.deepEqual(documentedModelIds({ const: 'official/id' }), ['official/id']);
  assert.deepEqual(documentedModelIds({ default: 'official/default' }), ['official/default']);
  assert.throws(() => documentedModelIds({ example: 'guess/me' }), /refusing to guess/);
  assert.throws(() => documentedModelIds({ enum: [] }), /Invalid/);
  assert.throws(() => documentedModelIds({ const: 'one', enum: ['two'] }), /Contradictory/);
});

test('market importer preserves full request and nested model input fields', () => {
  const [model] = importDocument(metadata, apiDocument());
  assert.equal(model.id, 'official/model');
  assert.equal(model.transport, 'market');
  assert.equal(model.supported, true);
  assert.equal(model.method, 'POST');
  assert.deepEqual(model.inputSchema, model.requestSchema.properties.input);
  assert.deepEqual(model.inputSchema.properties.model.enum, ['pro', 'max']);
  assert.equal(model.inputSchema.properties.enabled.default, false);
  assert.ok(model.requestSchema.properties.callBackUrl);
});

test('legacy endpoints preserve schemas but cannot be submitted while polling is unverified', () => {
  const [model] = importDocument(metadata, apiDocument({ endpoint: '/api/v1/legacy/generate' }));
  assert.equal(model.transport, 'legacy');
  assert.equal(model.supported, false);
  assert.match(model.reason, /polling.*unverified/);
  assert.equal(model.id, 'documented-legacy-operation');
  assert.deepEqual(model.inputSchema, model.requestSchema);
});

test('Markdown parser rejects prose/invalid API blocks and accepts official YAML fences', () => {
  assert.throws(() => parseOpenApi('# no spec'), /No fenced OpenAPI/);
  assert.throws(() => parseOpenApi('```yaml\nhello: world\n```'), /No fenced OpenAPI/);
  assert.equal(parseOpenApi('```yaml\nopenapi: 3.0.1\npaths: {}\n```').length, 1);
});

test('fetch uses bounded retries and never retries a terminal 404', async () => {
  let attempts = 0;
  assert.equal(await fetchText('https://docs.kie.ai/test.md', { delay: 0, fetchImpl: async () => ++attempts < 3 ? new Response('', { status: 503 }) : new Response('official') }), 'official');
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(fetchText('https://docs.kie.ai/test.md', { delay: 0, fetchImpl: async () => { attempts++; return new Response('', { status: 404 }); } }), /HTTP 404/);
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(fetchText('https://docs.kie.ai/test.md', { delay: 0, fetchImpl: async () => { attempts++; throw new Error('network offline'); } }), /network offline/);
  assert.equal(attempts, 3);
});

test('atomic catalog writes contain complete JSON', async t => {
  const root = await temporary(t);
  const path = join(root, 'nested', 'catalog.json');
  await atomicJson(path, { version: 1, models: ['one'] });
  await atomicJson(path, { version: 2, models: ['one', 'two'] });
  assert.deepEqual(await json(path), { version: 2, models: ['one', 'two'] });
});

test('failed sync saves detailed coverage and raw sources but never overwrites the last good catalog', async t => {
  const root = await temporary(t);
  let fail = false;
  const fetchImpl = async url => new Response(url === SOURCE ? indexFor() : fail ? '# no spec' : apiDocument());
  await syncCatalog({ root, fetchImpl });
  const before = await readFile(join(root, 'data/catalog.json'), 'utf8');
  fail = true;
  await assert.rejects(syncCatalog({ root, fetchImpl }), /previous catalog preserved/);
  assert.equal(await readFile(join(root, 'data/catalog.json'), 'utf8'), before);
  const report = await json(join(root, 'data/coverage.json'));
  assert.equal(report.status, 'failed');
  assert.equal(report.coverage.discovered, 1);
  assert.equal(report.coverage.failures[0].docsUrl, metadata.docsUrl);
  assert.match(report.coverage.failures[0].reason, /No fenced OpenAPI/);
  assert.equal(await readFile(join(root, 'data/sources/market/tests/model.md'), 'utf8'), '# no spec');
});

test('disappeared IDs require explicit removal acknowledgement', async t => {
  const root = await temporary(t);
  let id = 'old';
  const fetchImpl = async url => new Response(url === SOURCE ? indexFor() : apiDocument({ id }));
  await syncCatalog({ root, fetchImpl });
  id = 'new';
  await assert.rejects(syncCatalog({ root, fetchImpl }), /previous catalog preserved/);
  assert.deepEqual((await json(join(root, 'data/coverage.json'))).removedModelIds, ['old']);
  assert.equal((await json(join(root, 'data/catalog.json'))).models[0].id, 'old');
  assert.equal((await syncCatalog({ root, fetchImpl, allowRemovals: true })).models[0].id, 'new');
});

test('duplicate IDs across distinct discovered pages fail instead of silently losing a model', async t => {
  const root = await temporary(t);
  const fetchImpl = async url => new Response(url === SOURCE ? indexFor() + indexFor('https://docs.kie.ai/market/tests/other.md') : apiDocument());
  await assert.rejects(syncCatalog({ root, fetchImpl }), /previous catalog preserved/);
  assert.match((await json(join(root, 'data/coverage.json'))).coverage.failures[0].reason, /Duplicate documented model ID/);
  await assert.rejects(readFile(join(root, 'data/catalog.json')), { code: 'ENOENT' });
});

// An independent audit of every source schema: parameters, defaults, constraints,
// and required lists must survive import, including reference/allOf descendants.
function auditSourceSchema(raw, actual, spec, path = '') {
  if (typeof raw === 'boolean') { assert.equal(actual, raw, path); return; }
  if (raw.$ref) auditSourceSchema(resolvePointer(spec, raw.$ref), actual, spec, `${path} -> ${raw.$ref}`);
  for (const part of raw.allOf || []) auditSourceSchema(part, actual, spec, path);
  for (const [name, schema] of Object.entries(raw.properties || {})) {
    assert.ok(Object.hasOwn(actual.properties || {}, name), `Missing property ${path}/${name}`);
    auditSourceSchema(schema, actual.properties[name], spec, `${path}/${name}`);
  }
  for (const name of raw.required || []) assert.ok(actual.required?.includes(name), `Missing required ${path}/${name}`);
  for (const key of ['type', 'default', 'const', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'description', 'example', 'examples']) {
    if (Object.hasOwn(raw, key)) assert.deepEqual(actual[key], raw[key], `Changed ${path}.${key}`);
  }
  if (raw.items) auditSourceSchema(raw.items, actual.items, spec, `${path}/items`);
  for (const key of ['oneOf', 'anyOf']) {
    if (raw[key]) raw[key].forEach((part, index) => auditSourceSchema(part, actual[key][index], spec, `${path}/${key}/${index}`));
  }
}

test('real catalog covers every official English image document exactly once, with zero failures', async () => {
  const catalog = await json(join(ROOT, 'data/catalog.json'));
  const report = await json(join(ROOT, 'data/coverage.json'));
  const { documents } = discoverDocuments(await readFile(join(ROOT, 'data/sources/llms.txt'), 'utf8'));
  assert.equal(report.status, 'complete');
  assert.deepEqual(catalog.coverage.failures, []);
  assert.equal(catalog.coverage.discovered, documents.length);
  assert.equal(catalog.coverage.imported, catalog.models.length);
  assert.equal(catalog.coverage.unsupported, catalog.models.filter(model => !model.supported).length);
  assert.equal(new Set(catalog.models.map(model => model.id)).size, catalog.models.length);
  assert.deepEqual(new Set(catalog.models.map(model => model.docsUrl)), new Set(documents.map(doc => doc.docsUrl)));
  assert.equal(report.documents.length, documents.length);
  assert.ok(catalog.models.length > 50, 'Suspiciously incomplete official catalog');
});

test('every cached official parameter/default/required list survives, and all 65 schemas compile', async () => {
  const catalog = await json(join(ROOT, 'data/catalog.json'));
  for (const model of catalog.models) {
    const cache = join(ROOT, 'data/sources', new URL(model.docsUrl).pathname);
    const specs = parseOpenApi(await readFile(cache, 'utf8'));
    const spec = specs.find(candidate => candidate.paths[model.endpoint]?.post);
    const raw = spec.paths[model.endpoint].post.requestBody.content['application/json'].schema;
    auditSourceSchema(raw, model.requestSchema, spec, model.id);
    assert.deepEqual(model.inputSchema, model.requestSchema.properties.input, model.id);
    assert.ok(documentedModelIds(model.requestSchema.properties.model).includes(model.id));
    compile(model.requestSchema);
    compile(model.inputSchema);
  }
});

test('Grok segment-map preserves its exclusive task_id/image_url alternatives', async () => {
  const { models } = await json(join(ROOT, 'data/catalog.json'));
  const model = models.find(entry => entry.id === 'grok-imagine-image-2-0/segment-map');
  assert.equal(model.inputSchema.oneOf.length, 2);
  const check = compile(model.inputSchema);
  assert.equal(check({ task_id: 'existing_task' }), true);
  assert.equal(check({ image_url: 'https://example.com/reference.png' }), true);
  assert.equal(check({}), false);
  assert.equal(check({ task_id: 'existing_task', image_url: 'https://example.com/reference.png' }), false);
});

test('new Qwen3, Seedream5 and GPT Image 2.5 models plus migrated legacy-named APIs are present', async () => {
  const { models } = await json(join(ROOT, 'data/catalog.json'));
  const qwen = models.filter(model => model.id.startsWith('qwen3/'));
  assert.equal(qwen.length, 4);
  for (const model of qwen) {
    for (const name of ['prompt_extend', 'nsfw_checker', 'negative_prompt', 'seed', 'resolution', 'output_format']) assert.ok(model.inputSchema.properties[name], `${model.id}/${name}`);
    assert.equal(model.inputSchema.properties.prompt_extend.default, true);
  }
  assert.equal(models.filter(model => model.id.startsWith('seedream/5-')).length, 8);
  assert.equal(models.filter(model => /2[.-]5/.test(model.id) && /gpt/.test(model.id)).length, 4);
  const flux = models.find(model => model.id === 'flux1-kontext');
  assert.equal(flux.supported, true);
  assert.ok(flux.inputSchema.properties.model.enum.length >= 2);
  for (const name of ['enable_translation', 'upload_cn', 'prompt_upsampling']) assert.equal(flux.inputSchema.properties[name].type, 'boolean');
  assert.equal(flux.inputSchema.properties.watermark.type, 'string');
  assert.equal(Object.hasOwn(flux.inputSchema.properties.enable_translation, 'default'), false, 'Do not synthesize defaults from prose/examples');
  assert.equal(models.find(model => model.id === '4o-image-api').transport, 'market');
});

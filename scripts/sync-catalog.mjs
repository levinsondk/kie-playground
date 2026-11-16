import { mkdir, readFile, rename, writeFile, open, unlink } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const SOURCE = 'https://docs.kie.ai/llms.txt';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => structuredClone(value);

/** Enumerate the official English image category, not a hand-maintained allowlist. */
export function discoverDocuments(index) {
  const documents = new Map();
  const excluded = [];
  for (const line of index.split(/\r?\n/)) {
    const match = /^\s*-\s+Image\s+Models\s*>\s*(.*?)\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const [, category, name, link, description] = match;
    const url = new URL(link);
    let reason;
    if (url.origin !== 'https://docs.kie.ai') reason = 'Not an official documentation URL';
    else if (/^\/cn(?:\/|\.|$)/i.test(url.pathname)) reason = 'Non-English documentation';
    else if (/callbacks?/i.test(`${url.pathname} ${name}`)) reason = 'Callback documentation';
    else if (!url.pathname.endsWith('.md')) reason = 'Not a Markdown API document';
    if (reason) { excluded.push({ docsUrl: link, reason }); continue; }
    if (documents.has(link)) { excluded.push({ docsUrl: link, reason: 'Duplicate index URL' }); continue; }
    documents.set(link, { docsUrl: link, name: name.trim(), family: category.trim(), description: description.trim() });
  }
  if (!documents.size) throw new Error('The official index contains no English image-model documents; refusing an empty catalog');
  return { documents: [...documents.values()], excluded };
}

export function resolvePointer(document, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) throw new Error(`Only local OpenAPI references are supported: ${ref}`);
  const pointer = decodeURIComponent(ref.slice(1));
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) throw new Error(`Invalid JSON pointer: ${ref}`);
  let target = document;
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(target) && !Array.isArray(target)) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
    if (!Object.hasOwn(target, key)) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
    target = target[key];
  }
  return target;
}

/** Intersect allOf schemas, exposing every property/required entry for form builders.
 * Non-mergeable assertions remain in allOf, so flattening never weakens validation.
 */
export function intersectSchemas(schemas) {
  if (schemas.some(schema => schema === false)) return false;
  const output = {};
  const residual = [];
  const annotation = key => ['title', 'description', 'example', 'examples', '$comment'].includes(key) || key.startsWith('x-');
  for (const schema of schemas) {
    if (schema === true) continue;
    if (!isObject(schema)) throw new Error('Expected a schema object or boolean');
    // These assertions depend on the properties in their original subschema.
    // Moving them onto a union of allOf properties would change validation.
    if (schemas.filter(part => isObject(part) && Object.keys(part).length).length > 1 &&
        ['additionalProperties', 'unevaluatedProperties', 'unevaluatedItems'].some(key => Object.hasOwn(schema, key))) {
      residual.push(clone(schema));
    }
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'allOf') { residual.push(...value); continue; }
      if (key === 'required' && Array.isArray(value)) {
        output.required = [...new Set([...(output.required || []), ...value])];
      } else if (key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'definitions') {
        output[key] ||= {};
        for (const [property, definition] of Object.entries(value)) {
          output[key][property] = Object.hasOwn(output[key], property)
            ? intersectSchemas([output[key][property], definition]) : clone(definition);
        }
      } else if (!Object.hasOwn(output, key) || same(output[key], value) || annotation(key)) {
        output[key] = clone(value);
      } else if (key === 'enum') {
        output.enum = output.enum.filter(item => value.some(other => same(item, other)));
      } else if (['minimum', 'minLength', 'minItems', 'minProperties'].includes(key)) {
        output[key] = Math.max(output[key], value);
      } else if (['maximum', 'maxLength', 'maxItems', 'maxProperties'].includes(key)) {
        output[key] = Math.min(output[key], value);
      } else {
        // Keep the original assertion and intersect the conflicting assertion.
        residual.push({ [key]: clone(value) });
      }
    }
  }
  if (residual.length) output.allOf = residual;
  return output;
}

/** Resolve schema-bearing keywords only: examples/defaults/extensions are data. */
export function resolveSchema(schema, document, stack = []) {
  if (typeof schema === 'boolean') return schema;
  if (!isObject(schema)) throw new Error('Expected an OpenAPI schema object');
  let base = {};
  if (Object.hasOwn(schema, '$ref')) {
    if (stack.includes(schema.$ref)) throw new Error(`Circular OpenAPI reference: ${[...stack, schema.$ref].join(' -> ')}`);
    base = resolveSchema(resolvePointer(document, schema.$ref), document, [...stack, schema.$ref]);
  }
  const own = {};
  const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
  const singles = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'contentSchema']);
  const lists = new Set(['anyOf', 'oneOf', 'prefixItems']);
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' || key === 'allOf') continue;
    if (maps.has(key)) own[key] = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, resolveSchema(item, document, stack)]));
    else if (singles.has(key)) own[key] = Array.isArray(value) ? value.map(item => resolveSchema(item, document, stack)) : resolveSchema(value, document, stack);
    else if (lists.has(key)) own[key] = value.map(item => resolveSchema(item, document, stack));
    else if (key === 'dependencies') own[key] = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, Array.isArray(item) ? clone(item) : resolveSchema(item, document, stack)]));
    else own[key] = clone(value);
  }
  const parts = [base, ...(schema.allOf || []).map(item => resolveSchema(item, document, stack)), own];
  return intersectSchemas(parts);
}

export function parseOpenApi(markdown) {
  const specs = [];
  for (const match of markdown.matchAll(/^```(?:yaml|yml|json)\s*\r?\n([\s\S]*?)^```\s*$/gm)) {
    const document = YAML.parse(match[1]);
    if (document?.openapi && isObject(document.paths)) specs.push(document);
  }
  if (!specs.length) throw new Error('No fenced OpenAPI specification found');
  return specs;
}

function dereferenceObject(value, document, stack = []) {
  if (!value?.$ref) return value;
  if (stack.includes(value.$ref)) throw new Error(`Circular OpenAPI object reference: ${value.$ref}`);
  return { ...dereferenceObject(resolvePointer(document, value.$ref), document, [...stack, value.$ref]), ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')) };
}

export function documentedModelIds(schema) {
  if (!isObject(schema)) throw new Error('Market request has no model schema');
  let candidates;
  if (Object.hasOwn(schema, 'const')) candidates = [schema.const];
  else if (Array.isArray(schema.enum)) candidates = schema.enum;
  else if (Object.hasOwn(schema, 'default')) candidates = [schema.default];
  else throw new Error('Market model ID is not documented as enum, default, or const; refusing to guess');
  if (!candidates.length || candidates.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid documented model ID');
  if (schema.enum && candidates.some(id => !schema.enum.includes(id))) throw new Error('Contradictory model const/enum');
  return [...new Set(candidates)];
}

export function importDocument(metadata, markdown) {
  const models = [];
  for (const spec of parseOpenApi(markdown)) {
    for (const [endpoint, rawPath] of Object.entries(spec.paths)) {
      const path = dereferenceObject(rawPath, spec);
      if (!path?.post) continue;
      const operation = dereferenceObject(path.post, spec);
      const body = dereferenceObject(operation.requestBody, spec);
      const rawSchema = body?.content?.['application/json']?.schema;
      if (!rawSchema) throw new Error(`POST ${endpoint} has no JSON request schema`);
      const requestSchema = resolveSchema(rawSchema, spec);
      const transport = endpoint === '/api/v1/jobs/createTask' ? 'market' : 'legacy';
      const supported = transport === 'market';
      const inputSchema = supported ? requestSchema.properties?.input : requestSchema;
      if (!isObject(inputSchema)) throw new Error(`POST ${endpoint} has no resolved input schema`);
      const ids = supported ? documentedModelIds(requestSchema.properties?.model) : [operation.operationId || endpoint];
      for (const id of ids) {
        models.push({ id, name: metadata.name || operation.summary || id, family: metadata.family,
          description: operation.description || metadata.description || '', docsUrl: metadata.docsUrl,
          endpoint, method: 'POST', requestSchema: clone(requestSchema), inputSchema: clone(inputSchema),
          transport, supported, ...(!supported ? { reason: 'Legacy endpoint: task polling and result decoding are unverified; submission is disabled.' } : {}) });
      }
    }
  }
  if (!models.length) throw new Error('No POST model operation found in document');
  return models;
}

export async function fetchText(url, { fetchImpl = fetch, attempts = 3, timeout = 25000, delay = 350 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeout), headers: { Accept: 'text/plain, text/markdown;q=0.9', 'User-Agent': 'kie-playground-catalog/1.0' } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} fetching ${url}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const text = await response.text();
      if (!text.trim()) throw new Error(`Empty response fetching ${url}`);
      return text;
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === attempts - 1) break;
      await new Promise(done => setTimeout(done, delay * 2 ** attempt));
    }
  }
  throw lastError;
}

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function mapBounded(items, limit, worker) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await worker(items[index], index); }
  }));
  return output;
}

export async function syncCatalog({ root = ROOT, fetchImpl = fetch, allowRemovals = false, concurrency = 6 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Concurrency must be an integer from 1 to 16');
  const data = resolve(root, 'data');
  const sources = resolve(data, 'sources');
  const reportPath = resolve(data, 'coverage.json');
  const updatedAt = new Date().toISOString();
  const report = { updatedAt, source: SOURCE, status: 'failed', coverage: { discovered: 0, imported: 0, unsupported: 0, failures: [] }, documents: [], excluded: [], removedModelIds: [] };
  try {
    const index = await fetchText(SOURCE, { fetchImpl });
    await mkdir(sources, { recursive: true });
    await writeFile(resolve(sources, 'llms.txt'), index);
    const { documents, excluded } = discoverDocuments(index);
    report.coverage.discovered = documents.length;
    report.excluded = excluded;
    const batches = await mapBounded(documents, concurrency, async metadata => {
      const cache = resolve(sources, `.${new URL(metadata.docsUrl).pathname}`);
      if (!cache.startsWith(`${sources}/`)) throw new Error('Unsafe documentation cache path');
      try {
        const markdown = await fetchText(metadata.docsUrl, { fetchImpl });
        await mkdir(dirname(cache), { recursive: true });
        await writeFile(cache, markdown);
        const models = importDocument(metadata, markdown);
        return { models, entry: { ...metadata, cache: relative(root, cache), modelIds: models.map(model => model.id), status: 'imported', unsupported: models.filter(model => !model.supported).length } };
      } catch (error) {
        return { models: [], entry: { ...metadata, cache: relative(root, cache), status: 'failed', error: error.message } };
      }
    });
    report.documents = batches.map(batch => batch.entry);
    const models = batches.flatMap(batch => batch.models);
    report.coverage.imported = models.length;
    report.coverage.unsupported = models.filter(model => !model.supported).length;
    report.coverage.failures = report.documents.filter(entry => entry.status === 'failed').map(entry => ({ docsUrl: entry.docsUrl, reason: entry.error }));
    const ids = new Set();
    for (const model of models) {
      if (ids.has(model.id)) report.coverage.failures.push({ docsUrl: model.docsUrl, reason: `Duplicate documented model ID: ${model.id}` });
      ids.add(model.id);
    }
    let previous;
    try { previous = JSON.parse(await readFile(resolve(data, 'catalog.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    report.removedModelIds = (previous?.models || []).map(model => model.id).filter(id => !ids.has(id));
    if (report.removedModelIds.length && !allowRemovals) report.coverage.failures.push({ reason: 'Existing model IDs disappeared. Inspect coverage, then pass --allow-removals to acknowledge official removals.', modelIds: report.removedModelIds });
    if (report.coverage.failures.length) throw new Error(`${report.coverage.failures.length} catalog failure(s); previous catalog preserved`);
    const catalog = { updatedAt, source: SOURCE, models, coverage: report.coverage };
    await atomicJson(resolve(data, 'catalog.json'), catalog);
    report.status = 'complete';
    await atomicJson(reportPath, report);
    return catalog;
  } catch (error) {
    report.error = error.message;
    if (!report.coverage.failures.length) report.coverage.failures.push({ reason: error.message });
    await atomicJson(reportPath, report);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unknown = process.argv.slice(2).filter(arg => arg !== '--allow-removals');
  if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(', ')}`); process.exitCode = 1; }
  else syncCatalog({ allowRemovals: process.argv.includes('--allow-removals') }).then(catalog => {
    console.log(JSON.stringify({ ...catalog.coverage, catalog: 'data/catalog.json', report: 'data/coverage.json', sources: 'data/sources' }, null, 2));
  }).catch(error => { console.error(error.message); console.error('See data/coverage.json. No incomplete catalog was published.'); process.exitCode = 1; });
}

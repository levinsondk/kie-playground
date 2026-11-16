# Official image catalog importer

Run from the project root:

```sh
npm run catalog:refresh
npm test
```

The importer reads `https://docs.kie.ai/llms.txt`, discovers every English entry in the **Image Models** category (including image editing/upscaling/background removal), excludes callback documentation and Chinese pages, downloads every linked Markdown document, and parses its fenced OpenAPI specification with `yaml`.

## Artifacts

- `data/catalog.json`: runtime catalog. Each model includes its documented ID, endpoint, full resolved request schema, full `input` schema, and transport/support status.
- `data/coverage.json`: per-document import results, cache paths, imported IDs, exclusions, failures, and removed IDs.
- `data/sources/llms.txt`: exact downloaded discovery index.
- `data/sources/<documentation path>.md`: exact downloaded source documents. These are cached for provenance and offline tests, not silently used as fallback when fetching fails.

Coverage definitions: `discovered` counts unique eligible documentation URLs, `imported` counts model entries emitted from those documents (including unsupported entries), `unsupported` counts entries that cannot be submitted, and `failures` is a structured list. A document with several documented model IDs produces several entries rather than selecting one and losing the others.

## Safety and fidelity

Only public documentation GETs are performed. No credentials, account calls, model submissions, or paid requests are used.

- Model IDs come from the request's `model` enum, const, or default, never names, paths, examples, or guesses.
- Every documented request/input field is retained, including nested `input.model`, booleans, constraints, descriptions, examples, and defaults. Examples and prose are **not converted into schema defaults**.
- Local JSON pointers are URI-decoded and JSON-pointer-unescaped. Schema references resolve recursively; `allOf` combines properties and required lists while retaining conflicting assertions. Circular/missing/external references fail explicitly rather than yielding incomplete schemas.
- OpenAPI extension metadata is retained as metadata; reference-looking values within extensions/examples/defaults are not treated as active JSON Schema references.
- Market submission support is determined by the actual `/api/v1/jobs/createTask` endpoint, not the documentation folder. The current 4o and Flux Kontext pages use Market and are supported. A future truly legacy endpoint remains in the catalog with its documented operation ID (or endpoint if absent), full schemas, `supported: false`, and an unverified-polling reason.
- Fetch concurrency is bounded at six; each fetch has a 25-second timeout and at most three attempts with bounded exponential backoff. Terminal HTTP failures such as 404 are not retried.
- Any discovered-document fetch/parse/import failure or duplicate ID blocks publication. The coverage report records the failure; the last complete catalog remains untouched.
- Removed model IDs block publication by default. After reviewing official removals in `data/coverage.json`, acknowledge them explicitly with `npm run catalog:refresh -- --allow-removals`.
- Catalog/report JSON writes use a same-directory temporary file, fsync, and atomic rename. Raw documentation caches can update during a failed run; their per-run status is reported separately.

`tests/catalog.test.mjs` exercises discovery, URI-encoded references, recursive `allOf` and required lists, defaults, nested model selectors, legacy gating, bounded retries, atomic output, failed-sync preservation, removals, duplicate IDs, and every cached official request/input schema. Offline tests audit every documented parameter and compile every emitted schema with Ajv.

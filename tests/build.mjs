// The browser tests run against a fresh build of the current source. It is kept apart from dist/, which the running app serves.
import { build } from 'vite';
import os from 'node:os';
import path from 'node:path';
export default async () => { const outDir = path.join(os.tmpdir(), 'kie-ui-tests-dist'); await build({ logLevel: 'warn', build: { outDir, emptyOutDir: true } }); process.env.KIE_UI_DIST = outDir; };

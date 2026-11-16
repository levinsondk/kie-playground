import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'./tests',testMatch:'*.spec.mjs',fullyParallel:false,workers:1,
 globalSetup:'./tests/build.mjs',
 use:{browserName:'chromium',channel:'chrome',viewport:{width:1440,height:1000}},
 reporter:'list'
});

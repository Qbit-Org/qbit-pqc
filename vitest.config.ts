import { readFileSync } from 'node:fs'

import { defineConfig } from 'vitest/config'

import { pinnedWasmSha256 } from './scripts/wasm-sha256.mjs'

export default defineConfig({
  plugins: [
    {
      // src/index.ts imports wasm/pqc.wasm as a base64 string, which the build
      // inlines with esbuild's base64 loader (tsup.config.ts).
      name: 'wasm-base64',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('.wasm')) {
          return `export default ${JSON.stringify(readFileSync(id).toString('base64'))}`
        }
        return undefined
      },
    },
  ],
  // constants.WASM_SHA256, as the build defines it (tsup.config.ts). Vitest sets
  // it on globalThis rather than replacing it in the source.
  define: { __PQC_WASM_SHA256__: JSON.stringify(pinnedWasmSha256()) },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    exclude: ['node_modules', 'dist', 'build'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
})

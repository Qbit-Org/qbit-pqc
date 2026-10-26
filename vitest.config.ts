import { readFileSync } from 'node:fs'

import { defineConfig } from 'vitest/config'

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
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    exclude: ['node_modules', 'dist', 'build'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
})

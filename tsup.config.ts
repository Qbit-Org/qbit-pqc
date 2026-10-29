import { defineConfig } from 'tsup'

import { pinnedWasmSha256 } from './scripts/wasm-sha256.mjs'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'lib',
  target: 'es2020',
  tsconfig: './tsconfig.json',
  // lib/index.mjs imports the Emscripten factory from the shipped
  // wasm/pqc.mjs, the file wasm/SHA256SUMS pins, and carries pqc.wasm inline
  // as base64 (see init() in src/index.ts).
  external: ['../wasm/pqc.mjs'],
  loader: { '.wasm': 'base64' },
  // constants.WASM_SHA256 (src/wasm.d.ts).
  define: { __PQC_WASM_SHA256__: JSON.stringify(pinnedWasmSha256()) },
})

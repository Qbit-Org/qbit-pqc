import { defineConfig, type Options } from 'tsup'

import { pinnedWasmSha256 } from './scripts/wasm-sha256.mjs'

// Each entry, by the name of its source in src/ and of its build in lib/.
// lib/core.mjs holds the implementation, and lib/shared.mjs what it shares with
// the worker client; no `exports` entry names either. The others are the ".",
// "./external-wasm", "./worker" and "./worker/handler" entries.
const ENTRIES = ['core', 'shared', 'external-wasm', 'index', 'worker', 'worker-handler']

// An import of one entry from another, such as `./core`, stays an import of
// the built file, `./core.mjs`, so every entry shares one copy of the
// implementation. scripts/package-surface.mjs checks the built import graph,
// so a source import this misses, which esbuild would copy into the importing
// entry, fails the consumer smoke.
const entryImports: NonNullable<Options['esbuildPlugins']>[number] = {
  name: 'entry-imports',
  setup(build) {
    build.onResolve({ filter: /^\.\/[\w-]+$/ }, ({ path, importer }) =>
      importer !== '' && ENTRIES.includes(path.slice(2)) ? { path: `${path}.mjs`, external: true } : undefined
    )
  },
}

export default defineConfig({
  entry: Object.fromEntries(ENTRIES.map(name => [name, `src/${name}.ts`])),
  format: ['esm'],
  // Declarations leave out what src/core.ts marks @internal.
  dts: { compilerOptions: { stripInternal: true } },
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'lib',
  target: 'es2020',
  tsconfig: './tsconfig.json',
  // lib/core.mjs imports the Emscripten factory from the shipped wasm/pqc.mjs,
  // the file wasm/SHA256SUMS pins, and lib/index.mjs carries pqc.wasm inline
  // as base64 (see src/index.ts).
  external: ['../wasm/pqc.mjs'],
  loader: { '.wasm': 'base64' },
  esbuildPlugins: [entryImports],
  // constants.WASM_SHA256 (src/wasm.d.ts).
  define: { __PQC_WASM_SHA256__: JSON.stringify(pinnedWasmSha256()) },
})

// The Chrome MV3 snippet of README.md, docs/loading.md and
// docs/mv3-conformance.md (test/doc-snippets.test.mjs keeps them in sync),
// type-checked by `pnpm typecheck` under node16 and bundler resolution. Both
// imports resolve through this package's own exports map (a self-reference by
// name), so run `pnpm build` first: the "." entry's types are the built
// lib/index.d.mts.
import { init } from '@qbit-oss/pqc'
import createPqcModule from '@qbit-oss/pqc/wasm/pqc.mjs'

declare const chrome: { runtime: { getURL(path: string): string } }

const pqc = await init({
  createModule: createPqcModule,
  locateFile: path => chrome.runtime.getURL(`wasm/${path}`),
})
void pqc

// @ts-expect-error The factory is typed, not `any`: it takes module options.
void createPqcModule('pqc.wasm')

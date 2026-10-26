// The README's Chrome MV3 snippet (test/readme-mv3-snippet.test.mjs keeps the
// two in sync), type-checked by `pnpm typecheck` under node16 and bundler
// resolution. Both imports resolve through this package's own exports map (a
// self-reference by name), so run `pnpm build` first: the "." entry's types are
// the built lib/index.d.mts.
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

// docs/loading.md's expectedWasmSha256 snippet (test/doc-snippets.test.mjs
// keeps the two in sync), type-checked by `pnpm typecheck`.
import { constants, init } from '@qbit-oss/pqc'

const pqc = await init({
  moduleUrl: new URL('/pqc/pqc.mjs', location.href),
  expectedWasmSha256: constants.WASM_SHA256,
})
void pqc

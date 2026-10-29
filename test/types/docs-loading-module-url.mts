// docs/loading.md's moduleUrl snippet (test/doc-snippets.test.mjs keeps the two
// in sync), type-checked by `pnpm typecheck`.
import { init } from '@qbit-oss/pqc'

const pqc = await init({ moduleUrl: new URL('/pqc/pqc.mjs', location.href) })
void pqc

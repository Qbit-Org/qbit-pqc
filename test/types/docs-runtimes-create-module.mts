// The createModule snippet of docs/runtimes.md (test/doc-snippets.test.mjs
// keeps them in sync), type-checked by `pnpm typecheck`; run `pnpm build`
// first. createCustomModule stands for the factory of a build of your own
// that accepts Emscripten's instantiateWasm, which the package's loader
// ignores.
import type { PqcWasmModule, PqcWasmModuleOptions } from '@qbit-oss/pqc/external-wasm'

type InstantiateWasm = (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => object
declare function createCustomModule(
  options: PqcWasmModuleOptions & { instantiateWasm: InstantiateWasm }
): Promise<PqcWasmModule>
declare const instantiateFromCache: InstantiateWasm

import { init } from '@qbit-oss/pqc/external-wasm'

const pqc = await init({
  createModule: options => createCustomModule({ ...options, instantiateWasm: instantiateFromCache }),
})
void pqc

// Types for index.ts's imports of the WASM build output in wasm/. The build
// (tsup.config.ts) keeps wasm/pqc.mjs, the Emscripten factory, as an import of
// the shipped file and inlines wasm/pqc.wasm as a base64 string; the tests
// load pqc.wasm the same way (vitest.config.ts).

declare module '*/wasm/pqc.mjs' {
  const createModule: import('./index').PqcWasmModuleFactory
  export default createModule
}

declare module '*/wasm/pqc.wasm' {
  const base64: string
  export default base64
}

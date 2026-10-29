// The `@qbit-oss/pqc/external-wasm` entry, built as lib/external-wasm.mjs: the
// public API of the implementation in src/core.ts, built as lib/core.mjs,
// which no `exports` entry names. The lists below are the whole public API:
// helpers that src/core.ts exports for the package's other files stay in
// lib/core.mjs (test/package-surface.test.ts checks both lists). The build
// keeps `./core` as an import of lib/core.mjs (tsup.config.ts), so every entry
// shares its one module instance.
export {
  constants,
  deriveP2mrDescriptorKey,
  derivePQCKey,
  errorCodes,
  errors,
  init,
  isInitialized,
  keygen,
  nativeErrorKind,
  nativeErrorName,
  PqcError,
  PqcLoadError,
  ready,
  secretKeyValidate,
  sign,
  signWithStats,
  verify,
} from './core'

export type {
  InitOptions,
  PqcClient,
  PqcDerivedKey,
  PqcDerivedKeyPair,
  PqcErrorDetails,
  PqcErrorKind,
  PqcKeyPair,
  PqcMessageOptions,
  PqcNativeErrorCode,
  PqcNativeErrorName,
  PqcSignStats,
  PqcSignWithStatsResult,
  PqcWasmModule,
  PqcWasmModuleFactory,
  PqcWasmModuleOptions,
} from './core'

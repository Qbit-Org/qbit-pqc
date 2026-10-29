// What each package entry exports at run time, and how the built lib/ files
// import one another. scripts/consumer-smoke.mjs checks the installed package
// against both, scripts/smoke-load-built.mjs checks the repository's lib/, and
// test/package-surface.test.ts checks the sources.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// The runtime exports of `@qbit-oss/pqc` 0.1.0.
export const EXPORTS_0_1_0 = Object.freeze([
  'PqcError',
  'PqcLoadError',
  'constants',
  'deriveP2mrDescriptorKey',
  'derivePQCKey',
  'errorCodes',
  'errors',
  'init',
  'isInitialized',
  'keygen',
  'nativeErrorKind',
  'nativeErrorName',
  'ready',
  'secretKeyValidate',
  'sign',
  'signWithStats',
  'verify',
])

// The runtime exports of each entry, by the name a consumer imports. Every
// name that 0.1.0 did not export must be documented in the CHANGELOG
// (test/package-surface.test.ts checks), and helpers the package's own files
// share stay in lib/core.mjs, which no entry re-exports.
export const ENTRY_EXPORTS = Object.freeze({
  '@qbit-oss/pqc': EXPORTS_0_1_0,
  '@qbit-oss/pqc/external-wasm': EXPORTS_0_1_0,
})

// Each built lib/*.mjs file and the files it refers to: its static and
// dynamic imports, and what it locates with new URL(..., import.meta.url).
// lib/core.mjs holds the one copy of the implementation. A source import that
// the build did not keep as an import of the built file would put a second
// copy, with state of its own, into the importing entry: its graph would
// change here, and it would contain the implementation's markers below.
export const LIB_GRAPH = Object.freeze({
  'core.mjs': ['../wasm/pqc.mjs', '../wasm/pqc.wasm'],
  'external-wasm.mjs': ['./core.mjs'],
  'index.mjs': ['./core.mjs', './external-wasm.mjs'],
})

// Code that only the file named holds, as esbuild writes it.
export const LIB_MARKERS = Object.freeze({
  'core.mjs': ['function createPqcClient(', 'var PqcError = class'],
})

// The start of a base64 WASM binary: its magic number, \0asm, encodes as
// AGFzbQ. lib/index.mjs carries pqc.wasm this way.
const EMBEDDED_WASM = 'AGFzbQ'

// The files among `files`, paths relative to `dir`, whose text holds a base64
// WASM binary, as lib/index.mjs does. The consumer smoke, the MV3 smoke and the
// bundler smoke use it to check that what loads the external-wasm entry
// carries no such copy.
export function filesEmbeddingWasm(dir, files) {
  return files.filter(file => readFileSync(join(dir, file), 'utf8').includes(EMBEDDED_WASM))
}

// The files `source` refers to, in order of appearance.
export function libReferences(source) {
  const pattern =
    /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bnew URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g
  return [...source.matchAll(pattern)].map(match => match.slice(1).find(value => value !== undefined))
}

// Problems with the built lib/ directory at `libDir`, as messages.
export function checkLib(libDir) {
  const problems = []
  const files = readdirSync(libDir)
    .filter(name => name.endsWith('.mjs'))
    .sort()
  const expected = Object.keys(LIB_GRAPH).sort()
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    problems.push(`lib/ holds ${files.join(', ')}, expected ${expected.join(', ')}`)
  }
  for (const file of files) {
    const source = readFileSync(join(libDir, file), 'utf8')
    const references = [...new Set(libReferences(source))].sort()
    const graph = [...(LIB_GRAPH[file] ?? [])].sort()
    if (JSON.stringify(references) !== JSON.stringify(graph)) {
      problems.push(
        `lib/${file} refers to ${references.join(', ') || 'nothing'}, expected ${graph.join(', ') || 'nothing'}`
      )
    }
    for (const [owner, markers] of Object.entries(LIB_MARKERS)) {
      for (const marker of markers) {
        if (owner !== file && source.includes(marker)) {
          problems.push(`lib/${file} contains ${marker}, which only lib/${owner} may hold`)
        }
        if (owner === file && !source.includes(marker)) {
          problems.push(`lib/${file} lacks ${marker}`)
        }
      }
    }
  }
  return problems
}

// Every file `entry` reaches through LIB_GRAPH-style references, read from
// the built files, as paths relative to lib/ (`../wasm/pqc.mjs` for a file
// outside it).
export function reachableFrom(libDir, entry) {
  const reached = new Set()
  const pending = [`./${entry}`]
  while (pending.length > 0) {
    const reference = pending.pop()
    if (reached.has(reference)) continue
    reached.add(reference)
    if (reference.startsWith('./') && reference.endsWith('.mjs')) {
      pending.push(...libReferences(readFileSync(join(libDir, reference), 'utf8')))
    }
  }
  return [...reached].sort()
}

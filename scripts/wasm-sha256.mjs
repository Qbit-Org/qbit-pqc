// The digests that wasm/SHA256SUMS pins. tsup.config.ts and vitest.config.ts
// define the pqc.wasm one as __PQC_WASM_SHA256__, which src/index.ts exports as
// constants.WASM_SHA256, so a rebuilt pqc.wasm and its new SHA256SUMS line need
// no edit to the source. The build fails when there is no such line, or when
// wasm/pqc.wasm, the file the build embeds, has another digest, so the
// constant always describes the embedded bytes. The tests and the consumer
// smoke read SHA256SUMS through here too.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The digest SHA256SUMS in `dir` (a path or a URL, with or without a trailing
// slash) pins for `name`, after checking that the file in `dir` has it. Lines
// may be in sha256sum's text (' ') or binary ('*') mode, with LF or CRLF
// endings.
export function pinnedSha256(dir, name) {
  const base = new URL(typeof dir === 'string' ? pathToFileURL(dir) : dir)
  if (!base.pathname.endsWith('/')) {
    base.pathname += '/'
  }
  const sumsPath = fileURLToPath(new URL('SHA256SUMS', base))
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const line = new RegExp(`^([0-9a-f]{64}) [ *]${escaped}\\r?$`, 'm')
  const pinned = line.exec(readFileSync(sumsPath, 'utf8'))?.[1]
  if (pinned === undefined) {
    throw new Error(`${sumsPath} has no ${name} line`)
  }
  const filePath = fileURLToPath(new URL(name, base))
  const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex')
  if (actual !== pinned) {
    throw new Error(`${filePath} has SHA-256 ${actual}, but ${sumsPath} pins ${pinned}`)
  }
  return pinned
}

export function pinnedWasmSha256(dir = new URL('../wasm/', import.meta.url)) {
  return pinnedSha256(dir, 'pqc.wasm')
}

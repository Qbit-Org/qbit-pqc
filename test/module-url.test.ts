import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import goldenFixture from '../fixtures/slh-dsa-golden.json'
import { constants, init } from '../src/index'

const wasmDir = fileURLToPath(new URL('../wasm/', import.meta.url))

// Copies of pqc.wasm carry this custom section, which the shipped file lacks,
// so the bytes handed to WebAssembly.instantiate show which file was loaded.
const COPY_MARKER = 'qbit-pqc-test-copy'

function markedWasm(): Buffer {
  const name = Buffer.from(COPY_MARKER)
  // Section id 0 (custom), then the section size and the name length, each a
  // one-byte LEB128 value while the name is shorter than 127 bytes.
  return Buffer.concat([readFileSync(join(wasmDir, 'pqc.wasm')), Uint8Array.of(0, name.length + 1, name.length), name])
}

function hasCopyMarker(source: unknown): boolean {
  const module = new WebAssembly.Module(source as BufferSource)
  return WebAssembly.Module.customSections(module, COPY_MARKER).length === 1
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

describe('init({ moduleUrl })', () => {
  let dir: string
  let moduleUrl: URL

  beforeEach(() => {
    // Resolve symlinks (macOS's /var -> /private/var) so paths compare as the
    // loader reports them.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'qbit-pqc-module-url-')))
    copyFileSync(join(wasmDir, 'pqc.mjs'), join(dir, 'pqc.mjs'))
    moduleUrl = pathToFileURL(join(dir, 'pqc.mjs'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads pqc.wasm from the directory of the module', async () => {
    writeFileSync(join(dir, 'pqc.wasm'), markedWasm())
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')

    const client = await init({ moduleUrl })

    expect(instantiate.mock.calls.map(([source]) => hasCopyMarker(source))).toEqual([true])
    const vector = goldenFixture.vectors[0]!
    const entropy = new Uint8Array(constants.MIN_ENTROPY)
    for (let i = 0; i < entropy.length; i += 1) {
      entropy[i] = (vector.seedByte + ((i * 37) % 256)) & 0xff
    }
    expect(bytesToHex(client.keygen(entropy).publicKey)).toBe(vector.publicKeyHex)
  })

  it('rejects when the directory of the module has no pqc.wasm', async () => {
    // Emscripten logs the failure before it rejects.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // Not `rejects`: a client that loaded by mistake would be printed, WASM heap
    // and all.
    const error = await init({ moduleUrl }).then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(`${dir}/pqc.wasm`)
  })

  it('passes the directory of the module to a custom locateFile', async () => {
    const elsewhere = join(dir, 'elsewhere.wasm')
    writeFileSync(elsewhere, markedWasm())
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')
    const locateFile = vi.fn((_path: string, _prefix: string) => elsewhere)

    await init({ moduleUrl, locateFile })

    expect(locateFile.mock.calls).toEqual([['pqc.wasm', `${dir}/`]])
    expect(instantiate.mock.calls.map(([source]) => hasCopyMarker(source))).toEqual([true])
  })

  it('falls back beside the module when a custom locateFile returns undefined', async () => {
    writeFileSync(join(dir, 'pqc.wasm'), markedWasm())
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')
    const locateFile = vi.fn((_path: string, _prefix: string): string | undefined => undefined)

    await init({ moduleUrl, locateFile })

    expect(locateFile).toHaveBeenCalledWith('pqc.wasm', `${dir}/`)
    expect(instantiate.mock.calls.map(([source]) => hasCopyMarker(source))).toEqual([true])
  })

  it('uses wasmBinary when the directory of the module has no pqc.wasm', async () => {
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')

    await init({ moduleUrl, wasmBinary: markedWasm() })

    expect(instantiate.mock.calls.map(([source]) => hasCopyMarker(source))).toEqual([true])
  })

  it('loads the package copy when the module location has no directory', async () => {
    // A blob: or data: module URL gives Emscripten no directory, so it passes
    // an empty prefix. Wrap the copied factory to do the same here.
    writeFileSync(
      join(dir, 'wrapper.mjs'),
      [
        "import createModule from './pqc.mjs'",
        'export default options =>',
        "  createModule({ ...options, locateFile: path => options.locateFile(path, '') })",
        '',
      ].join('\n')
    )
    writeFileSync(join(dir, 'pqc.wasm'), markedWasm())
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')

    await init({ moduleUrl: pathToFileURL(join(dir, 'wrapper.mjs')) })

    expect(instantiate.mock.calls.map(([source]) => hasCopyMarker(source))).toEqual([false])
  })
})

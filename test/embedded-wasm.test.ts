import { createHash } from 'node:crypto'
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import goldenFixture from '../fixtures/slh-dsa-golden.json'
import {
  constants,
  init,
  type PqcClient,
  type PqcWasmModuleFactory,
  type PqcWasmModuleOptions,
} from '../src/index'

const wasmDir = fileURLToPath(new URL('../wasm/', import.meta.url))

// The pqc.wasm entry of wasm/SHA256SUMS, which `pnpm check:wasm` checks against
// wasm/pqc.wasm and `pnpm check:wasm:repro` against a rebuild of it.
const pinnedWasmSha256 = /^([0-9a-f]{64}) {2}pqc\.wasm$/m.exec(
  readFileSync(join(wasmDir, 'SHA256SUMS'), 'utf8')
)?.[1]

// Copies of pqc.wasm carry this custom section, which the shipped file lacks,
// so the bytes handed to WebAssembly.instantiate show which file was loaded.
const COPY_MARKER = 'qbit-pqc-test-copy'

function markedWasm(): Buffer {
  const name = Buffer.from(COPY_MARKER)
  // Section id 0 (custom), then the section size and the name length, each a
  // one-byte LEB128 value while the name is shorter than 127 bytes.
  return Buffer.concat([
    readFileSync(join(wasmDir, 'pqc.wasm')),
    Uint8Array.of(0, name.length + 1, name.length),
    name,
  ])
}

function sha256(source: unknown): string {
  return createHash('sha256')
    .update(source as Uint8Array)
    .digest('hex')
}

function hasCopyMarker(source: unknown): boolean {
  const module = new WebAssembly.Module(source as BufferSource)
  return WebAssembly.Module.customSections(module, COPY_MARKER).length === 1
}

// The files Emscripten's Node loader read with fs.readFileSync: pqc.wasm, when
// it loads a file.
function wasmFilesRead(readFileSyncSpy: { mock: { calls: unknown[][] } }): string[] {
  return readFileSyncSpy.mock.calls.map(([path]) => String(path)).filter(path => path.endsWith('.wasm'))
}

function expectGoldenKeygen(client: PqcClient): void {
  const vector = goldenFixture.vectors[0]!
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (vector.seedByte + ((i * 37) % 256)) & 0xff
  }
  expect(Buffer.from(client.keygen(entropy).publicKey).toString('hex')).toBe(vector.publicKeyHex)
}

async function packageFactory(): Promise<PqcWasmModuleFactory> {
  const loaded = (await import(new URL('../wasm/pqc.mjs', import.meta.url).href)) as {
    default: PqcWasmModuleFactory
  }
  return loaded.default
}

describe('the copy of pqc.wasm embedded in the package', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qbit-pqc-embedded-wasm-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is the binary that wasm/SHA256SUMS pins, and init() compiles it without reading a file', async () => {
    expect(pinnedWasmSha256).toMatch(/^[0-9a-f]{64}$/)
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')

    expectGoldenKeygen(await init())

    expect(instantiate.mock.calls.map(([source]) => sha256(source))).toEqual([pinnedWasmSha256])
    expect(wasmFilesRead(readFileSyncSpy)).toEqual([])
  })

  it('is passed as wasmBinary to a createModule without locateFile', async () => {
    const createModule = await packageFactory()
    const received: PqcWasmModuleOptions[] = []
    const recordingFactory: PqcWasmModuleFactory = options => {
      received.push({ ...options })
      return createModule(options)
    }

    expectGoldenKeygen(await init({ createModule: recordingFactory }))

    expect(received.map(options => sha256(options.wasmBinary))).toEqual([pinnedWasmSha256])
  })

  it('gives way to a locateFile, which init() passes to createModule as before', async () => {
    const createModule = await packageFactory()
    const received: PqcWasmModuleOptions[] = []
    const recordingFactory: PqcWasmModuleFactory = options => {
      received.push({ ...options })
      return createModule(options)
    }
    const copy = join(dir, 'pqc.wasm')
    writeFileSync(copy, markedWasm())
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')

    await init({ createModule: recordingFactory, locateFile: () => copy })

    expect(received.map(options => options.wasmBinary)).toEqual([undefined])
    expect(instantiate.mock.calls.map(([source]) => hasCopyMarker(source))).toEqual([true])
  })

  it('gives way to a locateFile without createModule', async () => {
    const copy = join(dir, 'pqc.wasm')
    writeFileSync(copy, markedWasm())
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')

    await init({ locateFile: () => copy })

    expect(instantiate.mock.calls.map(([source]) => hasCopyMarker(source))).toEqual([true])
  })

  it("loads the package's pqc.wasm file when a locateFile returns undefined", async () => {
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')

    await init({ locateFile: () => undefined })

    expect(instantiate.mock.calls.map(([source]) => sha256(source))).toEqual([pinnedWasmSha256])
    expect(wasmFilesRead(readFileSyncSpy).map(path => fileURLToPath(path))).toEqual([
      join(wasmDir, 'pqc.wasm'),
    ])
  })

  it('gives way to wasmBinary', async () => {
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')

    await init({ wasmBinary: markedWasm() })

    expect(instantiate.mock.calls.map(([source]) => hasCopyMarker(source))).toEqual([true])
  })
})

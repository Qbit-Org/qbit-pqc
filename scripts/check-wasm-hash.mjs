#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')

function parseArgs(argv) {
  const args = {
    dir: join(packageRoot, 'wasm'),
    write: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--write') args.write = true
    else if (arg === '--dir') args.dir = resolve(argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }

  return args
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const args = parseArgs(process.argv.slice(2))
const artifacts = ['pqc.mjs', 'pqc.wasm']
const lines = artifacts.map((artifact) => `${sha256(join(args.dir, artifact))}  ${artifact}`)
const sumsPath = join(args.dir, 'SHA256SUMS')

if (args.write) {
  writeFileSync(sumsPath, `${lines.join('\n')}\n`)
  console.log(`wrote ${sumsPath}`)
} else {
  const expected = readFileSync(sumsPath, 'utf8').trim().split(/\r?\n/)
  if (expected.length !== lines.length || expected.some((line, index) => line !== lines[index])) {
    console.error(`WASM artifact hash mismatch in ${args.dir}`)
    console.error('expected:')
    console.error(expected.join('\n'))
    console.error('actual:')
    console.error(lines.join('\n'))
    process.exit(1)
  }
  console.log(lines.join('\n'))
}

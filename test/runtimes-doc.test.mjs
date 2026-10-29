import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TOOLCHAINS } from '../scripts/run-bundler-smoke.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const read = path => readFileSync(join(repoRoot, path), 'utf8')

describe('docs/runtimes.md', () => {
  it('names every bundler version the bundler smoke installs', () => {
    const doc = read('docs/runtimes.md').replace(/\s+/g, ' ')
    for (const [toolchain, packages] of Object.entries(TOOLCHAINS)) {
      for (const [name, version] of Object.entries(packages)) {
        const label = name === 'vite' ? version : `${name} ${version}`
        expect(doc, `${toolchain}: ${name}@${version}`).toContain(label)
      }
    }
  })

  it('names the engines range', () => {
    const { engines } = JSON.parse(read('package.json'))
    expect(read('docs/runtimes.md')).toContain(`\`${engines.node}\``)
    expect(read('README.md')).toContain(`\`${engines.node}\``)
  })
})

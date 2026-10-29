import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { checkExampleOutput, listExamples, promisedOutput } from '../scripts/examples.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const examplesDir = join(repoRoot, 'examples')
const readExample = name => readFileSync(join(examplesDir, name), 'utf8')

describe('examples', () => {
  // pnpm smoke:consumer runs them from a project that installed the tarball,
  // so they must import the package the way a reader's code can.
  it('promise their output and import only node: builtins and exported package paths', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const exported = Object.keys(manifest.exports).map(subpath =>
      subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`
    )

    for (const name of listExamples(examplesDir)) {
      const source = readExample(name)
      const specifiers = [...source.matchAll(/^import\s(?:[^'"]*?\sfrom\s)?['"]([^'"]+)['"]/gm)].map(match => match[1])

      expect(promisedOutput(source, name).length).toBeGreaterThan(0)
      expect(specifiers.length, `${name} imports nothing`).toBeGreaterThan(0)
      for (const specifier of specifiers) {
        expect(specifier.startsWith('node:') || exported.includes(specifier), `${name} imports ${specifier}`).toBe(true)
      }
    }
  })

  it('embed a qbit Core derivation vector in wallet-derivation.mjs as the fixture has it', () => {
    const source = readExample('wallet-derivation.mjs')
    const { vectors } = JSON.parse(readFileSync(join(repoRoot, 'fixtures/qbit-core-derivation.json'), 'utf8'))
    const vectorName = /vector (\w+) in/.exec(source)?.[1]
    const vector = vectors.find(candidate => candidate.name === vectorName)

    expect(vector).toBeDefined()
    expect(vector.coreBehavior).toBe('canonical_descriptor_generation')
    expect(/const leafPrivateKey = Buffer\.from\('([0-9a-f]+)', 'hex'\)/.exec(source)?.[1]).toBe(vector.masterSeedHex)
    expect(Number(/const index = (\d+)/.exec(source)?.[1])).toBe(vector.hkdf.index)
    expect(vector.hkdf).toEqual({ account: 0, change: 0, index: vector.path.index })
    expect(/const corePk32 = '([0-9a-f]+)'/.exec(source)?.[1]).toBe(vector.publicKeyHex)
    expect(source).toContain(vector.descriptorPath)
    expect(source).toContain(vector.descriptorTemplate)
  })
})

describe('promisedOutput', () => {
  it('reads the comment after each console.log, in order', () => {
    const source = [
      "import { verify } from '@qbit-oss/pqc'",
      'console.log(verify(pk, msg, sig)) // true',
      "const note = 'console.log is checked'",
      'console.log(verify(pk, msg, bad)) // false',
    ].join('\n')

    expect(promisedOutput(source, 'demo.mjs')).toEqual(['true', 'false'])
  })

  it('rejects a console.log without a comment, and an example that prints nothing', () => {
    expect(() => promisedOutput('console.log(1) // 1\nconsole.log(2)\n', 'demo.mjs')).toThrow(
      'demo.mjs:2: console.log has no comment giving its output'
    )
    expect(() => promisedOutput('await init()\n', 'demo.mjs')).toThrow('demo.mjs: prints nothing')
  })
})

describe('checkExampleOutput', () => {
  it('accepts exactly the promised lines', () => {
    expect(() => checkExampleOutput('demo.mjs', ['true', 'false'], 'true\nfalse\n')).not.toThrow()
  })

  it('names the example and both outputs when they differ', () => {
    for (const stdout of ['true\ntrue\n', 'true\n', 'true\nfalse\nextra\n']) {
      expect(() => checkExampleOutput('demo.mjs', ['true', 'false'], stdout)).toThrow(
        `demo.mjs printed:\n${stdout.trimEnd()}\nbut its comments promise:\ntrue\nfalse`
      )
    }
  })
})

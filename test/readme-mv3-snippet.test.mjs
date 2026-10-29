import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('README MV3 snippet', () => {
  // pnpm typecheck compiles test/types/mv3-wasm-import.mts; this keeps that
  // fixture on the code the README shows.
  it('is the code pnpm typecheck compiles', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
    const fixture = readFileSync(join(repoRoot, 'test/types/mv3-wasm-import.mts'), 'utf8')
    const snippet = /```ts\n(import \{ init \} from '@qbit-oss\/pqc'\nimport createPqcModule [\s\S]*?)```/.exec(
      readme
    )?.[1]

    expect(snippet).toBeDefined()
    for (const block of snippet.trim().split('\n\n')) {
      expect(fixture).toContain(block)
    }
  })
})

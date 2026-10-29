import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Every js, mjs, ts or mts fence in README.md and docs/*.md shows code from a
// file that CI runs or type-checks, named by an HTML comment on the line above
// the fence, which GitHub and npm do not render:
//
//   <!-- snippet: examples/quick-start.mjs -->
//
// pnpm smoke:consumer runs examples/*.mjs against the installed tarball, and
// pnpm typecheck compiles test/types/*.mts. Each block of the fence (the code
// between blank lines) must appear in that file as written.
const SNIPPET_LANGUAGES = new Set(['js', 'mjs', 'ts', 'mts'])
const MARKER = /^<!-- snippet: (\S+) -->$/
const TARGET = /^(?:examples\/[\w-]+\.mjs|test\/types\/[\w-]+\.mts)$/

// Unmarked fences that docs/*.md may keep, by file and first line of code, each
// with the reason no file checks it. A README.md fence always needs a marker.
const UNMARKED_DOC_FENCES = []

function findFences(text) {
  const lines = text.split('\n')
  const fences = []
  for (let start = 0; start < lines.length; start++) {
    const open = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[start])
    if (open === null) {
      continue
    }
    const [, indent, fence, lang] = open
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`)
    let end = start + 1
    while (end < lines.length && !close.test(lines[end])) {
      end++
    }
    fences.push({
      line: start + 1,
      end: end + 1,
      lang,
      code: lines
        .slice(start + 1, end)
        .map(line => line.replace(new RegExp(`^ {0,${indent.length}}`), ''))
        .join('\n'),
      marker: start > 0 ? MARKER.exec(lines[start - 1])?.[1] : undefined,
    })
    start = end
  }
  return fences
}

function checkDoc(file, text, { readTarget, isUnmarkedAllowed }) {
  const problems = []
  const fences = findFences(text)
  const snippets = fences.filter(fence => SNIPPET_LANGUAGES.has(fence.lang))

  text.split('\n').forEach((line, index) => {
    const lineNumber = index + 1
    const insideFence = fences.some(fence => lineNumber >= fence.line && lineNumber <= fence.end)
    if (MARKER.test(line) && !insideFence && !snippets.some(fence => fence.line === lineNumber + 1)) {
      problems.push(`${file}:${lineNumber}: snippet marker is not on the line above a js, mjs, ts or mts fence`)
    }
  })

  for (const fence of snippets) {
    const where = `${file}:${fence.line}: ${fence.lang} fence`
    if (fence.marker === undefined) {
      if (!isUnmarkedAllowed(file, fence)) {
        problems.push(`${where} has no <!-- snippet: <file> --> marker on the line above`)
      }
      continue
    }
    if (!TARGET.test(fence.marker)) {
      problems.push(`${where} names ${fence.marker}, which is not an examples/*.mjs or test/types/*.mts file`)
      continue
    }
    const target = readTarget(fence.marker)
    if (target === undefined) {
      problems.push(`${where} names ${fence.marker}, which does not exist`)
      continue
    }
    for (const block of fence.code.trim().split('\n\n')) {
      if (!target.includes(block)) {
        problems.push(`${where} disagrees with ${fence.marker}, which does not contain this block:\n${block}`)
      }
    }
  }
  return problems
}

function checkDocs(docs, { readTarget, unmarkedDocFences }) {
  const used = new Set()
  const isUnmarkedAllowed = (file, fence) => {
    const firstLine = fence.code.split('\n')[0]
    const entry = unmarkedDocFences.find(candidate => candidate.file === file && candidate.firstLine === firstLine)
    if (entry !== undefined) {
      used.add(entry)
    }
    return file !== 'README.md' && entry !== undefined
  }

  const problems = docs.flatMap(({ file, text }) => checkDoc(file, text, { readTarget, isUnmarkedAllowed }))
  for (const entry of unmarkedDocFences) {
    if (!entry.reason) {
      problems.push(`${entry.file}: the unmarked fence starting "${entry.firstLine}" is allowed without a reason`)
    }
    if (!used.has(entry)) {
      problems.push(`${entry.file}: no unmarked fence starts "${entry.firstLine}"; remove it from UNMARKED_DOC_FENCES`)
    }
  }
  return problems
}

function repositoryDocs() {
  const docs = readdirSync(join(repoRoot, 'docs'))
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => `docs/${name}`)
  return ['README.md', ...docs].map(file => ({ file, text: readFileSync(join(repoRoot, file), 'utf8') }))
}

function readRepositoryFile(path) {
  const absolute = join(repoRoot, path)
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined
}

describe('README and docs code snippets', () => {
  it('are each in the file their marker names', () => {
    expect(
      checkDocs(repositoryDocs(), { readTarget: readRepositoryFile, unmarkedDocFences: UNMARKED_DOC_FENCES })
    ).toEqual([])
  })

  it('include the README quick start, checked against examples/quick-start.mjs', () => {
    const readme = repositoryDocs().find(doc => doc.file === 'README.md').text
    const markers = findFences(readme).map(fence => fence.marker)

    expect(markers).toContain('examples/quick-start.mjs')
  })
})

describe('snippet check', () => {
  const targets = {
    'examples/demo.mjs': "import { init } from '@qbit-oss/pqc'\n\nawait init()\nconsole.log(1) // 1\n",
  }
  const check = (docs, unmarkedDocFences = []) =>
    checkDocs(docs, { readTarget: path => targets[path], unmarkedDocFences })

  it('accepts a marked fence whose blocks are in the named file', () => {
    const text = [
      '<!-- snippet: examples/demo.mjs -->',
      '```js',
      "import { init } from '@qbit-oss/pqc'",
      '',
      'await init()',
      '```',
      '',
      '```sh',
      'npm install @qbit-oss/pqc',
      '```',
    ].join('\n')

    expect(check([{ file: 'README.md', text }])).toEqual([])
  })

  it('names the fence, the file and the block that differ', () => {
    const text = ['<!-- snippet: examples/demo.mjs -->', '```js', 'await init({})', '```'].join('\n')

    expect(check([{ file: 'README.md', text }])).toEqual([
      'README.md:2: js fence disagrees with examples/demo.mjs, which does not contain this block:\nawait init({})',
    ])
  })

  it('needs a marker on every README fence, and on docs fences outside the allowlist', () => {
    const text = ['Text', '', '```ts', 'const a = 1', '```'].join('\n')
    const allowed = [{ file: 'docs/a.md', firstLine: 'const a = 1', reason: 'illustration only' }]

    expect(check([{ file: 'README.md', text }], allowed)).toEqual([
      'README.md:3: ts fence has no <!-- snippet: <file> --> marker on the line above',
      'docs/a.md: no unmarked fence starts "const a = 1"; remove it from UNMARKED_DOC_FENCES',
    ])
    expect(check([{ file: 'docs/a.md', text }], allowed)).toEqual([])
    expect(check([{ file: 'docs/b.md', text }], allowed)).toEqual([
      'docs/b.md:3: ts fence has no <!-- snippet: <file> --> marker on the line above',
      'docs/a.md: no unmarked fence starts "const a = 1"; remove it from UNMARKED_DOC_FENCES',
    ])
    expect(check([{ file: 'docs/a.md', text }], [{ file: 'docs/a.md', firstLine: 'const a = 1' }])).toEqual([
      'docs/a.md: the unmarked fence starting "const a = 1" is allowed without a reason',
    ])
  })

  it('rejects markers that name no checked file or mark no snippet fence', () => {
    const text = [
      '<!-- snippet: src/index.ts -->',
      '```ts',
      'const a = 1',
      '```',
      '<!-- snippet: examples/missing.mjs -->',
      '```js',
      'const b = 2',
      '```',
      '<!-- snippet: examples/demo.mjs -->',
      '```sh',
      'node demo.mjs',
      '```',
      '```md',
      '<!-- snippet: examples/demo.mjs -->',
      '```',
    ].join('\n')

    expect(check([{ file: 'docs/a.md', text }])).toEqual([
      'docs/a.md:9: snippet marker is not on the line above a js, mjs, ts or mts fence',
      'docs/a.md:2: ts fence names src/index.ts, which is not an examples/*.mjs or test/types/*.mts file',
      'docs/a.md:6: js fence names examples/missing.mjs, which does not exist',
    ])
  })
})

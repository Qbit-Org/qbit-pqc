import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Line endings as a checkout with core.autocrlf may write them.
const lf = text => text.replace(/\r\n/g, '\n')
const readText = path => lf(readFileSync(path, 'utf8'))

// Every JavaScript or TypeScript fence in README.md and docs/**/*.md shows code
// from a file that CI runs or type-checks, named by an HTML comment on the line
// above the fence, which GitHub and npm do not render:
//
//   <!-- snippet: examples/quick-start.mjs -->
//
// pnpm smoke:consumer runs examples/*.mjs against the installed tarball, so a
// fence naming one must be that whole file, as a reader copies it. pnpm
// typecheck compiles test/types/*.mts, so a fence naming one may be a
// fragment: each of its blocks (the lines between blank lines) must be a run of
// whole lines of the file. A JavaScript fence names an example and a
// TypeScript fence a type fixture.
const JS_LANGUAGES = new Set(['javascript', 'js', 'mjs', 'cjs', 'jsx'])
const TS_LANGUAGES = new Set(['typescript', 'ts', 'mts', 'cts', 'tsx'])
const MARKER = /^<!-- snippet: (\S+) -->$/
const TARGET = /^(?:examples\/[\w-]+\.mjs|test\/types\/[\w-]+\.mts)$/

// Unmarked fences that docs/**/*.md may keep, by file and first line of code,
// each with the reason no file checks it. A README.md fence always needs a
// marker.
const UNMARKED_DOC_FENCES = []

function snippetKind(lang) {
  if (JS_LANGUAGES.has(lang)) {
    return { name: 'JavaScript', extension: /\.m?js$/, extensions: '.mjs or .js' }
  }
  if (TS_LANGUAGES.has(lang)) {
    return { name: 'TypeScript', extension: /\.m?ts$/, extensions: '.mts or .ts' }
  }
  return undefined
}

// Trailing whitespace does not show in a rendered fence, so it never counts.
const normalisedLines = text =>
  lf(text)
    .trimEnd()
    .split('\n')
    .map(line => line.trimEnd())

function blocksOf(lines) {
  const blocks = [[]]
  for (const line of lines) {
    if (line === '') {
      blocks.push([])
    } else {
      blocks.at(-1).push(line)
    }
  }
  return blocks.filter(block => block.length > 0)
}

const containsRun = (lines, run) =>
  lines.some((_, start) => run.every((line, offset) => lines[start + offset] === line))

function findFences(text) {
  const lines = lf(text).split('\n')
  const fences = []
  for (let start = 0; start < lines.length; start++) {
    const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[start])
    // CommonMark: the info string of a backtick fence cannot contain a
    // backtick, so a line such as ```foo``` text opens no fence.
    if (open === null || (open[2][0] === '`' && open[3].includes('`'))) {
      continue
    }
    const [, indent, fence, info] = open
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`)
    let end = start + 1
    while (end < lines.length && !close.test(lines[end])) {
      end++
    }
    fences.push({
      line: start + 1,
      end: end + 1,
      lang: info.trim().split(/\s+/)[0].toLowerCase(),
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
  const snippets = fences.filter(fence => snippetKind(fence.lang) !== undefined)

  lf(text)
    .split('\n')
    .forEach((line, index) => {
      const lineNumber = index + 1
      const insideFence = fences.some(fence => lineNumber >= fence.line && lineNumber <= fence.end)
      if (MARKER.test(line) && !insideFence && !snippets.some(fence => fence.line === lineNumber + 1)) {
        problems.push(`${file}:${lineNumber}: snippet marker is not on the line above a JavaScript or TypeScript fence`)
      }
    })

  for (const fence of snippets) {
    const where = `${file}:${fence.line}: ${fence.lang} fence`
    const kind = snippetKind(fence.lang)
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
    if (!kind.extension.test(fence.marker)) {
      problems.push(`${where} names ${fence.marker}, but a ${kind.name} fence must name a ${kind.extensions} file`)
      continue
    }
    const target = readTarget(fence.marker)
    if (target === undefined) {
      problems.push(`${where} names ${fence.marker}, which does not exist`)
      continue
    }

    const code = normalisedLines(fence.code)
    const targetLines = normalisedLines(target)
    if (fence.marker.startsWith('examples/')) {
      const differs = Math.max(code.length, targetLines.length)
      const line = Array.from({ length: differs }, (_, index) => index).find(
        index => code[index] !== targetLines[index]
      )
      if (line !== undefined) {
        problems.push(
          `${where} is not the whole of ${fence.marker}; line ${line + 1} differs:\n` +
            `fence: ${code[line] ?? '(end of fence)'}\nfile:  ${targetLines[line] ?? '(end of file)'}`
        )
      }
      continue
    }
    for (const block of blocksOf(code)) {
      if (!containsRun(targetLines, block)) {
        problems.push(
          `${where} disagrees with ${fence.marker}, which has no lines matching this block:\n${block.join('\n')}`
        )
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

// README.md and every Markdown file under docs/, as repository paths.
function listDocs(root) {
  const docs = readdirSync(join(root, 'docs'), { recursive: true })
    .filter(name => name.endsWith('.md') && statSync(join(root, 'docs', name)).isFile())
    .map(name => `docs/${name.split(sep).join('/')}`)
    .sort()
  return ['README.md', ...docs]
}

function repositoryDocs() {
  return listDocs(repoRoot).map(file => ({ file, text: readText(join(repoRoot, file)) }))
}

function readRepositoryFile(path) {
  const absolute = join(repoRoot, path)
  return existsSync(absolute) ? readText(absolute) : undefined
}

describe('README and docs code snippets', () => {
  it('are each in the file their marker names', () => {
    expect(
      checkDocs(repositoryDocs(), { readTarget: readRepositoryFile, unmarkedDocFences: UNMARKED_DOC_FENCES })
    ).toEqual([])
  })

  // The two snippets readers copy most: deleting either fails here, not only
  // the check of what is left.
  it('include the README quick start and Chrome MV3 snippets', () => {
    const readme = repositoryDocs().find(doc => doc.file === 'README.md').text
    const markers = findFences(readme).map(fence => fence.marker)

    expect(markers).toContain('examples/quick-start.mjs')
    expect(markers).toContain('test/types/mv3-wasm-import.mts')
  })

  it('come from every Markdown file under docs/, nested ones included', () => {
    const root = mkdtempSync(join(tmpdir(), 'qbit-pqc-doc-snippets-'))
    try {
      mkdirSync(join(root, 'docs', 'guides', 'node.md'), { recursive: true })
      for (const file of ['README.md', 'docs/a.md', 'docs/guides/b.md', 'docs/guides/notes.txt']) {
        writeFileSync(join(root, file), '# Doc\n')
      }

      expect(listDocs(root)).toEqual(['README.md', 'docs/a.md', 'docs/guides/b.md'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('snippet check', () => {
  const targets = {
    'examples/demo.mjs': "import { init } from '@qbit-oss/pqc'\n\nawait init()\nconsole.log(1) // 1\n",
    'test/types/demo.mts': "import { init } from '@qbit-oss/pqc'\n\nconst pqc = await init()\nvoid pqc\n",
  }
  const check = (docs, unmarkedDocFences = []) =>
    checkDocs(docs, { readTarget: path => targets[path], unmarkedDocFences })
  const fence = (marker, lang, ...code) => [
    ...(marker === undefined ? [] : [`<!-- snippet: ${marker} -->`]),
    `\`\`\`${lang}`,
    ...code,
    '```',
  ]
  const exampleCode = ["import { init } from '@qbit-oss/pqc'", '', 'await init()', 'console.log(1) // 1']

  it('accepts the whole example, and type-fixture blocks that are runs of its lines', () => {
    const text = [
      ...fence('examples/demo.mjs', 'js', ...exampleCode),
      '',
      ...fence(
        'test/types/demo.mts',
        'ts',
        'const pqc = await init()',
        'void pqc',
        '',
        "import { init } from '@qbit-oss/pqc'"
      ),
      '',
      ...fence(undefined, 'sh', 'npm install @qbit-oss/pqc'),
    ].join('\n')

    expect(check([{ file: 'README.md', text }])).toEqual([])
  })

  it('requires a fence naming an example to be the whole file', () => {
    const text = fence('examples/demo.mjs', 'js', "import { init } from '@qbit-oss/pqc'", '', 'await init()').join('\n')

    expect(check([{ file: 'README.md', text }])).toEqual([
      'README.md:2: js fence is not the whole of examples/demo.mjs; line 4 differs:\nfence: (end of fence)\nfile:  console.log(1) // 1',
    ])
  })

  it('matches a type-fixture block only against whole, consecutive lines', () => {
    const text = [
      ...fence('test/types/demo.mts', 'ts', 'await init()'),
      ...fence('test/types/demo.mts', 'ts', "import { init } from '@qbit-oss/pqc'", 'const pqc = await init()'),
    ].join('\n')

    expect(check([{ file: 'README.md', text }])).toEqual([
      'README.md:2: ts fence disagrees with test/types/demo.mts, which has no lines matching this block:\nawait init()',
      "README.md:6: ts fence disagrees with test/types/demo.mts, which has no lines matching this block:\nimport { init } from '@qbit-oss/pqc'\nconst pqc = await init()",
    ])
  })

  it('checks every JavaScript and TypeScript info string, in any case', () => {
    const text = [
      ...fence('examples/demo.mjs', 'JS', ...exampleCode),
      ...fence(undefined, 'JavaScript', 'const a = 1'),
      ...fence(undefined, 'jsx', 'const b = <div />'),
      ...fence(undefined, 'cjs title="demo.cjs"', 'const c = 3'),
      ...fence(undefined, 'TypeScript', 'const d = 4'),
      ...fence(undefined, 'tsx', 'const e = <div />'),
      ...fence(undefined, 'cts', 'const f = 6'),
      ...fence(undefined, 'json', '{}'),
    ].join('\n')

    expect(check([{ file: 'README.md', text }])).toEqual(
      ['8: javascript', '11: jsx', '14: cjs', '17: typescript', '20: tsx', '23: cts'].map(
        where => `README.md:${where} fence has no <!-- snippet: <file> --> marker on the line above`
      )
    )
  })

  it('requires a JavaScript fence to name an example and a TypeScript fence a type fixture', () => {
    const text = [
      ...fence('test/types/demo.mts', 'js', 'const pqc = await init()'),
      ...fence('examples/demo.mjs', 'typescript', ...exampleCode),
    ].join('\n')

    expect(check([{ file: 'README.md', text }])).toEqual([
      'README.md:2: js fence names test/types/demo.mts, but a JavaScript fence must name a .mjs or .js file',
      'README.md:6: typescript fence names examples/demo.mjs, but a TypeScript fence must name a .mts or .ts file',
    ])
  })

  it('reads CRLF line endings as LF and ignores trailing whitespace', () => {
    const text = fence('examples/demo.mjs', 'js', ...exampleCode.map(line => `${line}  `)).join('\r\n')

    expect(check([{ file: 'README.md', text }])).toEqual([])
    expect(
      checkDocs([{ file: 'README.md', text }], {
        readTarget: path => targets[path].replace(/\n/g, '\r\n'),
        unmarkedDocFences: [],
      })
    ).toEqual([])
  })

  it('takes no line with a backtick after its opening backticks for a fence', () => {
    const text = ['```js``` is inline code, not a fence', ...fence('examples/demo.mjs', 'js', ...exampleCode)].join(
      '\n'
    )

    expect(check([{ file: 'README.md', text }])).toEqual([])
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
      ...fence('src/index.ts', 'ts', 'const a = 1'),
      ...fence('examples/missing.mjs', 'js', 'const b = 2'),
      ...fence('examples/demo.mjs', 'sh', 'node demo.mjs'),
      '```md',
      '<!-- snippet: examples/demo.mjs -->',
      '```',
    ].join('\n')

    expect(check([{ file: 'docs/a.md', text }])).toEqual([
      'docs/a.md:9: snippet marker is not on the line above a JavaScript or TypeScript fence',
      'docs/a.md:2: ts fence names src/index.ts, which is not an examples/*.mjs or test/types/*.mts file',
      'docs/a.md:6: js fence names examples/missing.mjs, which does not exist',
    ])
  })
})

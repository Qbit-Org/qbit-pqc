import { readFileSync } from 'node:fs'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { ENTRY_EXPORTS, EXPORTS_0_1_0 } from '../scripts/package-surface.mjs'
import * as external from '../src/external-wasm'
import * as embedded from '../src/index'
import * as worker from '../src/worker'
import * as workerHandler from '../src/worker-handler'

// The source of each entry scripts/package-surface.mjs lists. Its consumer
// smoke checks the built files the same way.
const SOURCES: Record<string, object> = {
  '@qbit-oss/pqc': embedded,
  '@qbit-oss/pqc/external-wasm': external,
  '@qbit-oss/pqc/worker': worker,
  '@qbit-oss/pqc/worker/handler': workerHandler,
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
}

// The names src/core.ts exports, values and types, its own declarations and
// those it re-exports from src/shared.ts, split by whether their JSDoc marks
// them @internal.
function coreExports(): { publicNames: string[]; internalNames: string[] } {
  const publicNames: string[] = []
  const internalNames: string[] = []
  for (const statement of parse('src/core.ts').statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause === undefined || !ts.isNamedExports(clause)) throw new Error('export * in src/core.ts')
      publicNames.push(...clause.elements.map(element => element.name.text))
      continue
    }
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    const names = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map(declaration => declaration.name.getText())
      : [(statement as ts.DeclarationStatement).name!.getText()]
    const internal = ts.getJSDocTags(statement).some(tag => tag.tagName.text === 'internal')
    ;(internal ? internalNames : publicNames).push(...names)
  }
  return { publicNames: publicNames.sort(), internalNames: internalNames.sort() }
}

// The names src/shared.ts exports, split by whether their JSDoc marks them
// @internal.
function sharedExports(): { publicNames: string[]; internalNames: string[] } {
  const publicNames: string[] = []
  const internalNames: string[] = []
  for (const statement of parse('src/shared.ts').statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    const names = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map(declaration => declaration.name.getText())
      : [(statement as ts.DeclarationStatement).name!.getText()]
    const internal = ts.getJSDocTags(statement).some(tag => tag.tagName.text === 'internal')
    ;(internal ? internalNames : publicNames).push(...names)
  }
  return { publicNames: publicNames.sort(), internalNames: internalNames.sort() }
}

// The names src/external-wasm.ts re-exports from src/core.ts.
function reexportedNames(): string[] {
  return parse('src/external-wasm.ts')
    .statements.filter(ts.isExportDeclaration)
    .flatMap(statement =>
      statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map(element => element.name.text)
        : ['<export *>']
    )
    .sort()
}

describe('package entries', () => {
  it('export exactly their public API at run time', () => {
    expect(Object.keys(SOURCES).sort()).toEqual(Object.keys(ENTRY_EXPORTS).sort())
    for (const [entry, module] of Object.entries(SOURCES)) {
      expect(Object.keys(module).sort(), entry).toEqual([...ENTRY_EXPORTS[entry as keyof typeof ENTRY_EXPORTS]].sort())
    }
  })

  it("keep 0.1.0's exports, and document each one added since in the CHANGELOG", () => {
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
    const unreleased = changelog.slice(changelog.indexOf('## 0.1.1'), changelog.indexOf('## 0.1.0'))
    for (const names of Object.values(ENTRY_EXPORTS)) {
      if (names.includes('init')) {
        expect(names).toEqual(expect.arrayContaining([...EXPORTS_0_1_0]))
      }
      // Named in code, alone or called: `name` or `name(...)`.
      for (const name of names.filter(name => !EXPORTS_0_1_0.includes(name))) {
        expect(unreleased, name).toMatch(new RegExp(`\`${name}[\`(]`))
      }
    }
  })

  it('re-export every public declaration of src/core.ts, and none it marks @internal', () => {
    const { publicNames, internalNames } = coreExports()

    expect(internalNames).toEqual(['initWithEmbeddedWasm'])
    expect(reexportedNames()).toEqual(publicNames)
  })

  it('reach the public names of src/shared.ts through src/core.ts, and none it marks @internal', () => {
    const shared = sharedExports()
    const { publicNames } = coreExports()

    expect(shared.internalNames).toEqual([
      'TYPED_ARRAY_INTRINSICS',
      'assertAttached',
      'assertUint8Array',
      'causeReason',
      'isUint8Array',
      'readAllowLargeMessage',
      'withDerivedKeyAliases',
    ])
    expect(publicNames).toEqual(expect.arrayContaining(shared.publicNames))
    expect(publicNames.filter(name => shared.internalNames.includes(name))).toEqual([])
  })
})

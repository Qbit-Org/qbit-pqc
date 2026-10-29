import { readFileSync } from 'node:fs'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import * as core from '../src/core'
import * as external from '../src/external-wasm'
import * as pqc from '../src/index'
import * as shared from '../src/shared'
import * as worker from '../src/worker'
import * as workerHandler from '../src/worker-handler'

// The doc comments of each entry's source are the API reference editors show
// on hover and its lib/*.d.mts carries to consumers; esbuild drops them from
// lib/*.mjs. A `//` comment reaches neither, so only JSDoc counts. A
// re-export from another entry listed here is documented in that entry.
const ENTRIES: Record<string, object> = {
  'core.ts': core,
  'shared.ts': shared,
  'external-wasm.ts': external,
  'index.ts': pqc,
  'worker.ts': worker,
  'worker-handler.ts': workerHandler,
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
}

// The entry an export declaration re-exports from, such as 'index.ts' for
// `export * from './external-wasm'`, when it is one of ENTRIES.
function reexportedEntry(statement: ts.ExportDeclaration): string | undefined {
  const specifier = statement.moduleSpecifier
  if (specifier === undefined || !ts.isStringLiteral(specifier)) return undefined
  const file = `${specifier.text.replace(/^\.\//, '')}.ts`
  return specifier.text.startsWith('./') && file in ENTRIES ? file : undefined
}

function hasDoc(node: ts.Node): boolean {
  return ts
    .getJSDocCommentsAndTags(node)
    .some(doc => ts.isJSDoc(doc) && (ts.getTextOfJSDocComment(doc.comment)?.trim() ?? '') !== '')
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)
}

// Constructors are not checked: the docs describe the exported classes only as
// errors the package throws, and esbuild would copy a constructor's JSDoc into
// lib/index.mjs, which carries none of the other doc comments.
function isPublicMember(member: ts.ClassElement): boolean {
  if (ts.isConstructorDeclaration(member)) return false
  if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) return false
  return !(ts.getModifiers(member) ?? []).some(
    m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
  )
}

function memberName(source: ts.SourceFile, owner: string, member: ts.ClassElement | ts.TypeElement): string {
  return `${owner}.${member.name === undefined ? `<${ts.SyntaxKind[member.kind]}>` : member.name.getText(source)}`
}

// Every exported declaration of `file`, every member of an exported interface
// and every public member of an exported class but its constructor, with
// whether it has a JSDoc comment with text. A re-export from another entry
// brings the names it exports, documented there. An export form this does not
// read is reported as undocumented.
function exportedItems(file: string): { name: string; documented: boolean }[] {
  const source = parse(file)
  const items: { name: string; documented: boolean }[] = []
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && reexportedEntry(statement) !== undefined) {
      const clause = statement.exportClause
      const names =
        clause === undefined
          ? exportedItems(reexportedEntry(statement)!).map(item => item.name)
          : ts.isNamedExports(clause)
            ? clause.elements.map(element => element.name.text)
            : [clause.name.text]
      items.push(...names.map(name => ({ name, documented: true })))
      continue
    }
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      items.push({ name: `<${ts.SyntaxKind[statement.kind]}>`, documented: false })
      continue
    }
    if (!isExported(statement)) continue
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        items.push({ name: declaration.name.getText(source), documented: hasDoc(declaration) })
      }
      continue
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      const name = statement.name?.text ?? '<default>'
      items.push({ name, documented: hasDoc(statement) })
      if (ts.isInterfaceDeclaration(statement)) {
        for (const member of statement.members) {
          items.push({ name: memberName(source, name, member), documented: hasDoc(member) })
        }
      }
      if (ts.isClassDeclaration(statement)) {
        for (const member of statement.members) {
          if (isPublicMember(member)) {
            items.push({ name: memberName(source, name, member), documented: hasDoc(member) })
          }
        }
      }
      continue
    }
    items.push({ name: `<${ts.SyntaxKind[statement.kind]}>`, documented: false })
  }
  return items
}

describe.each(Object.entries(ENTRIES))('src/%s doc comments', (file, module) => {
  const items = exportedItems(file)

  it('finds every runtime export', () => {
    const names = items.map(item => item.name)
    expect(Object.keys(module).filter(name => !names.includes(name))).toEqual([])
  })

  it('documents every export and every member of an exported interface or class', () => {
    const undocumented = items.filter(item => !item.documented).map(item => item.name)
    expect(undocumented, 'exports and members without a JSDoc comment').toEqual([])
  })
})

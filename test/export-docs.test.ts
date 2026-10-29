import { readFileSync } from 'node:fs'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import * as pqc from '../src/index'

// The doc comments of src/index.ts are the API reference editors show on hover
// and lib/index.d.mts carries to consumers; esbuild drops them from
// lib/index.mjs. A `//` comment reaches neither, so only JSDoc counts.
const source = ts.createSourceFile(
  'index.ts',
  readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)

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

function memberName(owner: string, member: ts.ClassElement | ts.TypeElement): string {
  return `${owner}.${member.name === undefined ? `<${ts.SyntaxKind[member.kind]}>` : member.name.getText(source)}`
}

// Every exported declaration, every member of an exported interface and every
// public member of an exported class but its constructor, with whether it has
// a JSDoc comment with text. An export form this does not read is reported as
// undocumented.
function exportedItems(): { name: string; documented: boolean }[] {
  const items: { name: string; documented: boolean }[] = []
  for (const statement of source.statements) {
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
          items.push({ name: memberName(name, member), documented: hasDoc(member) })
        }
      }
      if (ts.isClassDeclaration(statement)) {
        for (const member of statement.members) {
          if (isPublicMember(member)) {
            items.push({ name: memberName(name, member), documented: hasDoc(member) })
          }
        }
      }
      continue
    }
    items.push({ name: `<${ts.SyntaxKind[statement.kind]}>`, documented: false })
  }
  return items
}

describe('src/index.ts doc comments', () => {
  const items = exportedItems()

  it('finds every runtime export', () => {
    const names = items.map(item => item.name)
    expect(Object.keys(pqc).filter(name => !names.includes(name))).toEqual([])
  })

  it('documents every export and every member of an exported interface or class', () => {
    const undocumented = items.filter(item => !item.documented).map(item => item.name)
    expect(undocumented, 'exports and members without a JSDoc comment').toEqual([])
  })
})

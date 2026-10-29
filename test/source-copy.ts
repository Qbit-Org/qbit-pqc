import { readFileSync } from 'node:fs'

import ts from 'typescript'

// A copy of the implementation that a test evaluates again, apart from the
// module graph the other tests import: src/core.ts and a fresh copy of the
// src/shared.ts it imports, each transpiled and imported from a data: URL.
// `edit` changes the source of src/core.ts first; `tag` keeps this copy's
// URLs apart from every other copy's, so the import evaluates both afresh.
// The copy of src/shared.ts captures its intrinsics when the import runs.
export async function importSourceCopy<T>(
  tag: string,
  edit: (source: string) => string = source => source
): Promise<T> {
  const shared = dataUrl(transpile(`${read('src/shared.ts')}\n// copy ${tag}\n`))
  const core = transpile(`${edit(read('src/core.ts'))}\n// copy ${tag}\n`).replace(
    /(\bfrom\s*)(["'])\.\/shared\2/g,
    `$1'${shared}'`
  )
  return (await import(/* @vite-ignore */ dataUrl(core))) as T
}

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function transpile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText
}

function dataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

import { readdirSync } from 'node:fs'

// Line endings as a checkout with core.autocrlf may write them.
const lf = text => text.replace(/\r\n/g, '\n')

// The examples in examples/, which scripts/run-consumer-smoke.mjs runs against
// the installed tarball. An empty list fails, so a moved directory cannot pass.
export function listExamples(dir) {
  const examples = readdirSync(dir)
    .filter(name => name.endsWith('.mjs'))
    .sort()
  if (examples.length === 0) {
    throw new Error(`no examples in ${dir}`)
  }
  return examples
}

// What an example promises to print, one entry per line: every console.log
// call ends its line with a comment giving the output, as the README quick
// start does, so the smoke checks what a reader is told to expect.
export function promisedOutput(source, file) {
  const promised = []
  lf(source)
    .split('\n')
    .forEach((line, index) => {
      // A commented-out call prints nothing.
      if (!line.includes('console.log(') || /^\s*(?:\/\/|\/\*|\*)/.test(line)) {
        return
      }
      const comment = /\);?\s*\/\/\s*(\S.*)$/.exec(line)
      if (comment === null) {
        throw new Error(`${file}:${index + 1}: console.log has no comment giving its output`)
      }
      promised.push(comment[1].trimEnd())
    })
  if (promised.length === 0) {
    throw new Error(`${file}: prints nothing, so its run cannot be checked`)
  }
  return promised
}

export function checkExampleOutput(file, promised, stdout) {
  const printed = lf(stdout).replace(/\n$/, '').split('\n')
  if (printed.length !== promised.length || printed.some((line, index) => line !== promised[index])) {
    throw new Error(`${file} printed:\n${printed.join('\n')}\nbut its comments promise:\n${promised.join('\n')}`)
  }
}

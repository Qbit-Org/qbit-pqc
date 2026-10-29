import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const workflow = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
const ci = workflow('ci.yml')
const publish = workflow('publish.yml')

// The owner/name that npm provenance ties every version to.
const { repository } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const REPOSITORY = /^git\+https:\/\/github\.com\/([^/]+\/[^/]+?)\.git$/.exec(repository.url)?.[1]

const USES = /^ *(?:- )?uses: (\S+)(.*)$/gm

function actionRefs(text) {
  return [...text.matchAll(USES)].map(([, ref, comment]) => ({ ref, comment: comment.trim() }))
}

// Each job's text by job ID, from its `  <id>:` header to the next one. A
// comment between two jobs stays with the first, so the tests read keys,
// actions and run commands rather than searching a job's comments.
function jobs(text) {
  const lines = text.split('\n')
  const start = lines.indexOf('jobs:')
  expect(start, 'jobs:').toBeGreaterThan(-1)
  const found = {}
  let id
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const header = /^ {2}([\w-]+):$/.exec(line)
    if (header !== null) {
      id = header[1]
      found[id] = []
    } else if (id !== undefined) {
      found[id].push(line)
    }
  }
  return Object.fromEntries(Object.entries(found).map(([key, body]) => [key, body.join('\n')]))
}

// The entries of the `permissions:` mapping at `indent`, or undefined if
// there is none.
function permissions(text, indent) {
  const lines = text.split('\n')
  const start = lines.indexOf(`${indent}permissions:`)
  if (start === -1) return undefined
  const entries = {}
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith(`${indent}  #`)) continue
    const entry = /^( *)([\w-]+): (\S+)$/.exec(line)
    if (entry === null || entry[1] !== `${indent}  `) break
    entries[entry[2]] = entry[3]
  }
  return entries
}

// The script of every `run:` step: the value of `run: <command>`, or the
// lines of a `run: |` block without their indentation.
function runCommands(text) {
  const lines = text.split('\n')
  return lines.flatMap((line, index) => {
    const run = /^( *)(?:- )?run: (.+)$/.exec(line)
    if (run === null) return []
    if (run[2] !== '|') return [run[2]]
    const block = []
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && next.search(/\S/) <= run[1].length) break
      block.push(next)
    }
    const indent = Math.min(...block.filter(next => next.trim() !== '').map(next => next.search(/\S/)))
    return [
      block
        .map(next => next.slice(indent))
        .join('\n')
        .trimEnd(),
    ]
  })
}

describe('publish workflow', () => {
  it('runs build, smoke and publish in bash, only for pushed v* tags', () => {
    expect(Object.keys(jobs(publish))).toEqual(['build', 'smoke', 'publish'])
    expect(publish).toContain("\non:\n  push:\n    tags:\n      - 'v*'\n\n")
    // bash -eo pipefail everywhere: no job or step picks another shell.
    expect(publish).toContain('\ndefaults:\n  run:\n    shell: bash\n')
    expect(publish.match(/^ *shell:.*$/gm)).toEqual(['    shell: bash'])
  })

  it('grants only contents: read at the top level', () => {
    expect(permissions(publish, '')).toEqual({ contents: 'read' })
  })

  it('gives only publish id-token: write, an environment and secrets', () => {
    const { build, smoke, publish: publishJob } = jobs(publish)
    expect(permissions(build, '    ')).toEqual({ contents: 'read' })
    expect(permissions(smoke, '    ')).toEqual({ contents: 'read' })
    expect(permissions(publishJob, '    ')).toEqual({ contents: 'read', 'id-token': 'write' })

    expect(publish.match(/^ *environment:.*$/gm)).toEqual(['    environment: npm'])
    expect(publishJob).toContain('\n    environment: npm\n')
    expect(publish.replace(publishJob, '')).not.toMatch(/\bsecrets\./)
  })

  it('publishes only after build and smoke pass', () => {
    const { smoke, publish: publishJob } = jobs(publish)
    expect(smoke).toMatch(/^ {4}needs: build$/m)
    expect(publishJob).toMatch(/^ {4}needs: \[build, smoke\]$/m)
  })

  it('runs every job only in the repository package.json names', () => {
    expect(REPOSITORY).toBe('Qbit-Org/qbit-pqc')
    for (const [id, text] of Object.entries(jobs(publish))) {
      expect(text.split('\n'), id).toContain(`    if: github.repository == '${REPOSITORY}'`)
    }
  })

  it('restores no cache', () => {
    expect(publish).not.toMatch(/^ *cache[\w-]*:/m)
    expect(actionRefs(publish).filter(({ ref }) => /^actions\/cache[/@]/.test(ref))).toEqual([])
  })

  it('publishes the downloaded tarball without checking out or running repository code', () => {
    const job = jobs(publish).publish
    expect(actionRefs(job).map(({ ref }) => ref.split('@')[0])).not.toContain('actions/checkout')
    expect(job).toMatch(/^ +artifact-ids: \$\{\{ needs\.build\.outputs\.artifact_id \}\}$/m)

    const commands = runCommands(job).join('\n')
    expect(commands).not.toMatch(/\bpnpm\b/)
    expect(commands).not.toMatch(/\bnode scripts\//)
    const publishes = commands.split('\n').filter(line => /^\s*npm publish\b/.test(line))
    expect(publishes).toHaveLength(1)
    expect(publishes[0]).toMatch(/^\s*npm publish "\$tarball" /)
    expect(publishes[0]).toMatch(/ --provenance(?= |$)/)
    expect(publishes[0]).toMatch(/ --ignore-scripts(?= |$)/)
  })

  it("runs every command of CI's verify job in build or smoke", () => {
    const { build, smoke } = jobs(publish)
    const commands = [...runCommands(build), ...runCommands(smoke)]
    const verify = runCommands(jobs(ci).verify)
    expect(verify).toContain('pnpm smoke:consumer')
    // Formatting is not a tarball integrity gate, so publish.yml need not
    // rerun CI's format check.
    expect(verify).toContain('pnpm format:check')
    const gates = verify.filter(command => command !== 'pnpm format:check')
    // Verbatim, or with options added, as build's install adds engine-strict.
    expect(gates.filter(command => !commands.some(run => run === command || run.startsWith(`${command} --`)))).toEqual(
      []
    )
  })

  it('pins every action to a full commit SHA, and an action CI uses to its CI pin', () => {
    expect(actionRefs(publish).length).toBeGreaterThan(0)
    for (const { ref, comment } of [...actionRefs(ci), ...actionRefs(publish)]) {
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
      expect(comment).toMatch(/^# v\d+\.\d+\.\d+$/)
    }

    const pinnedInCi = new Map()
    for (const { ref, comment } of actionRefs(ci)) {
      const action = ref.split('@')[0]
      pinnedInCi.set(action, [...(pinnedInCi.get(action) ?? []), `${ref} ${comment}`])
    }
    for (const { ref, comment } of actionRefs(publish)) {
      const pins = pinnedInCi.get(ref.split('@')[0])
      if (pins !== undefined) expect(pins).toContain(`${ref} ${comment}`)
    }
  })
})

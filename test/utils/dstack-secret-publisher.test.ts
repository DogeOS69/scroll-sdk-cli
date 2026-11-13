import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {describeApplyConflicts, parseApplyConflicts, runSecretKubectl} from '../../src/utils/dstack-secret-publisher.js'

const RESOLUTION_HINT = `Please review the fields above--they currently have other managers. Here
are the ways you can resolve this warning:
* If you intend to manage all of these fields, please re-run the apply
  command with the \`--force-conflicts\` flag.
`

async function failure(): Promise<string> {
  try {
    await runSecretKubectl(['apply', '--server-side'], 'fake-payload')
  } catch (error) {
    return (error as Error).message
  }

  throw new Error('expected kubectl to fail')
}

describe('server-side apply conflict reporting', () => {
  it('reports the manager and field path of a single conflict', () => {
    const conflicts = parseApplyConflicts(`error: Apply failed with 1 conflict: conflict with "kubectl-patch" using v1: .data.config.yml\n${RESOLUTION_HINT}`)
    expect(conflicts).to.deep.equal([{fields: ['.data.config.yml'], manager: '"kubectl-patch" using v1'}])
    expect(describeApplyConflicts(conflicts!)).to.equal('"kubectl-patch" using v1 owns .data.config.yml')
  })

  it('reports grouped conflicts from several managers and objects', () => {
    const conflicts = parseApplyConflicts([
      'Error from server (Conflict): error when serverside-applying "STDIN": Apply failed with 3 conflicts: conflicts with "kubectl-edit" using v1 at 2020-01-01T00:00:00Z:',
      '- .data.config.yml',
      '- .metadata.labels.owner',
      'conflicts with "operator":',
      '- .data.admin-token',
      'Error from server (Conflict): error when serverside-applying "STDIN": Apply failed with 1 conflict: conflict with "helm" with subresource "status" using v1: .data.token',
      RESOLUTION_HINT,
    ].join('\n'))
    expect(conflicts).to.deep.equal([
      {fields: ['.data.config.yml', '.metadata.labels.owner'], manager: '"kubectl-edit" using v1 at 2020-01-01T00:00:00Z'},
      {fields: ['.data.admin-token'], manager: '"operator"'},
      {fields: ['.data.token'], manager: '"helm" with subresource "status" using v1'},
    ])
  })

  it('suppresses output that is not an exact apply conflict', () => {
    for (const output of [
      '',
      'error: secrets "dstack-controller-config" is forbidden: User cannot patch resource',
      // A value-bearing set selector is never reflected.
      'error: Apply failed with 1 conflict: conflict with "kubectl": .metadata.finalizers[="fake-secret-value"]',
      // Count mismatch means unexpected formatting; keep everything suppressed.
      'error: Apply failed with 2 conflicts: conflicts with "kubectl":\n- .data.config.yml\nfake-secret-value',
      'error: Apply failed with 1 conflict: conflict with "kubectl": .data.config.yml fake-secret-value',
      'error: Apply failed with 1 conflict: conflict with "fake\nsecret": .data.config.yml',
    ]) expect(parseApplyConflicts(output), output).to.equal(undefined)
  })

  describe('kubectl runner', () => {
    let directory: string
    let previousPath: string | undefined
    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-conflict-'))
      previousPath = process.env.PATH
      process.env.PATH = `${directory}:${previousPath}`
    })
    afterEach(() => {
      process.env.PATH = previousPath
      fs.rmSync(directory, {force: true, recursive: true})
    })

    const stub = (stderr: string) => fs.writeFileSync(path.join(directory, 'kubectl'), `#!/bin/sh\ncat >/dev/null\ncat >&2 <<'EOF'\n${stderr}\nEOF\nexit 1\n`, {mode: 0o700})

    it('names conflicting managers and fields without echoing other output', async () => {
      stub(`warning: echoed FAKE-SECRET-VALUE\nerror: Apply failed with 1 conflict: conflict with "kubectl-patch" using v1: .data.config.yml\n${RESOLUTION_HINT}`)
      const message = await failure()
      expect(message).to.include('field ownership: "kubectl-patch" using v1 owns .data.config.yml')
      expect(message).to.include('Do not force the apply')
      expect(message).not.to.include('FAKE-SECRET-VALUE')
      expect(message).not.to.include('--force-conflicts')
    })

    it('keeps the full response suppressed for other failures', async () => {
      stub('error: FAKE-SECRET-VALUE')
      const message = await failure()
      expect(message).to.include('response suppressed')
      expect(message).not.to.include('FAKE-SECRET-VALUE')
    })
  })
})

import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('CubeSigner credential upload scope', () => {
  it('excludes stale signer files from the real CLI upload plan when deferred', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cubesigner-defer-cli-'))
    try {
      fs.mkdirSync(path.join(root, 'secrets'))
      for (const name of ['cubesigner-signer-session.json', 'cubesigner-signer.env', 'unrelated.env']) fs.writeFileSync(path.join(root, 'secrets', name), 'NONFUNCTIONAL_TEST_INPUT')
      const result = spawnSync(process.execPath, [path.resolve('bin/run.js'), 'setup', 'push-secrets', '--provider', 'aws', '--exclude-cubesigner', '--dry-run', '-N', '--json'], {cwd: root, encoding: 'utf8'})
      expect(result.status, result.stderr).equal(0)
      expect(JSON.parse(result.stdout).data.legacyFiles.map((file: string) => path.basename(file))).deep.equal(['unrelated.env'])
      expect(result.stdout).not.include('NONFUNCTIONAL_TEST_INPUT')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
})

describe('CubeSigner policy preparation input validation', () => {
  it('reports an unsupported alias before reading deployment artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cubesigner-policy-name-cli-'))
    try {
      const result = spawnSync(process.execPath, [path.resolve('bin/run.js'), 'setup', 'cubesigner-policy', 'prepare-input',
        '--dir', root, '--environment', 'gamma', '--organization', 'fixture_org',
        '--policy', 'regtest-policy/v1', '--program-identity-digest', `sha256:${'a'.repeat(64)}`,
        '--verifier-identity-digest', `sha256:${'b'.repeat(64)}`, '--resolver-base-url', 'https://proof.example.com',
        '--tests', 'nonexistent-tests.json', '--no-requires-live-evidence', '--json'], {encoding: 'utf8'})
      expect(result.status, result.stderr).equal(1)
      const response = JSON.parse(result.stdout)
      expect(response.error.code).equal('E747_POLICY_INPUT_INVALID')
      expect(response.error.message).include('3-30 ASCII letters, digits or underscores')
      expect(fs.readdirSync(root)).empty
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
})

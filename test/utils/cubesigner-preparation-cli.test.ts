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

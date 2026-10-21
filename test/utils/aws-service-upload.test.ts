import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Exercise the actual command with a fake executable, including --debug.
describe('prepared AWS Secret upload', () => {
  it('keeps the reader, redacts values, and rejects another account before writing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-upload-'))
    try {
      for (const name of ['.data', 'values', 'secrets', 'bin']) fs.mkdirSync(path.join(root, name))
      const secretName = 'fee-oracle-secret-env'; const prefix = 'fixture'; const region = 'us-east-1'
      const account = '000000000000'; const serviceAccount = 'aws-reader-fee-oracle'
      fs.writeFileSync(path.join(root, '.data/aws-service-access.json'), JSON.stringify({account, prefix, readers: {'fee-oracle': {roleArn: `arn:aws:iam::${account}:role/fixture-fee-reader`, secrets: [`${prefix}/${secretName}`], serviceAccount}}, region, runtime: {}}))
      fs.writeFileSync(path.join(root, 'secrets/fee-oracle-secret.env'), 'FIXTURE=NONFUNCTIONAL_VALUE_MUST_NOT_BE_LOGGED\n')
      fs.writeFileSync(path.join(root, 'values/fee-oracle-production.yaml'), yaml.dump({externalSecrets: {[secretName]: {data: [{remoteRef: {key: `${prefix}/${secretName}`, property: 'FIXTURE'}, secretKey: 'FIXTURE'}], provider: 'aws', secretRegion: region, serviceAccount}}}))
      const fakeAws = path.join(root, 'bin/aws')
      fs.writeFileSync(fakeAws, `#!/usr/bin/env node
const fs = require('node:fs');
const operation = process.argv.slice(2, 4).join(' ');
fs.appendFileSync(process.env.FIXTURE_AWS_LOG, operation + '\\n');
if (operation === 'sts get-caller-identity') console.log(JSON.stringify({Account: process.env.FIXTURE_AWS_ACCOUNT}));
else console.log('{}');
`, {mode: 0o700})
      const log = path.join(root, 'aws-operations.log')
      const run = (identity: string) => spawnSync(process.execPath, [path.resolve('bin/run.js'), 'setup', 'push-secrets', '-N', '--provider', 'aws', '--aws-prefix', prefix, '--aws-region', region, '--debug'], {cwd: root, encoding: 'utf8', env: {...process.env, FIXTURE_AWS_ACCOUNT: identity, FIXTURE_AWS_LOG: log, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`}})
      const result = run(account)
      expect(result.status, result.stderr).equal(0)
      expect(result.stdout + result.stderr).not.include('NONFUNCTIONAL_VALUE_MUST_NOT_BE_LOGGED')
      const values = yaml.load(fs.readFileSync(path.join(root, 'values/fee-oracle-production.yaml'), 'utf8')) as {externalSecrets: Record<string, {serviceAccount: string}>}
      expect(values.externalSecrets[secretName].serviceAccount).equal(serviceAccount)
      expect(fs.readFileSync(log, 'utf8')).include('secretsmanager put-secret-value')
      fs.writeFileSync(log, '')
      const wrong = run('111111111111')
      expect(wrong.status).not.equal(0)
      expect(wrong.stdout + wrong.stderr).include('different account').not.include('NONFUNCTIONAL_VALUE_MUST_NOT_BE_LOGGED')
      expect(fs.readFileSync(log, 'utf8').trim()).equal('sts get-caller-identity')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
})

import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Exercise the actual command with a fake aws executable, including --debug.
describe('setup push-secrets AWS CLI invocation', () => {
  for (const exists of [false, true]) it(`${exists ? 'updates' : 'creates'} a Secret without a shell or logging its value`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-secrets-aws-'))
    try {
      for (const name of ['bin', 'secrets', 'values']) fs.mkdirSync(path.join(root, name))
      const secretName = 'fee-oracle-secret-env'; const prefix = 'fixture'; const region = 'us-east-1'
      // Shell metacharacters must reach the aws CLI verbatim and never execute.
      const value = `NONFUNCTIONAL_VALUE_MUST_NOT_BE_LOGGED'"$(touch ${path.join(root, 'pwned')})`
      fs.writeFileSync(path.join(root, 'secrets/fee-oracle-secret.env'), `FIXTURE=${value}\n`)
      fs.writeFileSync(path.join(root, 'values/fee-oracle-production.yaml'), yaml.dump({externalSecrets: {[secretName]: {data: [{remoteRef: {key: `${prefix}/${secretName}`, property: 'FIXTURE'}, secretKey: 'FIXTURE'}], provider: 'aws', secretRegion: region, serviceAccount: 'external-secrets'}}}))
      const log = path.join(root, 'aws-calls.jsonl')
      fs.writeFileSync(path.join(root, 'bin/aws'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_AWS_LOG, JSON.stringify(args) + '\\n');
if (args.slice(0, 2).join(' ') === 'secretsmanager describe-secret' && process.env.FIXTURE_SECRET_EXISTS !== 'true') {
  console.error('An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation');
  process.exit(254);
}
console.log('{}');
`, {mode: 0o700})

      const result = spawnSync(process.execPath, [path.resolve('bin/run.js'), 'setup', 'push-secrets', '-N', '--provider', 'aws', '--aws-prefix', prefix, '--aws-region', region, '--debug'], {cwd: root, encoding: 'utf8', env: {...process.env, FIXTURE_AWS_LOG: log, FIXTURE_SECRET_EXISTS: String(exists), PATH: `${path.join(root, 'bin')}:${process.env.PATH}`}})
      expect(result.status, result.stderr).equal(0)
      expect(result.stdout + result.stderr).not.include('NONFUNCTIONAL_VALUE_MUST_NOT_BE_LOGGED')
      expect(fs.existsSync(path.join(root, 'pwned'))).equal(false)
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
      const write = calls.find(args => args[0] === 'secretsmanager' && args[1] !== 'describe-secret')!
      expect(write.slice(0, 2)).deep.equal(['secretsmanager', exists ? 'put-secret-value' : 'create-secret'])
      expect(write[write.indexOf(exists ? '--secret-id' : '--name') + 1]).equal(`${prefix}/${secretName}`)
      expect(JSON.parse(write[write.indexOf('--secret-string') + 1])).deep.equal({FIXTURE: value})
      expect(write[write.indexOf('--region') + 1]).equal(region)
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('reports AWS failures without the Secret value or provider output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-secrets-aws-'))
    try {
      for (const name of ['bin', 'secrets', 'values']) fs.mkdirSync(path.join(root, name))
      fs.writeFileSync(path.join(root, 'secrets/fee-oracle-secret.env'), 'FIXTURE=NONFUNCTIONAL_VALUE_MUST_NOT_BE_LOGGED\n')
      fs.writeFileSync(path.join(root, 'values/fee-oracle-production.yaml'), yaml.dump({externalSecrets: {'fee-oracle-secret-env': {data: [{remoteRef: {key: 'fixture/fee-oracle-secret-env', property: 'FIXTURE'}, secretKey: 'FIXTURE'}], provider: 'aws', secretRegion: 'us-east-1', serviceAccount: 'external-secrets'}}}))
      fs.writeFileSync(path.join(root, 'bin/aws'), `#!/usr/bin/env node
if (process.argv[3] === 'describe-secret') {console.log('{}'); process.exit(0)}
console.error('PROVIDER_DETAIL_MUST_NOT_BE_LOGGED ' + process.argv.join(' '));
process.exit(254);
`, {mode: 0o700})
      const result = spawnSync(process.execPath, [path.resolve('bin/run.js'), 'setup', 'push-secrets', '-N', '--provider', 'aws', '--aws-prefix', 'fixture', '--aws-region', 'us-east-1', '--debug'], {cwd: root, encoding: 'utf8', env: {...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`}})
      expect(result.status).not.equal(0)
      expect(result.stdout + result.stderr).include('contents omitted').not.include('NONFUNCTIONAL_VALUE_MUST_NOT_BE_LOGGED').not.include('PROVIDER_DETAIL_MUST_NOT_BE_LOGGED')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
})

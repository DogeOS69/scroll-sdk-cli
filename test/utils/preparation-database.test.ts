import * as toml from '@iarna/toml'
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {PreparationPlan} from '../../src/utils/preparation-plan.js'

import {CommandPreparationRunner} from '../../src/utils/preparation-runner.js'

describe('preparation database administrator inputs', () => {
  let root: string
  const env = 'SCROLLSDK_TEST_DATABASE_PASSWORD'
  let previous: string | undefined
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-db-')); previous = process.env[env]})
  afterEach(() => {fs.rmSync(root, {force: true, recursive: true}); if (previous === undefined) delete process.env[env]; else process.env[env] = previous})

  for (const fail of [false, true]) {
    it(`supplies current credentials without persisting the administrator password when the child ${fail ? 'fails' : 'succeeds'}`, async () => {
      const spec = {database: {admin: {database: 'postgres', host: 'db.example.invalid', password: `$ENV:${env}`, port: 5432, username: 'operator', vpcHost: 'db.internal.example.invalid', vpcPort: 5433}}, preparation: {bridge: {mode: 'helper'}}} as DeploymentSpec
      process.env[env] = 'fake-new-database-password'
      const file = path.join(root, 'config.toml')
      fs.writeFileSync(file, '[db]\n')
      let calls = 0
      const runner = new CommandPreparationRunner(async (_root, _step, args, environment) => {
        calls++
        expect(args).to.deep.equal(['db-init', '-N', '--databases', 'blockscout'])
        expect(environment?.SCROLLSDK_DB_ADMIN_PASSWORD).to.equal('fake-new-database-password')
        const text = fs.readFileSync(file, 'utf8')
        expect(text).not.to.include('fake-new-database-password')
        const config = toml.parse(text) as any
        expect(config.db.admin).to.include({PASSWORD: '$ENV:SCROLLSDK_DB_ADMIN_PASSWORD', PUBLIC_HOST: 'db.example.invalid', VPC_PORT: '5433'})
        config.db.BLOCKSCOUT_DB_CONNECTION_STRING = 'postgres://app:fake@db.invalid/app'
        fs.writeFileSync(file, toml.stringify(config))
        if (fail) throw new Error('simulated database failure')
      })
      let failure: unknown
      try {await runner.run({effect: 'cloud', id: 'blockscout-db', retry: 'safe', title: 'database'}, spec, root, {} as PreparationPlan)} catch (error) {failure = error}
      expect(calls).to.equal(1)
      expect(Boolean(failure)).to.equal(fail)
      const result = toml.parse(fs.readFileSync(file, 'utf8')) as any
      expect(result.db.admin).to.equal(undefined)
      expect(result.db.BLOCKSCOUT_DB_CONNECTION_STRING).to.equal('postgres://app:fake@db.invalid/app')
    })
  }
})

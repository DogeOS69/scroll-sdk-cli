import {expect} from 'chai'
import {randomBytes} from 'node:crypto'

import SetupGenSecrets from '../../../src/commands/setup/gen-secrets.js'

describe('preinstalls deployer handoff', () => {
  it('exports the configured deployer as PRIV_KEY without creating another identity', () => {
    const command = Object.assign(Object.create(SetupGenSecrets.prototype), {dogeConfig: {}})
    const key = randomBytes(32).toString('hex')
    const files = command.generateEnvContent('preinstalls', {accounts: {DEPLOYER_PRIVATE_KEY: key}})
    expect(files).to.deep.equal({'preinstalls-secret.env': `PRIV_KEY="${key}"\n`})
  })
})

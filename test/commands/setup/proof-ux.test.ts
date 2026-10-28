import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import path from 'node:path'

import {PROOF_AWS_INIT_NEXT_STEPS} from '../../../src/commands/setup/proof-aws-init.js'
import {requirePreparationStep} from '../../../src/utils/preparation-internal-command.js'

describe('staged preparation command guidance', () => {
  it('removes retired setup commands from help and command discovery', () => {
    const cli = path.resolve('bin/run.js')
    const help = spawnSync(process.execPath, [cli, 'setup', '--help'], {encoding: 'utf8'})
    expect(help.status).equal(0)
    for (const name of ['bootnode-public-p2p', 'proof-config-check', 'artifact-access', 'proof-config', 'proof-worker', 'proof-workers', 'proof-worker-check', 'cubesigner-refresh', 'dogecoin-wallet-import', 'gen-rpc-package', 'status-page', 'verify-contracts']) {
      expect(help.stdout).not.include(`setup ${name}`)
      const removed = spawnSync(process.execPath, [cli, 'setup', name, '--help'], {encoding: 'utf8', env: {...process.env, CI: 'true'}})
      expect(removed.status, name).not.equal(0)
    }

    for (const command of [['cubesigner', 'refresh-session'], ['rpc', 'export'], ['monitoring', 'status-page'], ['contracts', 'verify']]) {
      const result = spawnSync(process.execPath, [cli, ...command, '--help'], {encoding: 'utf8'})
      expect(result.status, result.stdout + result.stderr).equal(0)
    }

    const ops = spawnSync(process.execPath, [cli, 'artifacts', 'access', '--help'], {encoding: 'utf8'})
    expect(ops.status, ops.stderr).equal(0)
    expect(ops.stdout).include('--no-public-read')
  })

  it('keeps AWS role binding inside the AWS stage', () => {
    expect(PROOF_AWS_INIT_NEXT_STEPS).to.include('setup aws')
    expect(PROOF_AWS_INIT_NEXT_STEPS).not.to.include('setup prep-charts')
  })

  it('rejects direct resource command use before any preparation work', () => {
    const saved = process.env.SCROLLSDK_PREPARATION_STEP
    delete process.env.SCROLLSDK_PREPARATION_STEP
    try {
      expect(() => requirePreparationStep(['proof-aws'])).to.throw('Use setup plan, setup genesis and setup aws')
      process.env.SCROLLSDK_PREPARATION_STEP = 'proof-aws'
      expect(() => requirePreparationStep(['proof-aws'])).not.to.throw()
      expect(() => requirePreparationStep(['identities'])).to.throw('internal preparation step')
    } finally {
      if (saved === undefined) delete process.env.SCROLLSDK_PREPARATION_STEP
      else process.env.SCROLLSDK_PREPARATION_STEP = saved
    }
  })
})

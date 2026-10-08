import {CubeSignerClient} from '@cubist-labs/cubesigner-sdk'
import {JsonFileSessionManager} from '@cubist-labs/cubesigner-sdk-fs-storage'
import {Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {configurePolicyResolver} from '../../../utils/cubesigner-policy-resolver.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class CubesignerPolicyResolver extends Command {
  static description = 'Preview or add a policy resolver to the CubeSigner organization HTTP authority allowlist, preserving its existing configuration'
  static flags = {
    apply: Flags.boolean({default: false, description: 'Add the resolver authority and verify provider readback'}),
    'base-url': Flags.string({required: true}),
    json: Flags.boolean({default: false}),
    organization: Flags.string({required: true}),
    output: Flags.string({description: 'Write the non-secret resolver configuration receipt to a new file'}),
    'session-file': Flags.string({description: 'Management session file; defaults to the cs CLI session'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CubesignerPolicyResolver)
    const output = new JsonOutputContext('setup cubesigner-policy resolver', flags.json)
    try {
      if (flags.output && fs.existsSync(flags.output)) throw new Error('Resolver receipt already exists')
      const session = flags['session-file'] ?? process.env.CUBESIGNER_MANAGEMENT_TOKEN_FILE ?? path.join(os.homedir(), '.config/cubesigner/management-session.json')
      const client = await CubeSignerClient.create(new JsonFileSessionManager(session))
      const result = await configurePolicyResolver({apply: flags.apply, baseUrl: flags['base-url'], org: client.org(), organization: flags.organization})
      const receipt = {...result, checkedAt: new Date().toISOString(), schema: 'dogeos/cubesigner-policy-resolver/v1'}
      if (flags.output) fs.writeFileSync(flags.output, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600})
      output.success(receipt)
    } catch (error) {
      // SDK errors may contain request/session diagnostics.
      const provider = error as {errorCode?: unknown; status?: unknown}
      const status = typeof provider.status === 'number' ? ` (HTTP ${provider.status})` : ''
      const code = typeof provider.errorCode === 'string' && /^[\w-]+$/.test(provider.errorCode) ? ` [${provider.errorCode}]` : ''
      output.error('E742_POLICY_RESOLVER_FAILED', `Resolver configuration failed${status}${code}; check the organization, session, HTTPS URL and output path`, 'CONFIGURATION', true)
    }
  }
}

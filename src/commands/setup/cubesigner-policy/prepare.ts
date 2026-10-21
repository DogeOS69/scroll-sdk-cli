import {CubeSignerClient, envs} from '@cubist-labs/cubesigner-sdk'
import {JsonFileSessionManager} from '@cubist-labs/cubesigner-sdk-fs-storage'
import {Command, Flags} from '@oclif/core'
import os from 'node:os'
import path from 'node:path'

import {readCubesignerOrganization} from '../../../utils/cubesigner-organization.js'
import {readRoleScopedPolicyKey} from '../../../utils/cubesigner-policy-readback.js'
import {PolicyReconciliationError, reconcileCubesignerPolicy} from '../../../utils/cubesigner-policy-reconcile.js'
import {DEFAULT_DEPLOYMENT} from '../../../utils/deployment-paths.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class CubesignerPolicyPrepare extends Command {
  static description = 'Prepare expected production policy from reviewed artifacts and a concrete published version; no attachment required'
  static examples = ['<%= config.bin %> <%= command.id %> --dir deployment --input .data/policy-review.json --json']
  static flags = {
    dir: Flags.string({default: DEFAULT_DEPLOYMENT}),
    input: Flags.string({description: 'Reviewed release inputs JSON, relative to deployment; see docs/cubesigner-external-policy.md', required: true}),
    json: Flags.boolean({default: false}),
    output: Flags.string({default: '.data/cubesigner-policy-prepared', description: 'New evidence directory relative to deployment; existing output is never overwritten'}),
    'session-file': Flags.string({description: 'Management session; defaults to the cs CLI session'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CubesignerPolicyPrepare)
    const output = new JsonOutputContext('setup cubesigner-policy prepare', flags.json)
    try {
      output.success(await reconcileCubesignerPolicy({async connect() {
        const session = flags['session-file'] ?? process.env.CUBESIGNER_MANAGEMENT_TOKEN_FILE ?? path.join(os.homedir(), '.config/cubesigner/management-session.json')
        const client = await CubeSignerClient.create(new JsonFileSessionManager(session))
        const api = client.apiClient
        return {
          authorities: async () => (await client.org().policyEngineConfiguration())?.allowed_http_authorities ?? [],
          environment: Object.entries(envs).find(([, env]) => env.SignerApiRoot === client.env.SignerApiRoot)?.[0] ?? 'unknown',
          key: (roleId, keyId) => readRoleScopedPolicyKey(api, roleId, keyId),
          ...await readCubesignerOrganization(client),
          policy: (name, version) => api.policyGet(name, version as `v${number}`),
          role: id => api.roleGet(id),
        }
      }, directory: flags.dir, input: flags.input, output: flags.output, prepareOnly: true}))
    } catch (error) {
      // Never expose SDK/session diagnostics or parse errors containing private input.
      output.error('E743_POLICY_RECONCILIATION_FAILED', error instanceof PolicyReconciliationError ? error.message : 'Policy reconciliation failed; check input files, receipt validation and management-session read access. Provider output omitted.', 'CONFIGURATION', true)
    }
  }
}

import {CubeSignerClient} from '@cubist-labs/cubesigner-sdk'
import {JsonFileSessionManager} from '@cubist-labs/cubesigner-sdk-fs-storage'
import {Command, Flags} from '@oclif/core'
import os from 'node:os'
import path from 'node:path'

import {connectActivationClient} from '../../../utils/cubesigner-activation-client.js'
import {PolicyValidationError} from '../../../utils/cubesigner-governance.js'
import {prepareRuntimeSession} from '../../../utils/cubesigner-session-preparation.js'
import {DEFAULT_DEPLOYMENT} from '../../../utils/deployment-paths.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class PrepareSession extends Command {
  static description = 'Reuse a valid scoped signer session or explicitly create one when the role permits it, independently of attachment approval; no upload or pod restart'
  static flags = {dir: Flags.string({default: DEFAULT_DEPLOYMENT}), json: Flags.boolean({default: false}), 'session-file': Flags.string({description: 'Management session file'})}
  async run(): Promise<void> {
    const {flags} = await this.parse(PrepareSession)
    const output = new JsonOutputContext('setup cubesigner-policy prepare-session', flags.json)
    try {
      const client = await connectActivationClient(flags['session-file'])
      const result = await prepareRuntimeSession({client, async create(role, purpose, lifetimes) {
        const management = await CubeSignerClient.create(new JsonFileSessionManager(flags['session-file'] ?? process.env.CUBESIGNER_MANAGEMENT_TOKEN_FILE ?? path.join(os.homedir(), '.config/cubesigner/management-session.json')))
        return management.apiClient.sessionCreateForRole(role, purpose, ['sign:btc:psbt:doge'], lifetimes)
      }, directory: flags.dir})
      output.success(result)
    } catch (error) {
      output.error('E746_RUNTIME_SESSION_PENDING', (error instanceof PolicyValidationError ? error.message + '. ' : '') + 'Session preparation requires valid artifacts, role authorization and scoped credentials. Review the private creation journal for interrupted operations. Existing sessions were not rotated.', 'VALIDATION', true)
    }
  }
}

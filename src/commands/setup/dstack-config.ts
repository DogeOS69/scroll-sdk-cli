import * as toml from '@iarna/toml'
import {checkbox, input, password} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {DstackControllerConfig} from '../../types/dstack-controller.js'
import type {DstackProvider} from '../../utils/dstack-credentials.js'

import {
  DSTACK_CREDENTIALS_FILE, checkPrivatePath, configureDstackCredentialRefs, newDstackCredentials,
  readDstackCredentials, renderDstackSecrets, validateDstackCredentials, validateGcpServiceAccount, writePrivateFile,
} from '../../utils/dstack-credentials.js'
import {CliExitError, JsonOutputContext} from '../../utils/json-output.js'

export default class DstackConfig extends Command {
  static override description = 'Import Vast.ai/GCP credentials locally and configure dstack controller Secret references'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --vastai-api-key-file /private/vastai-key --gcp-service-account /private/service-account.json -N',
    '<%= config.bin %> <%= command.id %> --spec deployment-spec.yaml --provider vastai --vastai-api-key-file /private/vastai-key -N',
  ]

  static override flags = {
    'doge-config': Flags.string({description: 'Public TOML configuration to update (default .data/doge-config.toml)', exclusive: ['spec']}),
    'gcp-project-id': Flags.string({description: 'GCP project to provision in (default service account project_id)'}),
    'gcp-service-account': Flags.string({description: 'Path to GCP service-account JSON; imported into private local state'}),
    json: Flags.boolean({default: false, description: 'Output metadata as JSON; never print credentials'}),
    'non-interactive': Flags.boolean({char: 'N', default: false, description: 'Use supplied files and existing state; fail on missing credentials'}),
    project: Flags.string({description: 'Dstack project name (default main on first import)'}),
    provider: Flags.string({description: 'Exact enabled provider set; repeat for multiple providers. Omit to retain existing and add supplied providers.', multiple: true, options: ['vastai', 'gcp']}),
    spec: Flags.string({description: 'Update an existing DeploymentSpec YAML instead of doge-config TOML', exclusive: ['doge-config']}),
    'vastai-api-key-file': Flags.string({description: 'Path to a file containing only the Vast.ai API key; avoids credentials in command arguments'}),
  }

  protected override async catch(error: Error): Promise<void> {
    if (error instanceof CliExitError) {
      this.exit(1)
    }

    throw error
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(DstackConfig)
    const output = new JsonOutputContext('setup dstack-config', flags.json)
    try {
      const file = path.resolve(flags.spec ?? flags['doge-config'] ?? '.data/doge-config.toml')
      checkPrivatePath(file)
      let document: Record<string, unknown> = {}
      if (fs.existsSync(file)) {
        try {
          document = (flags.spec ? yaml.load(fs.readFileSync(file, 'utf8')) : toml.parse(fs.readFileSync(file, 'utf8'))) as Record<string, unknown>
          if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid')
        } catch {
          throw new Error('Cannot parse deployment configuration; contents omitted')
        }
      } else if (flags.spec || flags['doge-config']) throw new Error('The specified deployment configuration does not exist')

      const existing = readDstackCredentials()
      const state = existing ?? newDstackCredentials()
      const supplied: DstackProvider[] = []
      if (flags['vastai-api-key-file']) {
        state.vastaiApiKey = fs.readFileSync(path.resolve(flags['vastai-api-key-file']), 'utf8').trim()
        supplied.push('vastai')
      }

      if (flags['gcp-service-account']) {
        const serviceAccount = fs.readFileSync(path.resolve(flags['gcp-service-account']), 'utf8')
        state.gcp = {projectId: validateGcpServiceAccount(serviceAccount), serviceAccount}
        supplied.push('gcp')
      }

      state.providers = flags.provider ? [...new Set(flags.provider)] as DstackProvider[] : [...new Set([...state.providers, ...supplied])]
      if (!flags['non-interactive'] && !flags.provider) {
        state.providers = await checkbox<DstackProvider>({
          choices: [{checked: state.providers.includes('vastai'), name: 'Vast.ai', value: 'vastai'}, {checked: state.providers.includes('gcp'), name: 'GCP', value: 'gcp'}],
          message: 'Select GPU providers for this dstack controller:',
          required: true,
        })
      }

      if (state.providers.includes('vastai') && !state.vastaiApiKey && !flags['non-interactive']) {
        state.vastaiApiKey = (await password({mask: '*', message: 'Vast.ai API key:'})).trim()
      }

      if (state.providers.includes('gcp') && !state.gcp && !flags['non-interactive']) {
        const source = await input({message: 'Path to GCP service-account.json:', required: true})
        const serviceAccount = fs.readFileSync(path.resolve(source), 'utf8')
        state.gcp = {projectId: validateGcpServiceAccount(serviceAccount), serviceAccount}
      }

      if (flags['gcp-project-id']) {
        if (!state.gcp) throw new Error('--gcp-project-id requires a GCP service account')
        state.gcp.projectId = flags['gcp-project-id']
      }

      if (flags.project) state.project = flags.project
      if (!state.providers.includes('gcp')) delete state.gcp
      if (!state.providers.includes('vastai')) delete state.vastaiApiKey
      validateDstackCredentials(state)
      const controller = configureDstackCredentialRefs((document.dstackController ?? {}) as DstackControllerConfig, state)
      const secrets = renderDstackSecrets(controller, state)
      if (!existing && secrets.some(secret => fs.existsSync(path.join('secrets', `${secret.metadata.name}.yaml`)))) {
        throw new Error('Dstack Secret outputs already exist but credential state is missing. Restore .data/dstack/credentials.json from backup before importing; keys will not be regenerated.')
      }

      document.dstackController = controller
      // Serialize and validate all destinations before writing state or public references.
      const publicContent = flags.spec ? yaml.dump(document, {lineWidth: -1, noRefs: true}) : toml.stringify(document as toml.JsonMap)
      checkPrivatePath(DSTACK_CREDENTIALS_FILE)
      checkPrivatePath('.gitignore')
      let ignore = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : ''
      for (const entry of ['/.data/dstack/', '/secrets/']) if (!ignore.split('\n').includes(entry)) ignore += `${ignore.endsWith('\n') || !ignore ? '' : '\n'}${entry}\n`
      fs.writeFileSync('.gitignore', ignore)
      writePrivateFile(DSTACK_CREDENTIALS_FILE, JSON.stringify(state, null, 2) + '\n')
      writePrivateFile(file, publicContent)
      output.logSuccess('Dstack credentials imported locally. Run setup gen-secrets --dstack-only, then regenerate chart values.')
      if (flags.json) output.success({configPath: file, credentialStatePath: path.resolve(DSTACK_CREDENTIALS_FILE), project: state.project, providers: state.providers})
    } catch (error) {
      if (error instanceof CliExitError) throw error
      output.error('E_DSTACK_CONFIG', (error as Error).message, 'CONFIGURATION', true)
    }
  }
}

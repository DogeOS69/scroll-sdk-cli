import { Command, Flags } from '@oclif/core'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

import { JsonOutputContext } from '../../utils/json-output.js'
import {
  type ProofDeploymentComponent,
  resolveContractFile,
  validateProofDeploymentContract,
} from '../../utils/proof-deployment-contract.js'

type ComponentName =
  | 'eth-da-submitter'
  | 'proof-coordinator'
  | 'prover-worker'
  | 'withdrawal-processor'

export function buildProofHelmArgs(input: {
  chart: string
  component: ProofDeploymentComponent
  deploymentDir: string
  dryRun?: boolean
  namespace: string
  release: string
  version: string
}): string[] {
  const args = [
    'upgrade', '-i', input.release, input.chart,
    '-n', input.namespace,
    '--version', input.version,
    '--values', resolveContractFile(input.deploymentDir, input.component.valuesFile),
  ]
  for (const binding of input.component.setFiles) {
    args.push('--set-file', `${binding.key}=${resolveContractFile(input.deploymentDir, binding.path)}`)
  }

  if (input.dryRun) args.push('--dry-run')
  return args
}

export default class ProofHelm extends Command {
  static override description = 'Apply one proof-related Helm component from the setup-generated deployment contract; absent components with values are projected to zero replicas'

  static override flags = {
    chart: Flags.string({ description: 'Helm chart reference', required: true }),
    component: Flags.string({
      options: [
        'eth-da-submitter',
        'proof-coordinator',
        'prover-worker',
        'withdrawal-processor',
      ],
      required: true,
    }),
    'deployment-dir': Flags.string({ default: '.', description: 'Deployment root containing .data/proof-deployment.json' }),
    'dry-run': Flags.boolean({ default: false, description: 'Pass --dry-run to Helm' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    namespace: Flags.string({ default: 'default', description: 'Kubernetes namespace' }),
    release: Flags.string({ description: 'Helm release name', required: true }),
    version: Flags.string({ description: 'Helm chart version', required: true }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofHelm)
    const json = new JsonOutputContext('helper proof-helm', flags.json)
    try {
      const deploymentDir = path.resolve(flags['deployment-dir'])
      const contract = validateProofDeploymentContract(deploymentDir)
      const componentName = flags.component as ComponentName
      const component = componentName === 'eth-da-submitter'
        ? contract.components.ethDaSubmitter
        : componentName === 'proof-coordinator'
          ? contract.components.proofCoordinator
          : componentName === 'prover-worker'
            ? contract.components.proverWorker
            : contract.components.withdrawalProcessor
      if (!component.enabled) {
        json.info(`Applying absent ${componentName} projection for proof mode ${contract.mode}`)
      }

      const args = buildProofHelmArgs({
        chart: flags.chart,
        component,
        deploymentDir,
        dryRun: flags['dry-run'],
        namespace: flags.namespace,
        release: flags.release,
        version: flags.version,
      })
      const child = spawnSync('helm', args, { encoding: 'utf8', stdio: flags.json ? 'pipe' : 'inherit' })
      if (child.error) throw child.error
      if (child.status !== 0) {
        const detail = flags.json ? String(child.stderr || child.stdout || '').trim() : ''
        throw new Error(`helm exited with status ${String(child.status)}${detail ? `: ${detail}` : ''}`)
      }

      json.success({ component: componentName, mode: contract.mode, skipped: false })
    } catch (error) {
      json.error('E713_PROOF_HELM_FAILED', error instanceof Error ? error.message : String(error), 'KUBERNETES', true)
    }
  }
}

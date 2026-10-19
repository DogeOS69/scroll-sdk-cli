import {Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import type {PreparationStage} from './preparation-stages.js'

import {DEFAULT_DEPLOYMENT} from './deployment-paths.js'
import {JsonOutputContext} from './json-output.js'
import {POLICY_OUTPUT} from './preparation-cubesigner-policy.js'
import {applyPreparation} from './preparation-plan.js'
import {CommandPreparationRunner} from './preparation-runner.js'
import {stageCommand} from './preparation-stages.js'

export const preparationStageFlags = {
  'defer-cubesigner': Flags.boolean({default: false, description: 'Defer signer session creation and upload; other preparation may proceed, signer activation remains pending'}),
  dir: Flags.string({aliases: ['deployment-dir'], default: DEFAULT_DEPLOYMENT, description: 'Saved deployment directory created by setup plan'}),
  json: Flags.boolean({default: false, description: 'Output structured stage status and the next command'}),
}

export async function runPreparationStage(stage: PreparationStage, directory: string, json: boolean, deferCubesigner = false): Promise<void> {
  const output = new JsonOutputContext(`setup ${stage}`, json)
  try {
    const state = await applyPreparation(directory, new CommandPreparationRunner(), step => output.info(`${step.id}: ${step.title}`), {deferCubesigner, stage, warn: message => output.addWarning(message)})
    const plan = JSON.parse(fs.readFileSync(path.join(directory, '.scrollsdk/plan.json'), 'utf8'))
    const hasSigner = plan.steps.some((step: {id: string}) => step.id === 'cubesigner-session')
    const activationCommand = `scrollsdk setup cubesigner-policy verify-activation --dir '${directory.replaceAll("'", "'\\''")}'`
    const nextCommand = state.deferred?.length && stage === 'upload-secrets' ? `${activationCommand} --policy-only` : state.nextStage ? stageCommand(state.nextStage, directory === DEFAULT_DEPLOYMENT ? undefined : directory) + (deferCubesigner && state.nextStage === 'upload-secrets' ? ' --defer-cubesigner' : '') : hasSigner ? activationCommand : undefined
    const policyBuild = state.steps['cubesigner-policy-build'] === 'completed' ? {directory: `${directory}/${POLICY_OUTPUT}`, governanceHandoff: `${directory}/.data/cubesigner-policy-governance-handoff.json`, status: 'build-prepared-governance-status-not-inferred'} : undefined
    const activation = hasSigner ? {acceptance: 'not-verified', instruction: 'Configuration preparation is not activation. Do not install cubesigner-signer until fresh activation verification passes.', nextCommand: activationCommand, status: 'pending'} : undefined
    const report = {activation, completed: Object.keys(state.steps).filter(id => state.steps[id] === 'completed'), configuration: state.steps['render-final'] === 'completed' ? 'prepared' : 'in-progress', currentStep: state.currentStep, deferred: state.deferred ?? [], nextCommand, policyBuild, stage, status: state.status, waiting: state.waiting}
    if (!json) {
      output.info(JSON.stringify(report, null, 2))
      if (nextCommand) output.info(`Continue with: ${nextCommand}`)
      else output.info('Preparation complete. Install Helm releases manually using the generated Makefile; verify its KUBE_CONTEXT and NAMESPACE defaults before installation.')
    }

    output.success(report)
    process.exitCode = ['prepared', 'stage-complete'].includes(state.status) ? 0 : state.status === 'waiting' ? 2 : 1
  } catch (error) {output.error('E752_PREPARATION_STAGE_FAILED', error instanceof Error ? error.message : 'Unable to execute stage', 'CONFIGURATION', true)}
}

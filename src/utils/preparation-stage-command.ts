import {Flags} from '@oclif/core'

import type {PreparationStage} from './preparation-stages.js'

import {DEFAULT_DEPLOYMENT} from './deployment-paths.js'
import {CliExitError, JsonOutputContext} from './json-output.js'
import {POLICY_OUTPUT} from './preparation-cubesigner-policy.js'
import {type PreparationState, applyPreparation} from './preparation-plan.js'
import {CommandPreparationRunner} from './preparation-runner.js'
import {stageCommand} from './preparation-stages.js'

export const preparationStageFlags = {
  dir: Flags.string({aliases: ['deployment-dir'], default: DEFAULT_DEPLOYMENT, description: 'Saved deployment directory created by setup plan'}),
  json: Flags.boolean({default: false, description: 'Output structured stage status and the next command'}),
}

export function reportPreparationStage(output: JsonOutputContext, stage: PreparationStage, directory: string, state: PreparationState): void {
  const nextCommand = state.nextStage ? stageCommand(state.nextStage, directory === DEFAULT_DEPLOYMENT ? undefined : directory) : undefined
  const policyBuild = state.steps['cubesigner-policy-build'] === 'completed' ? {directory: `${directory}/${POLICY_OUTPUT}`, governanceHandoff: `${directory}/.data/cubesigner-policy-governance-handoff.json`, status: 'build-prepared-governance-status-not-inferred'} : undefined
  const report = {completed: Object.keys(state.steps).filter(id => state.steps[id] === 'completed'), currentStep: state.currentStep, nextCommand, policyBuild, stage, status: state.status, waiting: state.waiting}
  if (state.status === 'failed' || state.status === 'recovery-required') {
    output.error('E752_PREPARATION_STAGE_FAILED', state.waiting?.message ?? `Preparation stage ${stage} ${state.status}`, 'PREREQUISITE', state.status === 'failed', report)
  }

  if (!output.isJsonEnabled) {
    output.info(JSON.stringify(report, null, 2))
    if (nextCommand) output.info(`Continue with: ${nextCommand}`)
    else if (state.status === 'prepared') output.info('Preparation complete. Install Helm releases manually using the generated Makefile; verify its KUBE_CONTEXT and NAMESPACE defaults before installation.')
  }

  output.success(report)
  process.exitCode = ['prepared', 'stage-complete'].includes(state.status) ? 0 : state.status === 'waiting' ? 2 : 1
}

export async function runPreparationStage(stage: PreparationStage, directory: string, json: boolean): Promise<void> {
  const output = new JsonOutputContext(`setup ${stage}`, json)
  try {
    const state = await applyPreparation(directory, new CommandPreparationRunner(), step => output.info(`${step.id}: ${step.title}`), {stage, warn: message => output.addWarning(message)})
    reportPreparationStage(output, stage, directory, state)
  } catch (error) {
    if (error instanceof CliExitError) throw error
    output.error('E752_PREPARATION_STAGE_FAILED', error instanceof Error ? error.message : 'Unable to execute stage', 'CONFIGURATION', true)
  }
}

import {Flags} from '@oclif/core'

import type {PreparationStage} from './preparation-stages.js'

import {DEFAULT_DEPLOYMENT} from './deployment-paths.js'
import {JsonOutputContext} from './json-output.js'
import {applyPreparation} from './preparation-plan.js'
import {CommandPreparationRunner} from './preparation-runner.js'
import {stageCommand} from './preparation-stages.js'

export const preparationStageFlags = {
  dir: Flags.string({aliases: ['deployment-dir'], default: DEFAULT_DEPLOYMENT, description: 'Saved deployment directory created by setup plan'}),
  json: Flags.boolean({default: false, description: 'Output structured stage status and the next command'}),
}

export async function runPreparationStage(stage: PreparationStage, directory: string, json: boolean): Promise<void> {
  const output = new JsonOutputContext(`setup ${stage}`, json)
  try {
    const state = await applyPreparation(directory, new CommandPreparationRunner(), step => output.info(`${step.id}: ${step.title}`), {stage})
    const nextCommand = state.nextStage ? stageCommand(state.nextStage, directory === DEFAULT_DEPLOYMENT ? undefined : directory) : undefined
    const report = {completed: Object.keys(state.steps).filter(id => state.steps[id] === 'completed'), currentStep: state.currentStep, nextCommand, stage, status: state.status, waiting: state.waiting}
    if (!json) {
      output.info(JSON.stringify(report, null, 2))
      if (nextCommand) output.info(`Continue with: ${nextCommand}`)
      else output.info('Preparation complete. Install Helm releases manually using the generated Makefile; verify its KUBE_CONTEXT and NAMESPACE defaults before installation.')
    }

    output.success(report)
    process.exitCode = ['prepared', 'stage-complete'].includes(state.status) ? 0 : state.status === 'waiting' ? 2 : 1
  } catch (error) {output.error('E752_PREPARATION_STAGE_FAILED', error instanceof Error ? error.message : 'Unable to execute stage', 'CONFIGURATION', true)}
}

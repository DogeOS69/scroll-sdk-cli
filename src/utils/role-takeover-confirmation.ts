import {confirm} from '@inquirer/prompts'

import {type ApproveRoleTakeover, type RoleTakeoverPreview, RoleTakeoverRequired} from './aws-workload-role.js'
import {AwaitingInput} from './preparation-io.js'

export type ConfirmRoleTakeover = (preview: RoleTakeoverPreview) => Promise<boolean>

export function roleTakeoverMessage(preview: RoleTakeoverPreview): string {
  return `Existing IAM role requires CLI takeover: ${preview.roleArn}\n`
    + 'The CLI will own this role, replace its trust and catalog policies, delete the listed extra inline policies and detach the listed managed policies. Coordinate with any previous manager or workloads sharing this role.\n'
    + JSON.stringify(preview, null, 2)
}

export function interactiveRoleTakeover(json: boolean): ConfirmRoleTakeover {
  return async preview => {
    if (json || !process.stdin.isTTY || !process.stderr.isTTY) return false
    process.stderr.write(`${roleTakeoverMessage(preview)}\n`)
    // This installed Inquirer version otherwise settles Ctrl-C only during exit.
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const keypress = (_text: string, key: {ctrl?: boolean; name?: string}) => {if (key.ctrl && key.name === 'c') cancel()}
    process.stdin.on('keypress', keypress)
    process.on('SIGINT', cancel)
    try {return await confirm({default: false, message: `Let the CLI take over ${preview.roleArn}?`}, {output: process.stderr, signal: controller.signal})}
    catch (error) {
      if (error instanceof Error && ['AbortPromptError', 'ExitPromptError'].includes(error.name)) return false
      throw error
    } finally {
      process.stdin.removeListener('keypress', keypress)
      process.removeListener('SIGINT', cancel)
    }
  }
}

/** Approvals last only for this attempt and this observed role/desired change. */
export async function withRoleTakeoverConfirmation(run: (approve: ApproveRoleTakeover) => void, confirmTakeover: ConfirmRoleTakeover = async () => false): Promise<void> {
  const approved = new Set<string>()
  for (;;) {
    try {run(preview => approved.has(JSON.stringify(preview))); return}
    catch (error) {
      if (!(error instanceof RoleTakeoverRequired)) throw error
      const snapshot = JSON.stringify(error.preview)
      if (!await confirmTakeover(error.preview)) throw new AwaitingInput({message: `${roleTakeoverMessage(error.preview)}\nTakeover was not approved. No changes were made to this role. Rerun setup aws in an interactive terminal without --json to review and confirm.`})
      approved.add(snapshot)
    }
  }
}

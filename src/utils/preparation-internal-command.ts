/** Internal adapters are invoked by the staged runner, not a second deployment workflow. */
export function requirePreparationStep(steps: string[]): void {
  if (!steps.includes(process.env.SCROLLSDK_PREPARATION_STEP ?? '')) throw new Error('This command is an internal preparation step. Use setup plan, setup genesis and setup aws, then follow the reported next stage.')
}

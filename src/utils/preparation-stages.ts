import type {PreparationStep} from './preparation-plan.js'

export const PREPARATION_STAGES = ['genesis', 'aws', 'bridge-funding', 'protocol-context', 'proof-materials', 'policy-prepare', 'proof-publish', 'signer-kit', 'signer-kit-publish', 'render', 'upload-secrets'] as const
export type PreparationStage = typeof PREPARATION_STAGES[number]

/** Stage boundaries are explicit; prerequisites are checked, never executed implicitly. */
export function stagedPreparationSteps(legacy: PreparationStep[]): PreparationStep[] {
  const order: Record<PreparationStage, string[]> = {
    aws: ['identities', 'proof-aws', 'archive', 'archive-access', 'bridge-sequencer-kms', 'dstack', 'dstack-db', 'blockscout-db'],
    'bridge-funding': ['bridge-fee-wallet', 'bridge-prepare', 'ethereum-anchor', 'managed-helper-prepare', 'managed-helper-funding', 'managed-helper-setup', 'production-wallets', 'helper-funding', 'helper-setup', 'bridge-info', 'production-funding', 'helper-fund', 'managed-helper-fund', 'managed-helper-verify'],
    genesis: ['bootstrap', 'genesis-local'],
    'policy-prepare': ['cubesigner-policy-build'],
    'proof-materials': ['external-inputs', 'proof-release-bake', 'proof-materializer-export', 'proof-worker-check', 'proof-materials'],
    'proof-publish': ['charts', 'proof-publish', 'charts-published'],
    'protocol-context': ['protocol-context'],
    render: ['render-final', 'secrets', 'cubesigner-session', 'capacity-manager', 'proof-check', 'proof-workers-intent'],
    'signer-kit': ['deployment-kit'],
    'signer-kit-publish': ['deployment-kit-published'],
    'upload-secrets': ['secret-upload', 'cubesigner-secret-upload'],
  }
  const steps = new Map(legacy.map(step => [step.id, step]))
  steps.delete('genesis')
  steps.set('genesis-local', {effect: 'local', id: 'genesis-local', retry: 'safe', title: 'Generate genesis locally without creating service identities or AWS resources'})
  // Render again after publication so final values bind the approved kit record.
  steps.set('render-final', {effect: 'local', id: 'render-final', retry: 'safe', title: 'Render final deployment configuration'})
  steps.set('secret-upload', {effect: 'cloud', id: 'secret-upload', retry: 'safe', title: 'Upload runtime Secrets using the saved deployment destination'})
  const result = PREPARATION_STAGES.flatMap(stage => order[stage].flatMap(id => steps.has(id) ? [{...steps.get(id)!, stage}] : []))
  if (result.length !== steps.size) throw new Error('A preparation step has no stage assignment')
  return result
}

export function stageCommand(stage: PreparationStage, directory?: string): string {
  const suffix = directory ? ` --dir '${directory.replaceAll("'", "'\\''")}'` : ''
  return `scrollsdk setup ${stage}${suffix}`
}

/** Policy and proof preparation share context, but neither depends on the other. */
export function prerequisiteStages(stage: PreparationStage): PreparationStage[] {
  if (stage === 'policy-prepare') return PREPARATION_STAGES.slice(0, PREPARATION_STAGES.indexOf('proof-materials'))
  const earlier = PREPARATION_STAGES.slice(0, PREPARATION_STAGES.indexOf(stage))
  // Kit publication is an explicit handoff; it cannot prevent preparing unrelated services.
  return ['render', 'upload-secrets'].includes(stage) ? earlier.filter(item => item !== 'signer-kit-publish') : earlier
}

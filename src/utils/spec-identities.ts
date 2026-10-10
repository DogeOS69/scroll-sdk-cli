/* eslint-disable @typescript-eslint/no-explicit-any -- Adapter to existing dynamic identity commands and deployment TOML. */
import type {DeploymentIdentityIntent, DeploymentSpec, NodekeyIdentityIntent, SignerIdentityIntent} from '../types/deployment-spec.js'

function requireText(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.includes('$ENV:')) throw new Error(`${label} must be an explicit non-empty resource reference`)
}

function validateKeyAction(input: NodekeyIdentityIntent, label: string): void {
  if (!['create', 'import', 'reuse'].includes(input.action)) throw new Error(`${label}.action must be create, import or reuse`)
  if (input.action === 'import') {
    if (!input.privateKeyEnv || !/^[A-Z_a-z]\w*$/.test(input.privateKeyEnv)) throw new Error(`${label}.privateKeyEnv must name an environment variable for import`)
  } else if (input.privateKeyEnv !== undefined) throw new Error(`${label}.privateKeyEnv is only allowed for import`)
  if (input.secretMode !== undefined && !['external-secret', 'plain'].includes(input.secretMode)) throw new Error(`${label}.secretMode is invalid`)
}

/** Resolve non-secret infrastructure defaults only. Never read private keys or contact AWS. */
export function resolveSpecIdentities(spec: DeploymentSpec): DeploymentIdentityIntent | undefined {
  if (!spec.identities) return undefined
  const intent = structuredClone(spec.identities)
  const signer = (input: SignerIdentityIntent | undefined, label: string): void => {
    if (!input) throw new Error(`${label} is required when identities is configured`)
    if (input.action === 'create' && input.expectedAddress) throw new Error(`${label}: create cannot specify a predetermined address`)
    if (input.expectedAddress !== undefined && !/^0x[\dA-Fa-f]{40}$/.test(input.expectedAddress)) throw new Error(`${label}.expectedAddress must be an Ethereum address`)
    if (input.backend === 'local') {
      validateKeyAction(input, label)
      if (input.kms) throw new Error(`${label}.kms is only allowed for aws_kms`)
    } else if (input.backend === 'aws_kms') {
      if (!['create', 'reuse'].includes(input.action) || input.privateKeyEnv) throw new Error(`${label}: AWS KMS requires create or reuse without a local key`)
      input.kms = {
        eksCluster: spec.infrastructure.aws?.eksClusterName,
        namespace: spec.infrastructure.namespace ?? 'default',
        networkAlias: spec.metadata.name,
        region: spec.infrastructure.aws?.region,
        ...input.kms,
      }
      for (const field of ['eksCluster', 'namespace', 'networkAlias', 'region'] as const) requireText(input.kms[field], `${label}.kms.${field}`)
      if (input.action === 'reuse') {
        requireText(input.kms.keyId, `${label}.kms.keyId`)
        requireText(input.kms.roleArn, `${label}.kms.roleArn`)
      } else if (input.kms.keyId || input.expectedAddress) throw new Error(`${label}: create cannot select an existing KMS key or a predetermined address; use reuse`)
      if (input.kms.roleArn !== undefined && !/^arn:aws[\w-]*:iam::\d{12}:role\/.+/.test(input.kms.roleArn)) throw new Error(`${label}.kms.roleArn must be an IAM role ARN`)
    } else throw new Error(`${label}.backend must be local or aws_kms`)
  }

  signer(intent.feeOracle, 'identities.feeOracle')
  signer(intent.ethDaSubmitter, 'identities.ethDaSubmitter')
  for (const [nodes, count, label] of [[intent.sequencers, spec.infrastructure.sequencerCount, 'sequencers'], [intent.bootnodes, spec.infrastructure.bootnodeCount, 'bootnodes']] as const) {
    if (!Array.isArray(nodes) || nodes.length !== count || new Set(nodes.map(node => node.index)).size !== count
      || nodes.some(node => !Number.isSafeInteger(node.index) || node.index < 0 || node.index >= count)) throw new Error(`identities.${label} must declare each configured node index exactly once`)
    for (const node of nodes) {
      if (!node.nodekey) throw new Error(`identities.${label}[${node.index}].nodekey is required`)
      validateKeyAction(node.nodekey, `identities.${label}[${node.index}].nodekey`)
    }
  }

  for (const node of intent.sequencers) signer(node.signer, `identities.sequencers[${node.index}].signer`)
  for (const [key, input] of [['l1CommitSender', intent.ethDaSubmitter], ['l2GasOracleSender', intent.feeOracle]] as const) {
    if (input.backend === 'aws_kms' && (spec.accounts?.[key]?.privateKey || spec.accounts?.[key]?.address)) throw new Error(`accounts.${key} conflicts with the AWS KMS identity intent; put the expectedAddress in identities instead`)
  }

  return intent
}

export function specIdentityFlags(intent: DeploymentIdentityIntent, task: {index?: number; indices?: number[]; service: string}, config: any): Record<string, unknown> {
  const sequencer = task.service === 'sequencer-reth'
  const node = sequencer ? intent.sequencers.find(entry => entry.index === task.index)
    : task.service === 'bootnode-reth' ? intent.bootnodes.find(entry => entry.index === task.indices?.[0]) : undefined
  if ((sequencer || task.service === 'bootnode-reth') && !node) throw new Error(`${task.service}: selected node has no declared identity intent`)
  const signer = sequencer ? (node as DeploymentIdentityIntent['sequencers'][number])?.signer
    : task.service === 'fee-oracle' ? intent.feeOracle : task.service === 'eth-da-submitter' ? intent.ethDaSubmitter : undefined
  if (task.service !== 'bootnode-reth' && !signer) throw new Error(`${task.service}: signing identity intent is missing`)
  const current = sequencer ? config.sequencerReth?.instances?.find((entry: any) => entry.index === task.index)
    : config.bootnodeReth?.instances?.find((entry: any) => entry.index === task.indices?.[0])
  const flags: Record<string, unknown> = {}
  if (node) {
    if (node.nodekey.action === 'reuse' && !current?.nodekey?.privateKey) throw new Error(`${task.service}: no saved nodekey to reuse`)
    if (node.nodekey.privateKeyEnv) flags.nodekey = `$ENV:${node.nodekey.privateKeyEnv}`
    flags['secret-mode'] = node.nodekey.secretMode ?? 'external-secret'
  }

  if (signer) {
    flags['signer-backend'] = signer.backend === 'aws_kms' ? 'aws-kms' : 'local'
    if (signer.privateKeyEnv) flags['signer-private-key'] = `$ENV:${signer.privateKeyEnv}`
    if (signer.expectedAddress) flags['expected-address'] = signer.expectedAddress
    if (signer.backend === 'local' && signer.action === 'reuse') {
      const key = sequencer ? current?.signer?.privateKey : config.accounts?.[task.service === 'fee-oracle' ? 'L2_GAS_ORACLE_SENDER_PRIVATE_KEY' : 'L1_COMMIT_SENDER_PRIVATE_KEY']
      if (!key) throw new Error(`${task.service}: no saved local signer key to reuse`)
    }

    for (const [field, flag] of [['keyId', 'kms-key-id'], ['roleArn', 'role-arn'], ['region', 'aws-region'], ['eksCluster', 'eks-cluster'], ['namespace', 'namespace'], ['networkAlias', 'network-alias'], ['serviceAccount', 'service-account']] as const) {
      if (signer.kms?.[field] !== undefined) flags[flag] = signer.kms[field]
    }
  }

  return flags
}

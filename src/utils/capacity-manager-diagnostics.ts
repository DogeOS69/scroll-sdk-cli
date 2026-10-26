/* eslint-disable @typescript-eslint/no-explicit-any -- Prepared values and Kubernetes documents. */
import * as yaml from 'js-yaml'
import fs from 'node:fs'

import {CAPACITY_MANAGER_PLAN, parseCapacityInput} from './capacity-manager.js'
import {capacityExec} from './capacity-manager-exec.js'
import {capacityPreflight, capacityReconcileEvidence} from './capacity-manager-preflight.js'
import {localPath} from './preparation-io.js'

/** Explicit runtime diagnostics. Probing creates/deletes only a temporary Pod. */
export function inspectCapacityManager(root: string, options: {kubeContext: string; namespace: string; probe?: boolean; status?: boolean}, exec: typeof capacityExec = capacityExec): Record<string, unknown> {
  const planFile = localPath(root, CAPACITY_MANAGER_PLAN)
  if (!fs.existsSync(planFile)) throw new Error('Capacity Manager is not prepared; select capacityManager in the deployment spec and run setup render')
  const plan = parseCapacityInput(fs.readFileSync(planFile, 'utf8'), 'capacity-manager plan JSON', JSON.parse)
  if (plan.schema !== 'scrollsdk/capacity-manager/v1') throw new Error('Unsupported capacity-manager plan; rerun setup render')
  if (plan.kubeContext && options.kubeContext !== plan.kubeContext) throw new Error('Kubernetes context differs from prepared capacity-manager target')
  if (options.namespace !== plan.namespace || plan.dstack.namespace !== plan.namespace) throw new Error('Namespace differs from prepared capacity-manager target')
  const run = (args: string[], input?: string): string => {
    try {return exec(['--context', options.kubeContext, '--namespace', options.namespace, ...args], input)} catch {
      throw new Error('Capacity-manager Kubernetes operation failed; check the selected context, namespace and synchronized Secrets (private response omitted)')
    }
  }

  const result: Record<string, unknown> = {}
  if (options.status) {
    const raw = run(['get', 'deployment', 'capacity-manager', '--ignore-not-found', '-o', 'json'])
    const deployment = raw.trim() ? parseCapacityInput(raw, 'Kubernetes status JSON', JSON.parse) : undefined
    const evidence = deployment ? capacityReconcileEvidence(run(['logs', 'deployment/capacity-manager', '--all-containers=false', '--since=60s', '--tail=200']))
      : {controlLoop: 'not-established', gpuAllocation: 'not-verified', proofAcceptance: 'not-verified'}
    result.status = {...evidence, present: Boolean(deployment), readyReplicas: deployment?.status?.readyReplicas ?? 0, replicas: deployment?.spec?.replicas ?? 0}
  }

  if (options.probe) {
    const values = parseCapacityInput(fs.readFileSync(localPath(root, plan.valuesFile), 'utf8'), 'capacity-manager values YAML', yaml.load) as any
    if (!plan.provider || !plan.workerCredentialMaster) throw new Error('Capacity manager runtime bindings are missing; rerun setup render')
    if (values.manager.dstack.project !== plan.project || values.workerCredentialMaster?.existingSecret !== plan.workerCredentialMaster.existingSecret
      || values.workerCredentialMaster?.key !== plan.workerCredentialMaster.key || values.dstackAuth?.existingSecret !== plan.dstack.auth.existingSecret
      || values.dstackAuth?.key !== plan.dstack.auth.key) throw new Error('Capacity manager credential bindings changed; rerun setup render')
    result.probe = capacityPreflight(plan, values, run)
  }

  return result
}

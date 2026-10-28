/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are untyped documents. */
import * as yaml from 'js-yaml'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {validateServiceNetworkPolicy} from './service-network-policy.js'

export type ValuesValidationIntent = Partial<Pick<DeploymentSpec, 'capacityManager' | 'dogecoin' | 'metadata'>>
export interface ValuesValidationOptions {deferIngressValidation?: boolean}

/** Validate the effective documents, after templates, retained values and overlays. No network IO. */
export function validateFinalValues(files: Record<string, string>, intent: ValuesValidationIntent, options: ValuesValidationOptions = {}): void {
  const mainnet = intent.dogecoin?.network === 'mainnet' || intent.metadata?.environment === 'mainnet'
  for (const [file, content] of Object.entries(files)) {
    const service = file.match(/^(tso-service|withdrawal-processor)-production(?:-\d+)?\.yaml$/)?.[1]
    const role = file.match(/^l2-reth-(sequencer|rpc-public|rpc|bootnode)(?:-\d+)?-production(?:-\d+)?\.yaml$/)?.[1]
    if (!service && !(role && mainnet)) continue
    let values: any
    try {values = yaml.load(content)} catch {throw new Error(`${file}: invalid YAML; contents omitted`)}
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`${file}: expected a values mapping`)
    if (service) {
      validateServiceNetworkPolicy(values, service, options.deferIngressValidation)
      if (service === 'withdrawal-processor' && intent.capacityManager && !options.deferIngressValidation && (values.service?.main?.ports?.['proof-work']?.enabled !== true || !values.networkPolicy.allowFrom.capacityManager?.length)) {
        throw new Error(`${file}: selected Capacity Manager requires proof-work and networkPolicy.allowFrom.capacityManager`)
      }
    }

    if (role && mainnet) validateMainnetReth(values, role, file)
  }
}

function validateMainnetReth(values: any, role: string, file: string): void {
  const fail = (reason: string): never => {throw new Error(`${file}: ${reason}; edit reth.extraArgs or select updated SDK templates`)}
  const extra = values.reth?.extraArgs ?? []
  // Match the chart's list/string interface; it splits strings on whitespace.
  const args: string[] = typeof extra === 'string' ? extra.trim().split(/\s+/).filter(Boolean) : extra
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) fail('reth.extraArgs must be a string or a list of strings')
  const valuesOf = (flag: string): string[] => args.flatMap((arg, index) => arg === flag
    ? [args[index + 1]?.startsWith('--') || args[index + 1] === undefined ? '' : args[index + 1]]
    : arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : [])
  if (valuesOf('--network.legacy-geth-header-transform').some(value => value !== 'false')) fail('mainnet must not enable --network.legacy-geth-header-transform')
  const rotation = valuesOf('--consensus.exit-on-signer-rotation')
  if (role === 'sequencer') {
    if (rotation.length > 0) fail('sequencers must not use --consensus.exit-on-signer-rotation')
    return
  }

  // This is a presence-only clap flag, not a boolean key/value option.
  if (rotation.length !== 1 || rotation[0] !== '') fail('mainnet followers require exactly one --consensus.exit-on-signer-rotation flag')
  if (valuesOf('--consensus.authorized-signer').length > 0) fail('mainnet followers must not pin --consensus.authorized-signer')
  if (valuesOf('--consensus.algorithm').some(value => value !== 'system-contract')) fail('signer rotation requires system-contract consensus')
  if (!values.reth?.l1Url || valuesOf('--l1.url').some(value => !value)) fail('signer rotation requires an L1 URL')
  if (values.controller?.enabled === false || !['daemonset', 'deployment', 'statefulset'].includes(values.controller?.type ?? 'statefulset')
    || (values.controller?.restartPolicy && values.controller.restartPolicy !== 'Always')) fail('followers require a workload controller with restartPolicy Always')
}

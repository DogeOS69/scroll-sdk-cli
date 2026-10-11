import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {PreparationPlan, PreparationState} from './preparation-plan.js'

import {localPath, privateWrite, writeJson} from './preparation-io.js'

/** Called only while apply holds its lock and after managed fingerprints pass. */
export function refreshPreparationRuntime(root: string, plan: PreparationPlan, state: PreparationState, spec: DeploymentSpec, routingSpec?: string): void {
  const index = plan.steps.findIndex(step => step.id === 'charts')
  if (index < 0 || plan.steps.slice(0, index).some(step => state.steps[step.id] !== 'completed')) {
    throw new Error('Runtime refresh requires completed preparation through proof materials')
  }

  if (Object.values(state.steps).some(status => status === 'running' || status === 'recovery-required')) {
    throw new Error('Resolve interrupted preparation before refreshing runtime configuration')
  }

  const configFile = localPath(root, '.data/doge-config.toml')
  const config = toml.parse(fs.readFileSync(configFile, 'utf8'))
  if (routingSpec) {
    let document: DeploymentSpec
    try {document = yaml.load(fs.readFileSync(path.resolve(routingSpec), 'utf8')) as DeploymentSpec} catch {throw new Error('Cannot read Dogecoin routing spec (values omitted)')}
    const routing = document?.dogecoin?.kubernetes
    if (document?.dogecoin?.network !== spec.dogecoin.network || !routing || typeof routing !== 'object' || Array.isArray(routing)) throw new Error('Routing spec must keep the planned Dogecoin network and provide dogecoin.kubernetes')
    const ports = new Set(['rpcPort', 'p2pPort', 'zmqHashBlockPort', 'zmqHashTxPort', 'zmqRawBlockPort', 'zmqRawTxPort'])
    for (const [key, value] of Object.entries(routing)) {
      if (key === 'serviceName') {
        if (typeof value !== 'string' || value.length > 63 || !/^[a-z](?:[\da-z-]*[\da-z])?$/.test(value)) throw new Error('Invalid Dogecoin Service name')
      } else if (!ports.has(key) || !Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) throw new Error('Unsupported Dogecoin routing field or invalid port')
    }

    const username = process.env.DOGECOIN_CLUSTER_RPC_USERNAME
    const password = process.env.DOGECOIN_CLUSTER_RPC_PASSWORD
    if (!username || !password) throw new Error('Dogecoin routing refresh requires DOGECOIN_CLUSTER_RPC_USERNAME and DOGECOIN_CLUSTER_RPC_PASSWORD')
    config.kubernetes = routing as toml.JsonMap
    config.dogecoinClusterRpc = {password, username}
  }

  const attestation = config.attestationSigner as toml.JsonMap | undefined
  if (attestation) delete attestation.policyValidation
  const history = localPath(root, `.scrollsdk/runtime-refresh/${Date.now()}-${process.pid}`)
  fs.mkdirSync(history, {mode: 0o700, recursive: true})
  for (const relative of ['.scrollsdk/state.json', '.data/doge-config.toml', '.data/proof-program-publication-v1.json', 'signer-policy-bundle']) {
    const source = localPath(root, relative)
    if (!fs.existsSync(source)) continue
    const destination = path.join(history, path.basename(relative))
    // Handoffs are immutable versions; move the old version into history so
    // export-signer-policy can create a new one without overwriting evidence.
    if (relative === 'signer-policy-bundle') fs.renameSync(source, destination)
    else fs.cpSync(source, destination, {recursive: true})
  }

  writeJson(path.join(history, 'request.json'), {
    dogecoinRouting: routingSpec ? config.kubernetes : null,
    planId: plan.id,
    restartFrom: 'charts',
  })
  // The original plan, identities, genesis, funding and baked materials stay pinned.
  // New publication evidence must come from another real publish/readback operation.
  privateWrite(configFile, toml.stringify(config))
  const publication = localPath(root, '.data/proof-program-publication-v1.json')
  if (fs.existsSync(publication)) fs.unlinkSync(publication)
  for (const step of plan.steps.slice(index)) delete state.steps[step.id]
  state.status = 'pending'
  delete state.currentStep
  delete state.waiting
}

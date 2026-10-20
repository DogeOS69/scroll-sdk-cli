/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic provider/Helm fixtures, no real credentials. */
import * as toml from '@iarna/toml'
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {verifyCubesignerActivation} from '../../src/utils/cubesigner-activation.js'
import {cubesignerPolicyEnvironment} from '../../src/utils/cubesigner-policy-receipts.js'

describe('mode-aware CubeSigner installation check', () => {
  let root: string
  let client: any
  let remote: any
  let workload: any
  let config: any
  let seed: string
  let delivered: string
  const keyId = 'Key#fixture'
  const roleId = 'Role#fixture'
  const writeConfig = () => fs.writeFileSync(path.join(root, '.data/doge-config.toml'), toml.stringify(config))
  const run = () => verifyCubesignerActivation({chart: 'fixture', chartVersion: '0.0.0', connect: async () => client, directory: root, kubeContext: 'fixture', namespace: 'default',
    readConfigMap: () => ({data: {'protocol_context.json': '{}'}}), readSecret: name => ({data: name.endsWith('-env') ? {DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID: Buffer.from(keyId).toString('base64')} : {'session.json': Buffer.from(delivered).toString('base64')}}), render: () => yaml.dump(workload), values: 'values/cubesigner-signer-production.yaml'})
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-transport-'))
    for (const dir of ['.data', 'values', 'secrets']) fs.mkdirSync(path.join(root, dir))
    const publicKey = new bitcore.PrivateKey().toPublicKey().toString()
    config = {cubesigner: {mode: 'transport_only', roles: [{keys: [{key_id: keyId, material_id: 'fixture-material', public_key_compressed: publicKey}], role_id: roleId}]}, network: 'regtest'}
    writeConfig()
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), '{}')
    fs.writeFileSync(path.join(root, 'values/cubesigner-signer-production.yaml'), '{}')
    const env: any[] = Object.entries({...cubesignerPolicyEnvironment({mode: 'transport_only', warnings: []}), CS_SESSIONS_DIR: '/app/.sessions', DOGEOS_CUBESIGNER_SIGNER_CS_SESSION_PATH: '/etc/cubesigner/session.json', DOGEOS_CUBESIGNER_SIGNER_NETWORK: 'regtest', DOGEOS_CUBESIGNER_SIGNER_PROTOCOL_CONTEXT_JSON: '/app/protocol_context.json'}).map(([name, value]) => ({name, value}))
    for (const name of ['DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_KEY_IDENTIFIER']) env.push({name, valueFrom: {secretKeyRef: {key: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', name: 'cubesigner-signer-env'}}})
    workload = {kind: 'Deployment', spec: {replicas: 1, template: {spec: {containers: [{env, volumeMounts: [{mountPath: '/app/protocol_context.json', name: 'context', readOnly: true, subPath: 'protocol_context.json'}, {mountPath: '/etc/cubesigner', name: 'session', readOnly: true}, {mountPath: '/app/.sessions', name: 'cache'}]}], volumes: [{configMap: {name: 'protocol-context-config'}, name: 'context'}, {name: 'session', secret: {secretName: 'cubesigner-signer-session'}}, {emptyDir: {}, name: 'cache'}]}}}}
    const expiration = Date.now() / 1000 + 3600
    seed = JSON.stringify({env: {'Dev-CubeSignerStack': {SignerApiRoot: 'https://fixture.invalid'}}, org_id: 'Org#fixture', role_id: roleId, session_exp: expiration, session_info: {refresh_token_exp: expiration, session_id: 'fixture-session'}, token: 'NONFUNCTIONAL_TEST'})
    delivered = seed
    fs.writeFileSync(path.join(root, 'secrets/cubesigner-signer-session.json'), seed)
    remote = {enabled: true, key_id: keyId, key_type: 'SecpDogeTestAddr', material_id: 'fixture-material', policy: [{RequireRoleSession: [roleId]}], public_key: publicKey}
    client = {apiRoot: 'https://fixture.invalid', environment: 'gamma', key: async () => remote, organization: 'Org#fixture', role: async () => ({enabled: true, role_id: roleId}), sessions: async () => [{exp: expiration, scopes: ['sign:btc:psbt:doge'], session_id: 'fixture-session'}]}
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  it('permits explicit regtest transport with fresh remote identity and delivered Secret checks', async () => {
    expect(await run()).include({activation: 'verified', installed: 'not-verified', mode: 'transport_only'})
  })
  for (const failure of ['mainnet', 'attached-policy', 'secret-drift', 'revoked', 'replicas', 'env-drift', 'production-without-receipts']) it(`blocks ${failure}`, async () => {
    if (failure === 'mainnet') {config.network = 'mainnet'; writeConfig()}
    if (failure === 'production-without-receipts') {config.cubesigner.mode = 'production_verifier_key_policy'; writeConfig()}
    if (failure === 'attached-policy') remote.policy.push('unreviewed/v1')
    if (failure === 'secret-drift') delivered = '{}'
    if (failure === 'revoked') client.sessions = async () => []
    if (failure === 'replicas') workload.spec.replicas = 2
    if (failure === 'env-drift') workload.spec.template.spec.containers[0].env[0].value = 'unexpected'
    let error: unknown
    try {await run()} catch (error_) {error = error_}
    expect(error).instanceOf(Error)
    expect(String(error)).not.include('NONFUNCTIONAL_TEST')
  })
})

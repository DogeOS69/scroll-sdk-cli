/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic provider/evidence fixtures. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {generateKeyPairSync, sign} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {bridgeHash, parseBridgeScript} from '../../src/utils/bridge-rotation.js'
import {importLiveAcceptance} from '../../src/utils/cubesigner-acceptance.js'
import {validateSignerEnvironment, verifyCubesignerActivation} from '../../src/utils/cubesigner-activation.js'
import {GOVERNANCE_CORE_REVISION, GOVERNANCE_INPUT, POLICY_EDIT_SCOPES, verifyRoleAttestation} from '../../src/utils/cubesigner-governance.js'
import {createGovernanceHandoff} from '../../src/utils/cubesigner-governance-handoff.js'
import {cubesignerPolicyEnvironment, resolveCubesignerPolicy} from '../../src/utils/cubesigner-policy-receipts.js'
import {reconcileCubesignerPolicy} from '../../src/utils/cubesigner-policy-reconcile.js'
import {prepareRuntimeSession} from '../../src/utils/cubesigner-session-preparation.js'
import {importPreparationPolicyReceipts} from '../../src/utils/preparation-policy-receipts.js'
import {proofFileHash} from '../../src/utils/proof-software-release.js'
import {generateValuesFiles} from '../../src/utils/values-generator.js'
import {policyReceiptFixture} from '../helpers/cubesigner-policy-receipts.js'

const MINIMAL = yaml.load(fs.readFileSync('test/fixtures/deployment-spec/minimal.yaml', 'utf8')) as any
const GOLDEN = JSON.parse(fs.readFileSync('test/fixtures/rotation-export/mainnet-example.json', 'utf8'))
const key = {keyId: 'Key#fixture', materialId: 'fixture', roleId: 'Role#fixture'}
const policyId = 'NamedPolicy#00000000-0000-0000-0000-000000000001'
const request = {body: {policy: [{RequireRoleSession: [key.roleId]}, `${policyId}/v2`]}, method: 'PATCH', path: `/v0/org/Org#fixture/keys/${key.keyId}`}
const rejects = async (run: () => Promise<unknown>, message: string) => {
  let error: unknown
  try {await run()} catch (error_) {error = error_}
  expect(error).instanceOf(Error)
  expect((error as Error).message).include(message)
}

describe('prepare expected CubeSigner policy and guard activation', () => {
  let root: string
  let input: any
  let remote: any
  let client: any
  let calls: string[]
  let env: any[]
  let handoff: any
  let approval: any
  let executed: any
  const pair = generateKeyPairSync('ec', {namedCurve: 'P-256'})
  const jwks = {keys: [{...pair.publicKey.export({format: 'jwk'}), alg: 'ES256', use: 'sig'}]}
  const write = (name: string, value: any) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true})
    fs.writeFileSync(path.join(root, name), JSON.stringify(value))
    return ref(name)
  }

  const ref = (name: string) => ({path: name, sha256: `sha256:${proofFileHash(path.join(root, name))}`})
  const claims = () => ({exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), query: {verbosity: 'Full'}, role_info: remote.role,
    role_keys: [{key_id: key.keyId, key_info: remote.key, role_id: key.roleId}], role_users: ['User#operator']})
  const jwt = (value: any) => {
    const unsigned = [Buffer.from(JSON.stringify({alg: 'ES256'})).toString('base64url'), Buffer.from(JSON.stringify(value)).toString('base64url')].join('.')
    return `${unsigned}.${sign('sha256', Buffer.from(unsigned), {dsaEncoding: 'ieee-p1363', key: pair.privateKey}).toString('base64url')}`
  }

  const prepare = () => {write('input.json', input); return reconcileCubesignerPolicy({connect: async () => client, directory: root, input: 'input.json', output: 'prepared-policy', prepareOnly: true})}
  const mounts = [{mountPath: '/app/protocol_context.json', name: 'context', readOnly: true, subPath: 'protocol_context.json'}, {mountPath: '/etc/cubesigner', name: 'session', readOnly: true}, {mountPath: '/app/.sessions', name: 'cache'}]
  const activate = (extra = {}) => verifyCubesignerActivation({async connect() {calls.push('provider'); return client}, directory: root, readConfigMap: () => ({data: {'protocol_context.json': fs.readFileSync(path.join(root, '.data/protocol_context.json'), 'utf8')}}), readSecret: name => ({data: name === 'cubesigner-signer-env' ? {DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID: Buffer.from(key.keyId).toString('base64')} : {'session.json': fs.readFileSync(path.join(root, 'secrets/cubesigner-signer-session.json')).toString('base64')}}), render() {
    calls.push('helm template')
    return yaml.dump({kind: 'Deployment', spec: {replicas: 1, template: {spec: {containers: [{env, name: 'signer', volumeMounts: mounts}], volumes: [{configMap: {name: 'protocol-context-config'}, name: 'context'}, {name: 'session', secret: {secretName: 'cubesigner-signer-session'}}, {emptyDir: {}, name: 'cache'}]}}}})
  }, ...extra})
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cubesigner-activation-test-'))
    calls = []
    policyReceiptFixture(root)
    const script = GOLDEN.current.redeem_script_hex
    const parsed = parseBridgeScript(script)
    write('.data/protocol_context.json', {genesis: {genesis_bridge_key_hash: bridgeHash(script)}})
    const context = ref('.data/protocol_context.json')
    fs.writeFileSync(path.join(root, 'policy.wasm'), Buffer.from([0, 97, 115, 109, 13, 0, 1, 0]))
    const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'))
    release.requiresLiveEvidence = false
    release.protocolContextSha256 = context.sha256
    release.wasm = {...ref('policy.wasm'), sizeBytes: 8}
    release.bindings = {aggregateVkIdentity: 'cd'.repeat(32), bridgeKeyHash: bridgeHash(script), bridgeProgramCommitment: 'ab'.repeat(32), namespaceId: parsed.namespace, proofArtifactBaseUrl: 'https://proofs.example.com/accepted', teePublicKey: parsed.tee}
    const bridgeProgram = write('bridge.vmexe', {synthetic: 'not a real proof'})
    const vk = write('aggregate-vk', {synthetic: 'test only'})
    release.verifierProvenance = {aggregateVerifyingKeySha256: vk.sha256, bridgeProgramSha256: bridgeProgram.sha256}
    release.tests = {...write('tests.json', {bindings: release.bindings, coreRevision: release.coreRevision, protocolContextSha256: context.sha256, result: 'passed', wasmSha256: release.wasm.sha256}), result: 'passed'}
    input = {aggregateVerifyingKey: vk, bridgeProgram, buildReceipt: write('build.json', {buildScript: {revision: 'e'.repeat(40), sha256: 'd'.repeat(64)}, coreRevision: release.coreRevision,
        protocolContext: {sha256: context.sha256.slice(7)}, schema: 'dogeos/cubesigner-policy-external-build/v1', wasm: {sha256: release.wasm.sha256.slice(7), sizeBytes: 8}}), environment: 'gamma', key, materials: write('materials.json', {bridge: {artifacts: {appExe: {sha256: bridgeProgram.sha256.slice(7)}}, identity: {programCommitmentHash: release.bindings.bridgeProgramCommitment, verificationKeyHash: release.bindings.aggregateVkIdentity}, protocolContextSha256: context.sha256.slice(7)}, schema: 'scrollsdk/proof-materials/v1', schemaVersion: 1, software: {artifacts: {aggregateVerifyingKey: {sha256: vk.sha256.slice(7)}}, identitySource: 'real_identity_probe'}}),
      organization: 'Org#fixture', publicBridge: write('bridge.json', {redeem_script_hex: script}),
      release}
    const config = {cubesigner: {mode: 'production_verifier_key_policy', roles: [{keys: [{key_id: key.keyId, material_id: key.materialId, public_key_compressed: parsed.tee}], role_id: key.roleId}]}, network: 'mainnet'}
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), toml.stringify(config))
    const council = {allowed_approvers: ['User#council'], allowed_mfa_types: ['Fido'], count: 1, lifetime: 300, num_auth_factors: 1}
    const full = {mfa: council}
    remote = {
      key: {acl: null, edit_policy: full, enabled: true, key_id: key.keyId, key_type: 'SecpDogeAddr', material_id: key.materialId, owner: 'User#owner', policy: request.body.policy, public_key: parsed.tee},
      policy: {acl: [{actions: ['read:*', 'attach'], subjects: ['User#owner']}, {actions: ['sign'], subjects: [key.roleId]}], attached_to: [{key_id: key.keyId}], edit_policy: {applies_to_scopes: {AllOf: POLICY_EDIT_SCOPES}, mfa: council}, name: 'dogeos-bridge', owner: 'User#owner', policy_id: policyId, policy_type: 'Wasm',
        rules: [{hash: release.wasm.sha256.replace('sha256:', '0x')}], version: 2},
      role: {edit_policy: full, enabled: true, name: 'fixture-role', role_id: key.roleId},
    }
    client = {apiRoot: 'https://api.example.com', attestation: async () => ({jwt: jwt(claims())}), authorities: async () => ['proofs.example.com'], environment: 'gamma',
      jwks: async () => jwks, key: async () => remote.key, organization: 'Org#fixture',
      policy: async () => remote.policy, role: async () => remote.role, sessions: async () => [{created_at: Date.now() / 1000 - 100, exp: Date.now() / 1000 + 300, lifetimes: {auth_lifetime: 300, refresh_lifetime: 86_400}, scopes: ['sign:btc:psbt:doge'], session_id: 'nonfunctional-test'}]}
    await prepare()
    importPreparationPolicyReceipts(root)
    const selected: any = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8'))
    env = Object.entries({...cubesignerPolicyEnvironment(resolveCubesignerPolicy({deploymentDir: root, keys: [key], network: 'mainnet', scope: 'preparation', selection: selected.cubesigner})), DOGEOS_CUBESIGNER_SIGNER_NETWORK: 'mainnet'}).map(([name, value]) => ({name, value}))
    env.push(...['DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_KEY_IDENTIFIER'].map(name => ({name, valueFrom: {secretKeyRef: {key: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', name: 'cubesigner-signer-env'}}})), ...Object.entries({CS_SESSIONS_DIR: '/app/.sessions', DOGEOS_CUBESIGNER_SIGNER_CS_SESSION_PATH: '/etc/cubesigner/session.json', DOGEOS_CUBESIGNER_SIGNER_PROTOCOL_CONTEXT_JSON: '/app/protocol_context.json'}).map(([name, value]) => ({name, value})))
    fs.mkdirSync(path.join(root, 'values'))
    fs.writeFileSync(path.join(root, 'values/cubesigner-signer-production.yaml'), yaml.dump({env}))
    fs.mkdirSync(path.join(root, 'withdrawal-processor'))
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), '[proof_system]\ncorrectness_policy_transport="bridge_proof_ref_v1"\nsigner_proof_artifact_base_url="https://proofs.example.com/accepted"\n')
    const at = new Date(Date.now() - 1000).toISOString()
    executed = {body: request.body, object_ids: {key_id: key.keyId, org_id: 'Org#fixture', policy_id: policyId, role_id: key.roleId}, operation: 'keyUpdate', outcome: {status: 'applied'}, target: key.keyId, timestamp: at}
    approval = {expires_at: Date.now() / 1000 + 300, id: 'mfa-fixture', request, status: {...council, approved_by: {'User#council': {Fido: {timestamp: Date.parse(at) / 1000}}}}}
    handoff = {approvals: [write('approval.json', approval)], config: write('gov.json', {approval: {allowed_mfa_types: ['Fido'], approvers: ['User#council'], count: 1, lifetime_seconds: 300, num_auth_factors: 1}, key: {type: 'SecpDogeAddr'}, key_owner: 'User#owner', key_proposers: [], operators: ['User#operator'], org_id: 'Org#fixture', policy: {name: 'dogeos-bridge'}, policy_publishers: [],
        role: {name: 'fixture-role'}}), coreRevision: GOVERNANCE_CORE_REVISION, environment: 'gamma', kind: 'sealed-upgrade', operations: write('operations.json', [{...executed, outcome: {ids: ['mfa-fixture'], status: 'needs-approval'}}, executed]),
      request,
      runtimeSession: {session: 3600},
      schema: 'scrollsdk/cubesigner-governance-handoff/v1', state: write('gov-state.json', {key_id: key.keyId, policy_id: policyId, role_id: key.roleId})}
    write(GOVERNANCE_INPUT, handoff)
    write('secrets/cubesigner-signer-session.json', {env: {'Dev-CubeSignerStack': {SignerApiRoot: client.apiRoot}}, org_id: 'Org#fixture', role_id: key.roleId, session_exp: Date.now() / 1000 + 300, session_info: {refresh_token_exp: Date.now() / 1000 + 300, session_id: 'nonfunctional-test'}, token: 'NONFUNCTIONAL_TEST'})
    fs.writeFileSync(path.join(root, 'secrets/cubesigner-signer.env'), `DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID="${key.keyId}"\n`)
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('prepares complete production pins without creating attachment receipts; strict resolution remains closed', () => {
    const selected: any = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8'))
    expect(selected.cubesigner.policyReceipts).equal(undefined)
    expect(fs.existsSync(path.join(root, 'prepared-policy/attachment.json'))).equal(false)
    expect(env.find(entry => entry.name.endsWith('POLICY_MODE')).value).equal('production_verifier_key_policy')
    expect(() => resolveCubesignerPolicy({deploymentDir: root, keys: [key], network: 'mainnet', selection: selected.cubesigner})).throw('requires release and attachment')
  })
  it('verifies current attachment, governance, rendered values and credentials without rebaking', async () => {
    const before = fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')
    const result = await activate()
    expect(result.activation).equal('verified')
    expect(result.acceptance).equal('not-verified')
    expect(result.installed).equal('not-verified')
    expect(calls).deep.equal(['helm template', 'provider'])
    expect(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')).equal(before)
  })
  it('does not authorize installation in policy-only mode', async () => {
    fs.rmSync(path.join(root, 'secrets'), {recursive: true})
    expect((await activate({policyOnly: true})).activation).equal('pending-runtime-session')
    await rejects(() => activate(), 'ENOENT')
  })
  for (const [name, mutate, message] of [
    ['old attachment', () => {remote.key.policy = [{RequireRoleSession: [key.roleId]}, `${policyId}/v1`]}, 'Attachment pending'],
    ['remote Wasm drift', () => {remote.policy.rules[0].hash = '0x' + '00'.repeat(32)}, 'Wasm mismatch'],
    ['Council drift', () => {remote.key.edit_policy = {mfa: {count: 99}}}, 'quorum'],
    ['role restriction drift', () => {remote.key.policy = [`${policyId}/v2`]}, 'Attachment pending'],
    ['rendered override', () => {env = [...env, {...env[0], value: 'override'}]}, 'Duplicate'],
    ['unscoped session', () => {client.sessions = async () => [{exp: Date.now() / 1000 + 300, scopes: ['sign:*'], session_id: 'nonfunctional-test'}]}, 'only the Dogecoin'],
  ] as const) it(`blocks ${name}`, async () => {mutate(); await rejects(() => activate(), message)})
  it('blocks a locally successful report after remote drift', async () => {await activate(); remote.key.enabled = false; await rejects(() => activate(), 'Attachment pending')})
  it('blocks approval without execution', async () => {
    handoff.operations = write('operations-pending.json', [{...executed, outcome: {ids: ['mfa-fixture'], status: 'needs-approval'}}]); write(GOVERNANCE_INPUT, handoff)
    await rejects(() => activate(), 'execution evidence pending')
  })
  for (const kind of ['expired', 'partial', 'wrong-request', 'missing-related']) it(`blocks ${kind} approvals`, async () => {
    if (kind === 'expired') approval.expires_at = 1
    if (kind === 'partial') approval.status.approved_by = {}
    if (kind === 'wrong-request') approval.request = {...request, method: 'POST'}
    if (kind === 'missing-related') approval.related_ids = ['missing']
    handoff.approvals = [write('approval-changed.json', approval)]; write(GOVERNANCE_INPUT, handoff)
    await rejects(() => activate(), kind === 'expired' ? 'expired' : kind === 'partial' ? 'pending' : kind === 'wrong-request' ? 'request mismatch' : 'Missing')
  })
  it('rejects expired, tampered and nested-key attestation mismatch', async () => {
    expect(() => verifyRoleAttestation(jwt({...claims(), exp: 1}), jwks)).throw('expired')
    const signed = jwt(claims()); expect(() => verifyRoleAttestation(signed.slice(0, -4) + 'AAAA', jwks)).throw('signature')
    client.attestation = async () => ({jwt: jwt({...claims(), role_keys: [{key_id: key.keyId, key_info: {...remote.key, policy: []}, role_id: key.roleId}]})})
    await rejects(() => activate(), 'Attested key policy')
  })
  it('rejects changed context/material bytes before contacting the provider', async () => {
    fs.appendFileSync(path.join(root, '.data/protocol_context.json'), ' ')
    await rejects(() => activate(), 'previous Bridge')
    expect(calls).deep.equal([])
  })
  it('rejects a conflicting duplicate explicit environment entry', () => {
    expect(() => validateSignerEnvironment([{name: 'PIN', value: 'a'}, {name: 'PIN', value: 'b'}], {PIN: 'a'})).throw('Duplicate')
  })
  it('reuses a valid session before attachment approval without provider mutation', async () => {
    remote.key.policy = [{RequireRoleSession: [key.roleId]}, `${policyId}/v1`]
    const result = await prepareRuntimeSession({client, async create() {throw new Error('unexpected mutation')}, directory: root})
    expect(result.status).equal('existing-session-reused')
  })
  it('creates one tightly scoped session before attachment approval and reuses it on retry', async () => {
    remote.key.policy = [{RequireRoleSession: [key.roleId]}, `${policyId}/v1`]
    handoff.approvals = []; handoff.operations = write('operations-empty.json', []); write(GOVERNANCE_INPUT, handoff)
    fs.rmSync(path.join(root, 'approval.json'))
    const seed = JSON.parse(fs.readFileSync(path.join(root, 'secrets/cubesigner-signer-session.json'), 'utf8'))
    fs.rmSync(path.join(root, 'secrets/cubesigner-signer-session.json'))
    let creates = 0
    const create = async (_role: string, _purpose: string, lifetimes: any) => {creates++; expect(lifetimes).deep.equal({auth: 300, grace: 30, refresh: 86_400, session: 3600}); return seed}
    expect((await prepareRuntimeSession({client, create, directory: root})).status).equal('session-prepared')
    expect((await prepareRuntimeSession({client, create, directory: root})).status).equal('existing-session-reused')
    expect(creates).equal(1)
  })
  it('blocks duplicate session creation after uncertain remote success', async () => {
    fs.rmSync(path.join(root, 'secrets/cubesigner-signer-session.json'))
    let creates = 0
    const create = async () => {creates++; throw new Error('connection lost')}
    await rejects(() => prepareRuntimeSession({client, create, directory: root}), 'connection lost')
    await rejects(() => prepareRuntimeSession({client, create, directory: root}), 'Interrupted creation')
    expect(creates).equal(1)
  })
  it('checks delivered cluster secrets rather than treating local file existence as delivery', async () => {
    await rejects(() => activate({readSecret: () => ({data: {}})}), 'Installed Secret key differs')
  })
  it('checks the effective key Secret indirection', async () => {
    env.find(entry => entry.name === 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID').valueFrom.secretKeyRef.name = 'different-key'
    await rejects(() => activate(), 'verified Secret reference')
  })
  it('requires seal-last evidence for initial provisioning without inventing an approval round', async () => {
    handoff.kind = 'initial-provisioning'; handoff.approvals = []
    handoff.operations = write('initial-operations.json', [executed])
    handoff.provisioning = write('provisioning.json', {keyId: key.keyId, schema: 'scrollsdk/cubesigner-initial-provisioning/v1', sealedBeforeBridgeRegistration: true, unregisteredAndUnfunded: true})
    write(GOVERNANCE_INPUT, handoff)
    expect((await activate()).governance.approvals).equal('not-required-initial-provisioning')
    handoff.provisioning = write('unsealed.json', {keyId: key.keyId, schema: 'scrollsdk/cubesigner-initial-provisioning/v1', unregisteredAndUnfunded: true})
    write(GOVERNANCE_INPUT, handoff)
    await rejects(() => activate(), 'seal-last')
  })

  it('recovers preparation publication after archive rename without fabricating attachment or mutating the provider', async () => {
    fs.rmSync(path.join(root, '.scrollsdk/inputs/cubesigner-policy/expected.json'))
    await prepare()
    expect(fs.existsSync(path.join(root, '.scrollsdk/inputs/cubesigner-policy/expected.json'))).equal(true)
    expect(fs.existsSync(path.join(root, 'prepared-policy/attachment.json'))).equal(false)
  })
  for (const field of ['policyIdentifier', 'programIdentityDigest', 'protocolContextSha256']) it(`blocks invalid expected ${field}`, async () => {
    input.release[field] = field === 'policyIdentifier' ? 'dogeos-bridge/latest' : 'unknown'
    write('invalid-input.json', input)
    await rejects(() => reconcileCubesignerPolicy({connect: async () => client, directory: root, input: 'invalid-input.json', output: 'invalid-policy', prepareOnly: true}), field === 'policyIdentifier' ? 'immutable' : field === 'programIdentityDigest' ? 'identity digest' : 'context')
    expect(fs.existsSync(path.join(root, 'invalid-policy'))).equal(false)
  })

  it('adapts actual Core JSONL and mfa RESULT output and preserves the exact request across resumes', () => {
    fs.writeFileSync(path.join(root, 'gov-log.jsonl'), JSON.stringify({...executed, outcome: {ids: ['mfa-fixture'], status: 'needs-approval'}}) + '\n' + JSON.stringify(executed) + '\n')
    fs.writeFileSync(path.join(root, 'core-mfa.txt'), JSON.stringify(approval, null, 2) + '\nRESULT: command=mfa applied=0 needs_approval=0 mfa_ids=\n')
    const args = {approval: ['core-mfa.txt'], config: 'gov.json', directory: root, kind: 'sealed-upgrade', operations: 'gov-log.jsonl', sessionLifetime: 3600, state: 'gov-state.json'}
    const result = createGovernanceHandoff(args)
    expect(result.outcomes.attachmentExecution).equal('recorded-not-verified')
    expect(result.outcomes.governance).equal('not-verified')
    expect(result.outcomes.approvals[0].status).equal('threshold-recorded-execution-required')
    expect(createGovernanceHandoff(args).evidence).equal(result.evidence)
    expect(() => createGovernanceHandoff({...args, sessionLifetime: 7200})).throw('changed')
  })
  it('imports late real acceptance without rebuilding context or rewriting unrelated values', async () => {
    const before = fs.readFileSync(path.join(root, '.data/protocol_context.json'))
    const report = {artifactStoreReadback: true, denialResponseSha256: 'sha256:' + 'c'.repeat(64), gatewayMode: 'production_verifier_key_policy',
      keyId: key.keyId, policyArtifactDigest: input.release.wasm.sha256, policyIdentifier: input.release.policyIdentifier,
      proofArtifactUrl: 'https://proofs.example.com/accepted/test-only', proofSha256: 'sha256:' + 'a'.repeat(64), protocolContextSha256: input.release.protocolContextSha256, realProofSigned: true, result: 'passed',
      schema: 'scrollsdk/cubesigner-live-acceptance/v1', signingResponseSha256: 'sha256:' + 'b'.repeat(64), tamperedProofDeniedBeforeNativeSigning: true, wpTransport: 'bridge_proof_ref_v1'}
    write('reviewed-live.json', report)
    importLiveAcceptance(root, 'reviewed-live.json')
    importLiveAcceptance(root, 'reviewed-live.json')
    expect(fs.readFileSync(path.join(root, '.data/protocol_context.json')).equals(before)).equal(true)
    const values: any = yaml.load(fs.readFileSync(path.join(root, 'values/cubesigner-signer-production.yaml'), 'utf8'))
    expect(values.env.find((entry: any) => entry.name.endsWith('_NETWORK')).value).equal('mainnet')
    write('fake-live.json', {...report, realProofSigned: false})
    expect(() => importLiveAcceptance(root, 'fake-live.json')).throw('incomplete')
  })

  it('renders the actual generator production values before attachment approval', () => {
    const selected: any = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8'))
    const spec = structuredClone(MINIMAL)
    spec.dogecoin.network = 'mainnet'
    spec.signing.cubesigner = {...selected.cubesigner, roles: [{keys: [{keyId: key.keyId, materialId: key.materialId, publicKeyCompressed: selected.cubesigner.roles[0].keys[0].public_key_compressed}], roleId: key.roleId}]}
    const previous = process.cwd()
    try {
      process.chdir(root)
      const files = generateValuesFiles(spec)
      const signer: any = yaml.load(files['cubesigner-signer-production.yaml'])
      const emitted = Object.fromEntries(signer.env.map((entry: any) => [entry.name, entry.value]))
      expect(emitted.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_IDENTIFIER).equal(input.release.policyIdentifier)
      expect(emitted.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_ARTIFACT_DIGEST).equal(input.release.wasm.sha256)
      expect(emitted.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_MODE).equal('production_verifier_key_policy')
      expect(fs.existsSync(path.join(root, 'prepared-policy/attachment.json'))).equal(false)
    } finally {process.chdir(previous)}
  })
  it('blocks a different context delivered to the target cluster', async () => {
    await rejects(() => activate({readConfigMap: () => ({data: {'protocol_context.json': '{}'}})}), 'Delivered protocol context')
  })
  for (const kind of ['revoked', 'expired']) it(`blocks a ${kind} session after governance succeeds`, async () => {
    if (kind === 'revoked') client.sessions = async () => []
    else {const seed = JSON.parse(fs.readFileSync(path.join(root, 'secrets/cubesigner-signer-session.json'), 'utf8')); seed.session_exp = 1; write('secrets/cubesigner-signer-session.json', seed)}

    await rejects(() => activate(), kind === 'revoked' ? 'revoked' : 'expired')
  })

  it('accepts explicitly bound governed canary evidence without relabeling it production signing', async () => {
    const report = {artifactStoreReadback: true, canaryGovernanceVerified: true, canaryKeyType: 'SecpDogeAddr', canaryUnregisteredAndUnfunded: true,
      denialResponseSha256: 'sha256:' + 'c'.repeat(64), gatewayMode: 'production_verifier_key_policy', keyId: 'Key#canary-fixture', policyArtifactDigest: input.release.wasm.sha256, policyIdentifier: input.release.policyIdentifier, productionBindingReviewed: true,
      proofArtifactUrl: 'https://proofs.example.com/accepted/test-only', proofSha256: 'sha256:' + 'a'.repeat(64),
      protocolContextSha256: input.release.protocolContextSha256, realProofSigned: true, result: 'passed', schema: 'scrollsdk/cubesigner-live-acceptance/v1', scope: 'canary',
      signingResponseSha256: 'sha256:' + 'b'.repeat(64), tamperedProofDeniedBeforeNativeSigning: true, targetKeyId: key.keyId, wpTransport: 'bridge_proof_ref_v1'}
    write('canary.json', report)
    expect(importLiveAcceptance(root, 'canary.json').status).equal('reviewed-acceptance-imported')
    const selected: any = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8'))
    const archived = JSON.parse(fs.readFileSync(path.join(root, selected.cubesigner.expectedPolicy.liveEvidence.path), 'utf8'))
    expect(archived.scope).equal('canary')
    expect(archived.keyId).not.equal(archived.targetKeyId)
    env = (yaml.load(fs.readFileSync(path.join(root, 'values/cubesigner-signer-production.yaml'), 'utf8')) as any).env
    expect((await activate()).acceptance).equal('canary-evidence-validated-production-not-verified')
    write('unreviewed-canary.json', {...report, productionBindingReviewed: false})
    expect(() => importLiveAcceptance(root, 'unreviewed-canary.json')).throw('reviewed production binding')
  })

})

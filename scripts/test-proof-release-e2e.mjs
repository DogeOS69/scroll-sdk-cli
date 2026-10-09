// Real release consumer rehearsal. Requires Docker, a canonical public protocol
// context and an SDK checkout. No AWS writes, chain transactions or GPU rental.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

import {resolvePreparationProofRelease} from '../dist/utils/preparation-release.js';
import {CommandPreparationRunner} from '../dist/utils/preparation-runner.js';
import {readProofMaterials} from '../dist/utils/proof-materials.js';
import {readProofSoftwareRelease} from '../dist/utils/proof-software-release.js';
import {compileProofTopology} from '../dist/utils/proof-topology-compiler.js';

const [version, contextInput, sdkInput] = process.argv.slice(2);
if (!version || !contextInput || !sdkInput) throw new Error('Usage: node scripts/test-proof-release-e2e.mjs VERSION PROTOCOL_CONTEXT SDK_CHECKOUT');
const require = createRequire(import.meta.url);
const toml = require('@iarna/toml');
process.umask(0o077);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-release-consumer-'));
const sdk = path.resolve(sdkInput);
fs.mkdirSync(path.join(root, '.data'));
fs.copyFileSync(path.resolve(contextInput), path.join(root, '.data/protocol_context.json'));
fs.writeFileSync(path.join(root, '.data/doge-config.toml'), 'network = "testnet"\n');
const revision = execFileSync('git', ['-C', sdk, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
for (const file of ['withdrawal-processor/WithdrawalProcessor.toml', 'proof-coordinator/ProofCoordinator.toml']) {
  const contents = execFileSync('git', ['-C', sdk, 'show', `${revision}:examples/${file}`]);
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), contents);
}
const spec = await resolvePreparationProofRelease({
  metadata: {name: 'real-release-rehearsal'},
  preparation: {bridge: {mode: 'production'}, proofRelease: {version}, proofMaterials: {mode: 'real'}},
  proofTopology: {
    mode: 'active', generation: 'real', enforcement: 'enforce', observeRealProofDeadlineMs: 1800000,
    deployment: {artifactKeyPrefix: 'test/proofs', proverPublicUrl: 'https://proof.example.invalid'},
    active: {profile: 'real_scroll_withdrawal_full_topology', workerLaunch: 'external',
      artifactStore: {kind: 's3_compatible', bucket: 'nonfunctional-proof-rehearsal', region: 'us-west-2', endpointUrl: 'https://s3.us-west-2.amazonaws.com'},
      realScroll: {chunkWitnessSource: 'rpc', chunkWitnessRpcUrl: 'http://l2-rpc:8545'}},
  },
}, root);
const selected = readProofSoftwareRelease(spec.preparation.proofRelease.manifest, spec.preparation.proofRelease.sha256);
console.log(JSON.stringify({root, release: version, coreRevision: selected.manifest.revision, sdkRevision: revision}));
const runner = new CommandPreparationRunner();
for (const id of ['proof-release-bake', 'proof-materializer-export', 'proof-worker-check', 'proof-materials']) {
  console.log(JSON.stringify({step: id, status: 'running'}));
  await runner.run({id, effect: 'local', retry: 'safe', title: id}, spec, root, {});
  console.log(JSON.stringify({step: id, status: 'passed'}));
}
const materials = readProofMaterials(path.join(root, '.data/proof-materials-v1.json'), root);
assert.equal(materials.software.sourceRevisions.dogeosCore, selected.manifest.revision);
assert.ok(materials.software.compilerIdentity);
assert.ok(materials.bridge.artifacts.workerIdentityBundle);
const topology = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')).proof_topology;
const bundle = compileProofTopology({deploymentDir: root, deploymentName: spec.metadata.name, network: 'testnet', proofTopology: topology});
fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify({
  schema: 'scrollsdk/proof-release-consumer-validation/v1', coreRevision: selected.manifest.revision,
  releaseSha256: selected.sha256, sdkRevision: revision,
  bundleRevision: bundle.manifest.bundle_revision, result: 'passed',
  scope: 'official release lookup, offline real bake, materializer export, CUDA identity check, material import, real/enforce topology compilation; no GPU proof, publication or partner acceptance',
}, null, 2) + '\n');
console.log(JSON.stringify({root, result: 'passed', bundleRevision: bundle.manifest.bundle_revision}));

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {ProofProgramPublicationV1} from '../../src/types/proof-program-publication.js'
import type {ProofWorkerImageCheckV1} from '../../src/types/proof-worker-image-check.js'
import type {ProverWorkerContractV1} from '../../src/utils/proof-topology-compiler.js'

export function capacityWorkerFixture() {
  const image = {digest: `sha256:${'a'.repeat(64)}`, repository: 'example.invalid/worker'}
  const spec = {metadata: {name: 'test-deployment'}, preparation: {dstack: {project: 'test'}}} as DeploymentSpec
  const paths = ['batch/openvm.toml', 'batch/app.vmexe', 'bridge/openvm.toml', 'bridge/bridge-state.vmexe', 'bridge/bridge-artifact-manifest.json', 'chunk/openvm.toml', 'chunk/app.vmexe', 'bridge/batch-aggregation-openvm.toml', 'bridge/batch-aggregation.vmexe', 'bridge/l2-range-aggregation-topology-program.json', 'protocol_context.json']
  const publication = {files: Object.fromEntries(paths.map(p => [p, {sha256: 'b'.repeat(64), url: `https://artifacts.example.invalid/${p}`} ])), verification: {anonymousHttpReadback: 'passed', authenticatedS3Readback: 'passed'}} as ProofProgramPublicationV1
  const worker = {argv: ['--worker-id', 'original', '--worker-token-file', '/secret', '--drain-timeout-ms', '720000', '--chunk-app-exe', '/old/chunk', '--enable-prove-scroll-chunk'], image, required_build_class: 'production'} as ProverWorkerContractV1
  const imageCheck = {cudaArchitectures: ['86'], image} as ProofWorkerImageCheckV1
  const target = {authKey: 'token', authSecret: 'dstack-auth', context: 'test-context', deployment: 'dstack-controller', image: `example.invalid/controller@sha256:${'c'.repeat(64)}`, namespace: 'test', port: 3000}
  const input = {generationId: 'd'.repeat(64), imageCheck, publication, session: 'initial', spec, target, worker}
  return input
}

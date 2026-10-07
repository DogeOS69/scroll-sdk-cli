import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const cli = path.resolve('bin/run.js')
const tools = path.resolve('test/fixtures/bootnode-public-tools.mjs')
const cluster = 'test-cluster-with-a-long-name-for-public-bootnodes'
const annotation = 'service.beta.kubernetes.io/aws-load-balancer-'
interface Call {args: string[]; tool: string}
interface Values {global: {fullnameOverride: string}; reth: {ports: {p2p: number}; service: {extra: {p2p: {annotations: Record<string, string>; ports: Record<string, {port: number; protocol: string}>; type: string}}}}}

describe('setup bootnode-public-p2p CLI integration', () => {
  let root: string
  const file = (index: number) => path.join(root, 'values', `l2-reth-bootnode-production-${index}.yaml`)
  const calls = (): Call[] => fs.existsSync(path.join(root, 'calls.jsonl')) ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const run = (extra: string[] = [], fail = '', base = true) => spawnSync(process.execPath, [cli, 'setup', 'bootnode-public-p2p', '-N', '--json', ...(base ? ['--provider', 'aws', '--cluster-name', cluster, '--region', 'us-east-1'] : []), ...extra], {
    cwd: root, encoding: 'utf8', env: {...process.env, BOOTNODE_FAIL: fail, BOOTNODE_TEST_ROOT: root, KUBECONFIG: path.join(root, 'operator-kubeconfig'), PATH: `${path.join(root, 'bin')}:${process.env.PATH}`}, timeout: 30_000,
  })
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootnode-public-p2p-'))
    for (const dir of ['.data', 'values', 'bin']) fs.mkdirSync(path.join(root, dir))
    fs.writeFileSync(path.join(root, 'operator-kubeconfig'), 'operator context must remain untouched')
    for (const name of ['aws', 'eksctl', 'kubectl', 'helm', 'curl']) {
      const target = path.join(root, 'bin', name)
      fs.copyFileSync(tools, target)
      fs.chmodSync(target, 0o700)
    }

    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), toml.stringify({bootnodeReth: {instances: [{index: 3}, {index: 0}]}, network: 'testnet', wallet: {path: '.data/wallet.json'}}))
    for (const index of [0, 3]) fs.writeFileSync(file(index), yaml.dump({
      global: {fullnameOverride: `l2-reth-bootnode-${index}`}, reth: {ports: {p2p: 30_303 + index}, service: {extra: {p2p: {annotations: {'operator.example/keep': 'yes'}}}}},
      role: 'bootnode',
    }))
    fs.writeFileSync(path.join(root, 'values/l2-bootnode-production-0.yaml'), 'legacy: untouched\n')
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('returns clean JSON, selects the requested cluster, and prepares indexed TCP/UDP Services', () => {
    const result = run(['--namespace', 'nodes'])
    expect(result.status, result.stderr).to.equal(0)
    const output = JSON.parse(result.stdout)
    expect(output.data).to.include({bootnodeCount: 2, deployed: false, namespace: 'nodes'})
    expect(output.data.bootnodeIndices).to.deep.equal([0, 3])
    for (const index of [0, 3]) {
      const values = yaml.load(fs.readFileSync(file(index), 'utf8')) as Values
      const {p2p} = values.reth.service.extra
      expect(p2p.type).to.equal('LoadBalancer')
      expect(p2p.annotations).to.include({[annotation + 'enable-tcp-udp-listener']: 'true', [annotation + 'scheme']: 'internet-facing', [annotation + 'type']: 'external', 'operator.example/keep': 'yes'})
      expect(p2p.annotations[annotation + 'name'].length).to.be.at.most(32)
      expect(p2p.ports['p2p-tcp']).to.include({port: 30_303 + index, protocol: 'TCP'})
      expect(p2p.ports['p2p-udp']).to.include({port: 30_303 + index, protocol: 'UDP'})
    }

    expect(fs.readFileSync(path.join(root, 'values/l2-bootnode-production-0.yaml'), 'utf8')).to.equal('legacy: untouched\n')
    expect(fs.readFileSync(path.join(root, 'operator-kubeconfig'), 'utf8')).to.equal('operator context must remain untouched')
    const events = calls()
    for (const event of events.filter(item => (item.tool === 'kubectl' && !item.args.includes('version')) || (item.tool === 'helm' && item.args.includes('upgrade')))) {
      expect(event.args).to.include('--kubeconfig')
      expect(fs.existsSync(event.args[event.args.indexOf('--kubeconfig') + 1])).to.equal(false)
    }

    expect(events.find(item => item.tool === 'curl' && item.args.includes('-o'))?.args.at(-1)).to.include('/v2.14.0/docs/install/iam_policy.json')
    const install = events.find(item => item.tool === 'helm' && item.args.includes('upgrade'))!
    expect(install.args[install.args.indexOf('--version') + 1]).to.equal('1.14.0')
  })

  it('reuses a ready controller without IAM or Helm mutations and is idempotent', () => {
    const first = run(['--skip-controller-setup'])
    expect(first.status, first.stderr).to.equal(0)
    const before = [0, 3].map(index => fs.readFileSync(file(index), 'utf8'))
    const second = run(['--skip-controller-setup'])
    expect(second.status, second.stderr).to.equal(0)
    expect([0, 3].map(index => fs.readFileSync(file(index), 'utf8'))).to.deep.equal(before)
    expect(calls().some(item => ['curl', 'eksctl', 'helm'].includes(item.tool) || item.args[0] === 'iam')).to.equal(false)
  })

  it('renders a dedicated public Service with the actual Reth chart', function () {
    const chart = path.resolve('../scroll-sdk/charts/l2-reth')
    if (!fs.existsSync(chart) || spawnSync('helm', ['version']).status !== 0) this.skip()
    const result = run(['--skip-controller-setup'])
    expect(result.status, result.stderr).to.equal(0)
    for (const index of [0, 3]) {
      const rendered = spawnSync('helm', ['template', `l2-reth-bootnode-${index}`, chart, '-n', 'nodes', '-f', file(index)], {encoding: 'utf8'})
      expect(rendered.status, rendered.stderr).to.equal(0)
      const resources = yaml.loadAll(rendered.stdout) as {kind: string; metadata: {name: string}; spec: {ports: {port: number; protocol: string}[]; type: string}}[]
      const service = resources.find(item => item?.kind === 'Service' && item.metadata.name === `l2-reth-bootnode-${index}-p2p`)!
      expect(service.spec.type).to.equal('LoadBalancer')
      expect(service.spec.ports.map(port => [port.protocol, port.port])).to.deep.equal([['TCP', 30_303 + index], ['UDP', 30_303 + index]])
    }
  })

  for (const args of [[], ['--provider', 'aws'], ['--provider', 'aws', '--cluster-name', 'test']]) {
    it(`rejects missing non-interactive flags before provider calls: ${args.join(' ') || 'none'}`, () => {
      const result = run(args, '', false)
      expect(result.status).not.to.equal(0)
      expect(JSON.parse(result.stdout).error.code).to.equal('E601_MISSING_FIELD')
      expect(calls()).to.deep.equal([])
    })
  }

  it('rejects missing indexed values before provider calls or changes to other files', () => {
    const before = fs.readFileSync(file(0), 'utf8')
    fs.unlinkSync(file(3))
    const result = run()
    expect(result.status).not.to.equal(0)
    expect(JSON.parse(result.stdout).error.message).to.include('run setup prep-charts first')
    expect(calls()).to.deep.equal([])
    expect(fs.readFileSync(file(0), 'utf8')).to.equal(before)
  })

  for (const failure of ['oidc', 'iam', 'controller', 'context']) {
    it(`propagates ${failure} failures without writing values`, () => {
      const before = [0, 3].map(index => fs.readFileSync(file(index), 'utf8'))
      const result = run([], failure)
      expect(result.status).not.to.equal(0)
      expect(JSON.parse(result.stdout).success).to.equal(false)
      expect([0, 3].map(index => fs.readFileSync(file(index), 'utf8'))).to.deep.equal(before)
      if (failure === 'context') expect(calls().some(item => item.tool === 'kubectl' && item.args.includes('wait'))).to.equal(false)
    })
  }

  it('accepts an existing versioned IAM policy only for EntityAlreadyExists', () => {
    const result = run([], 'existing-policy')
    expect(result.status, result.stderr).to.equal(0)
    expect(calls().some(item => item.args[0] === 'iam' && item.args[1] === 'get-policy')).to.equal(true)
  })

  it('rejects legacy Service ownership before cloud calls rather than changing a live annotation', () => {
    const values = yaml.load(fs.readFileSync(file(0), 'utf8')) as Values
    values.reth.service.extra.p2p.annotations[annotation + 'type'] = 'nlb'
    fs.writeFileSync(file(0), yaml.dump(values))
    const result = run()
    expect(result.status).not.to.equal(0)
    expect(JSON.parse(result.stdout).error.message).to.include('legacy load balancer ownership')
    expect(calls()).to.deep.equal([])
  })

  it('reports GCP as unsupported without side effects', () => {
    const result = run(['--provider', 'gcp'], '', false)
    expect(JSON.parse(result.stdout).error.message).to.include('not implemented')
    expect(calls()).to.deep.equal([])
  })
})

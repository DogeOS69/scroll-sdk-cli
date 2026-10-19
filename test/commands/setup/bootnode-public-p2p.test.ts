/* eslint-disable @typescript-eslint/no-explicit-any, unicorn/prefer-switch -- Simulated deployment values and failure cases. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {fixture} from '../../fixtures/existing-nlb.js'

const cli = path.resolve('bin/run.js')

describe('setup bootnode-public-p2p CLI integration', () => {
  let root: string
  let f: any
  const file = (index = 0) => path.join(root, 'values', `l2-reth-bootnode-production-${index}.yaml`)
  const run = (extra: string[] = []) => spawnSync(process.execPath, [cli, 'setup', 'bootnode-public-p2p', '--spec', 'deployment-spec.yaml', '--json', ...extra], {
    cwd: root, encoding: 'utf8', env: {...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`}, timeout: 30_000,
  })
  const saveSpec = () => fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), yaml.dump(f.spec))
  const calls = (): string[][] => fs.existsSync(path.join(root, 'calls.jsonl')) ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootnode-public-p2p-'))
    f = fixture()
    delete f.entry.mode; delete f.entry.subnets; delete f.entry.eipAllocations
    delete f.entry.existingNlb.loadBalancerArn; delete f.entry.existingNlb.listenerArn
    for (const dir of ['.data', 'values', 'bin']) fs.mkdirSync(path.join(root, dir))
    saveSpec()
    fs.writeFileSync(path.join(root, 'responses.json'), JSON.stringify(f.responses))
    fs.writeFileSync(path.join(root, 'bin/aws'), `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
const responses = JSON.parse(fs.readFileSync('responses.json', 'utf8'));
const response = responses[args.slice(0, 2).join(' ')];
if (!response) { console.error('UNEXPECTED MUTATION'); process.exit(99); }
console.log(JSON.stringify(response));
`, {mode: 0o700})
    for (const tool of ['kubectl', 'helm', 'eksctl', 'curl']) fs.writeFileSync(path.join(root, 'bin', tool), '#!/bin/sh\necho UNEXPECTED_TOOL >&2\nexit 99\n', {mode: 0o700})
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), `[[bootnodeReth.instances]]\nindex = 0\nenodeUrl = "enode://${'ab'.repeat(64)}@l2-reth-bootnode-0:30303"\n`)
    fs.writeFileSync(file(), yaml.dump({image: {tag: 'keep-me'}, resources: {requests: {cpu: '2'}}, reth: {extraArgs: ['--custom-flag'], nodeKey: {mode: 'secret', secretName: 'existing-key'}, p2pExternal: {enabled: false}}, role: 'bootnode'}), {mode: 0o600})
    fs.writeFileSync(file(1), '# unselected node remains untouched\n')
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('updates only selected P2P bindings, prints public enodes, preserves identity and is idempotent', () => {
    const before = yaml.load(fs.readFileSync(file(), 'utf8')) as any
    const specBefore = fs.readFileSync(path.join(root, 'deployment-spec.yaml'), 'utf8')
    const identityBefore = fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')
    const result = run()
    expect(result.status, result.stderr).to.equal(0)
    const output = JSON.parse(result.stdout)
    expect(output).to.include({deployed: false, dryRun: false, verified: true})
    expect(output.endpoints[0].enodes).to.deep.equal([`enode://${'ab'.repeat(64)}@198.51.100.10:30303`])
    const after = yaml.load(fs.readFileSync(file(), 'utf8')) as any
    expect(after.reth.p2pExternal).to.deep.equal({enabled: true, existingNlb: {securityGroupIds: f.entry.existingNlb.securityGroupIds, targetGroupARN: f.entry.existingNlb.targetGroupArn}, mode: 'existing', ordinal: 0})
    delete before.reth.p2pExternal; delete after.reth.p2pExternal
    expect(after).to.deep.equal(before)
    expect(fs.statSync(file()).mode % 0o1000).to.equal(0o600)
    expect(fs.readFileSync(file(1), 'utf8')).to.equal('# unselected node remains untouched\n')
    expect(fs.readFileSync(path.join(root, 'deployment-spec.yaml'), 'utf8')).to.equal(specBefore)
    expect(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')).to.equal(identityBefore)
    const contents = fs.readFileSync(file(), 'utf8')
    const second = run()
    expect(second.status, second.stderr).to.equal(0)
    expect(JSON.parse(second.stdout).changedFiles).to.deep.equal([])
    expect(fs.readFileSync(file(), 'utf8')).to.equal(contents)
    expect(calls().every(args => /^(describe-|get-caller-identity)/.test(args[1]))).to.equal(true)
  })

  it('dry-run validates AWS and public identity without writing values', () => {
    const before = fs.readFileSync(file(), 'utf8')
    const result = run(['--dry-run'])
    expect(result.status, result.stderr).to.equal(0)
    expect(JSON.parse(result.stdout).dryRun).to.equal(true)
    expect(JSON.parse(result.stdout).changedFiles).to.have.length(1)
    expect(fs.readFileSync(file(), 'utf8')).to.equal(before)
    expect(calls().length).to.be.greaterThan(0)
  })

  for (const scenario of ['missing values', 'missing identity', 'wrong SG', 'no fixed EIP', 'legacy Service', 'invalid YAML', 'invalid spec']) {
    it(`preserves all original values on ${scenario}`, () => {
      if (scenario === 'missing values') {
        f.spec.bootnodePublicP2p.push({enabled: false, index: 1}); saveSpec(); fs.unlinkSync(file(1))
      } else if (scenario === 'missing identity') fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '[[bootnodeReth.instances]]\nindex = 0\n')
      else if (scenario === 'wrong SG') {f.responses['elbv2 describe-load-balancers'].LoadBalancers[0].SecurityGroups = ['sg-11111111']; fs.writeFileSync(path.join(root, 'responses.json'), JSON.stringify(f.responses))}
      else if (scenario === 'no fixed EIP') {delete f.responses['elbv2 describe-load-balancers'].LoadBalancers[0].AvailabilityZones[0].LoadBalancerAddresses[0].AllocationId; fs.writeFileSync(path.join(root, 'responses.json'), JSON.stringify(f.responses))}
      else if (scenario === 'legacy Service') fs.writeFileSync(file(), yaml.dump({reth: {service: {extra: {p2p: {enabled: true, type: 'LoadBalancer'}}}}, role: 'bootnode'}))
      else if (scenario === 'invalid spec') fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), 'malformed: [\nPRIVATE_FILE_CONTENT\n')
      else fs.writeFileSync(file(), 'malformed: [\nPRIVATE_FILE_CONTENT\n')
      const before = fs.readFileSync(file(), 'utf8')
      const result = run()
      expect(result.status).not.to.equal(0)
      expect(result.stderr).not.to.include('PRIVATE_FILE_CONTENT')
      expect(fs.readFileSync(file(), 'utf8')).to.equal(before)
      expect(fs.readdirSync(root).some(name => name.includes('scrollsdk-generation'))).to.equal(false)
    })
  }

  it('renders the generated values as a ClusterIP Service and TargetGroupBinding', function () {
    const chart = process.env.SCROLLSDK_TEST_SDK_CHART
    if (!chart) this.skip()
    const result = run()
    expect(result.status, result.stderr).to.equal(0)
    const rendered = spawnSync('helm', ['template', 'l2-reth-bootnode-0', chart!, '-f', file()], {encoding: 'utf8'})
    expect(rendered.status, rendered.stderr).to.equal(0)
    const objects = yaml.loadAll(rendered.stdout) as any[]
    expect(objects.some(object => object?.spec?.type === 'LoadBalancer')).to.equal(false)
    expect(objects.find(object => object?.kind === 'TargetGroupBinding').spec.targetGroupARN).to.equal(f.entry.existingNlb.targetGroupArn)
  })
})

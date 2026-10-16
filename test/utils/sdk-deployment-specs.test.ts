/* eslint-disable @typescript-eslint/no-explicit-any -- Cross-repository Helm documents. */
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {assertDeploymentSpecFields} from '../../src/utils/deployment-spec-fields.js'
import {ALB_SERVICES, projectExistingAlbDirectory, validateExistingAlbSdk} from '../../src/utils/existing-alb.js'
import {loadSdkTemplateFiles, mergeBootstrapValues} from '../../src/utils/spec-bootstrap.js'
import {generateValuesFiles} from '../../src/utils/values-generator.js'

describe('paired SDK deployment starters', () => {
  for (const network of ['mainnet', 'testnet']) it(`renders all ${network} starter bindings through the pinned application charts`, function () {
    const examples = process.env.SCROLLSDK_TEST_DEPLOYMENT_SPECS
    const charts = process.env.SDK_ALB_CHARTS
    if (!examples || !charts) this.skip()
    const sdk = path.dirname(charts!)
    const spec = yaml.load(fs.readFileSync(path.join(examples!, `deployment-spec.${network}.example.yaml`), 'utf8')) as DeploymentSpec
    assertDeploymentSpecFields(spec)
    expect(execFileSync('git', ['-C', sdk, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), 'render the exact chart revision selected by the starter').eq(spec.templates!.sdkRevision)
    // Replace only external operator inputs; retain the starter's real topology,
    // binding keys, Service references, fee settings and template revision.
    const aws = spec.infrastructure.aws!
    aws.accountId = '000000000000'
    const prefix = `arn:aws:elasticloadbalancing:${aws.region}:${aws.accountId}:`
    for (const [index, endpoint] of Object.values(aws.alb!.endpoints).entries()) {
      const id = String(index).padStart(16, '0')
      endpoint.loadBalancerArn = `${prefix}loadbalancer/app/fixture-${index}/${id}`
      endpoint.listenerArn = `${prefix}listener/app/fixture-${index}/${id}/1111111111111111`
    }

    for (const [index, binding] of Object.values(aws.alb!.bindings).entries()) binding.targetGroupArn = `${prefix}targetgroup/fixture-${index}/${String(index).padStart(16, '0')}`
    spec.contracts.feeVaultDogeRecipientAddress = new bitcore.PrivateKey(null, network === 'mainnet' ? bitcore.Networks.livenet : bitcore.Networks.testnet).toAddress().toString()
    for (const signer of spec.attestationSigners ?? []) {
      signer.attestationPubkey = new bitcore.PrivateKey().toPublicKey().toString()
      signer.transportPubkey = new bitcore.PrivateKey().toPublicKey().toString()
    }

    validateExistingAlbSdk(sdk, spec)
    expect(Object.keys(aws.alb!.bindings).sort()).deep.eq(Object.keys(ALB_SERVICES).sort())
    const templates = loadSdkTemplateFiles(sdk, spec.templates!.sdkRevision).files
    const generated = generateValuesFiles(spec, templates['values/scroll-monitor-production.yaml'], {bootstrap: true})
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-starter-render-'))
    try {
      for (const [file, template] of Object.entries(templates)) {
        if (file.startsWith('values/') && file.endsWith('.yaml')) fs.writeFileSync(path.join(directory, path.basename(file)), mergeBootstrapValues(template, generated[path.basename(file)] ?? '{}'))
      }

      projectExistingAlbDirectory(directory, spec, true)
      const releases: Record<string, string> = {blockscout: 'blockscout', frontends: 'frontends', 'l2-reth-rpc-public': 'l2-reth', 'proof-coordinator': 'proof-coordinator', 'tso-service': 'tso-service'}
      let count = 0
      for (const [release, chart] of Object.entries(releases)) {
        const file = path.join(directory, `${release}-production.yaml`)
        const values = yaml.load(fs.readFileSync(file, 'utf8')) as any
        if (release === 'tso-service') values.networkPolicy.allowFrom.edge = [{ipBlock: {cidr: '192.0.2.0/24'}}]
        if (release === 'proof-coordinator') values.proofCoordinator.config.existingConfigMap = 'fixture-proof-config'
        // Template genesis/identity placeholders are filled by later stages;
        // chart defaults suffice to verify application Service/binding wiring.
        const output = execFileSync('helm', ['template', release, path.join(charts!, chart), '-n', spec.infrastructure.namespace!, '-f', '-'], {encoding: 'utf8', input: yaml.dump(values)})
        const objects = yaml.loadAll(output).filter(Boolean) as any[]
        const bindings = objects.filter(item => item.kind === 'TargetGroupBinding')
        expect(objects.some(item => item.kind === 'Ingress'), release).false
        for (const binding of bindings) {
          const service = objects.find(item => item.kind === 'Service' && item.metadata.name === binding.spec.serviceRef.name)
          expect(service, `${release}: binding must select its own Service`).not.undefined
          expect(service.spec.ports.some((port: any) => port.port === binding.spec.serviceRef.port)).true
        }

        count += bindings.length
      }

      expect(count).eq(7)
    } finally {fs.rmSync(directory, {force: true, recursive: true})}
  })
})

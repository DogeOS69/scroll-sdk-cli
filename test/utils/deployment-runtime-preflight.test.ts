/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic Kubernetes/RPC documents. */
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {checkClusterManifests, checkEthereumRpcBatch, checkSignerRpc, inspectRuntimeManifests} from '../../src/utils/deployment-runtime-preflight.js'

describe('deployment runtime preflight', () => {
  const pod = (cpu: string, memory: string) => ({kind: 'Deployment', metadata: {name: 'reth'}, spec: {template: {spec: {containers: [{resources: {requests: {cpu, memory}}}]}}}})
  const node = {metadata: {labels: {pool: 'test'}}, status: {allocatable: {cpu: '3900m', memory: '15Gi'}, conditions: [{status: 'True', type: 'Ready'}]}}
  it('rejects an impossible Reth request and accounts for init-container requests', () => {
    expect(inspectRuntimeManifests([pod('4', '16Gi')], [node])).length(1)
    expect(inspectRuntimeManifests([pod('500m', '2Gi')], [node])).empty
    const value: any = pod('500m', '2Gi')
    value.spec.template.spec.initContainers = [{resources: {requests: {memory: '20Gi'}}}]
    expect(inspectRuntimeManifests([value], [node])).length(1)
    expect(inspectRuntimeManifests([pod('500m', '2Gi')], [{...node, spec: {unschedulable: true}}])).length(1)
  })
  it('blocks ALB installation when the controller or its CRD is missing, using only the selected context', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alb-preflight-'))
    const manifest = path.join(root, 'ingress.yaml')
    fs.writeFileSync(manifest, 'kind: Ingress\nmetadata: {name: rpc}\nspec: {ingressClassName: alb}\n')
    try {
      const errors = checkClusterManifests('explicit-context', [manifest], (command, args) => {
        expect(command).eq('kubectl')
        expect(args.slice(0, 2)).deep.eq(['--context', 'explicit-context'])
        if (args.includes('nodes')) return JSON.stringify({items: [node]})
        throw new Error('NotFound')
      })
      expect(errors).length(1)
      expect(errors[0]).include('Load Balancer Controller')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  const block = {hash: `0x${'a'.repeat(64)}`, number: '0x100'}
  const request = (mode = 'ok') => (async (_url: any, options: any) => {
    const body = JSON.parse(options.body)
    if (!Array.isArray(body)) return new Response(JSON.stringify({id: 5, jsonrpc: '2.0', result: block}))
    const data = body.map(call => ({id: call.id, jsonrpc: '2.0', result: call.id === 1 ? '0xaa36a7' : block})).reverse()
    if (mode === 'duplicate') data[0].id = data[1].id
    return new Response(JSON.stringify(mode === 'single' ? {error: {code: -32_600}} : data))
  }) as typeof fetch
  it('accepts reordered four-call batches only with a matching finalized quorum', async () => {
    expect(await checkEthereumRpcBatch(['https://one.invalid', 'https://two.invalid'], 11_155_111, 2, request())).deep.eq({checked: 2, healthy: 2})
  })
  for (const mode of ['duplicate', 'single']) it(`rejects ${mode} batch responses`, async () => {
    let error: unknown
    try {await checkEthereumRpcBatch(['https://one.invalid'], 11_155_111, 1, request(mode))} catch (error_) {error = error_}
    expect(error).instanceOf(Error)
    expect(String(error)).include('batch compatibility failed').not.include('one.invalid')
  })
  it('probes from the signer network namespace without exposing URL credentials in arguments', () => {
    checkSignerRpc('local-signer', 'http://fixture:NONFUNCTIONAL@rpc.example.invalid:1234', (_command, args, input) => {
      expect(args).include('container:local-signer')
      expect(args.join(' ')).not.include('NONFUNCTIONAL')
      expect(input).include('getblockchaininfo')
      return JSON.stringify({result: {blocks: 42, chain: 'regtest'}})
    })
    expect(() => checkSignerRpc('local-signer', 'http://rpc.example.invalid', () => '{"error":{"message":"private"}}')).throw('from the signer container')
  })
})

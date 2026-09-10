#!/usr/bin/env node
// Process-boundary doubles for CLI integration tests. No cloud or cluster calls.
import fs from 'node:fs'
import path from 'node:path'
const root = process.env.BOOTNODE_TEST_ROOT
if (!root) throw new Error('BOOTNODE_TEST_ROOT is required')
const tool = path.basename(process.argv[1])
const args = process.argv.slice(2)
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({tool, args}) + '\n')
const fail = process.env.BOOTNODE_FAIL
if ((fail === 'oidc' && args.includes('associate-iam-oidc-provider')) ||
    (['iam', 'existing-policy'].includes(fail) && args[0] === 'iam' && args[1] === 'create-policy') ||
    (fail === 'controller' && args.includes('wait'))) {
  process.stderr.write(fail === 'existing-policy' ? 'EntityAlreadyExists\n' : 'AccessDenied: injected failure\n')
  process.exit(1)
}
let output
if (args.includes('--version') && tool !== 'helm') output = `${tool} test`
else if (tool === 'aws') {
  if (args[0] === 'sts') output = {Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/test'}
  else if (args[0] === 'eks' && args[1] === 'describe-cluster') output = {cluster: {endpoint: 'https://selected-cluster.test', resourcesVpcConfig: {vpcId: 'vpc-test'}}}
  else if (args[0] === 'eks' && args[1] === 'update-kubeconfig') output = {
    apiVersion: 'v1', kind: 'Config', 'current-context': 'selected',
    clusters: [{name: 'selected', cluster: {server: fail === 'context' ? 'https://wrong-cluster.test' : 'https://selected-cluster.test'}}],
    contexts: [{name: 'selected', context: {cluster: 'selected', user: 'test'}}], users: [{name: 'test', user: {token: 'offline-test'}}],
  }
  else if (args[0] === 'iam' && ['create-policy', 'get-policy'].includes(args[1])) output = {Policy: {Arn: 'arn:aws:iam::123456789012:policy/test'}}
} else if (tool === 'eksctl') output = 'ok'
else if (tool === 'helm') output = args[0] === 'show' ? 'version: 1.14.0\nappVersion: v2.14.0' : 'ok'
else if (tool === 'kubectl') {
  if (args.includes('version') || args.includes('wait')) output = 'ok'
  else if (args.includes('get') && args.includes('deployment')) output = 'True'
  else if (args.includes('get') && args.includes('svc')) output = {items: [0, 3].map(index => ({
    metadata: {name: `l2-reth-bootnode-${index}-p2p`}, spec: {type: 'LoadBalancer'},
    status: {loadBalancer: {ingress: [{hostname: `bootnode-${index}.public.example`}] }},
  }))}
} else if (tool === 'curl' && args.includes('-o')) {
  fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({Version: '2012-10-17', Statement: [{Effect: 'Allow', Action: 'test:Only', Resource: '*'}]}))
  output = ''
}
if (output === undefined) throw new Error(`Unexpected ${tool} call: ${JSON.stringify(args)}`)
process.stdout.write(typeof output === 'string' ? output + '\n' : JSON.stringify(output) + '\n')

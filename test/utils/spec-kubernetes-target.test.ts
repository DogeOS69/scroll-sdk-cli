import {expect} from 'chai'
import {execFileSync} from 'node:child_process'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {bindMakefileTarget, specDstackController, specKubernetesTarget} from '../../src/utils/spec-kubernetes-target.js'

const spec = (kubeContext?: string, namespace?: string): DeploymentSpec => ({
  infrastructure: {kubeContext, namespace},
} as DeploymentSpec)

describe('spec Kubernetes target', () => {
  it('writes exactly one pair of defaults and preserves Make command-line overrides', () => {
    const context = 'arn:aws:eks:us-east-1:123456789012:cluster/test-cluster'
    const result = bindMakefileTarget('KUBE_CONTEXT ?=\nNAMESPACE ?= default\nshow:\n\t@echo "$(KUBE_CONTEXT) $(NAMESPACE)"\n', spec(context, 'chain'))
    expect(result.match(/^KUBE_CONTEXT /gm)).to.have.length(1)
    expect(result.match(/^NAMESPACE /gm)).to.have.length(1)
    const run = (...args: string[]) => execFileSync('make', ['--no-print-directory', '-f', '-', 'show', ...args], {encoding: 'utf8', input: result}).trim()
    expect(run()).to.equal(`${context} chain`)
    expect(run('KUBE_CONTEXT=other-context', 'NAMESPACE=other')).to.equal('other-context other')
  })

  it('defaults the namespace to default and supports existing upload context', () => {
    const input = spec()
    input.preparation = {secretUpload: {kubeContext: 'old-context', provider: 'aws'}} as DeploymentSpec['preparation']
    expect(specKubernetesTarget(input)).to.deep.equal({kubeContext: 'old-context', namespace: 'default'})
    expect(bindMakefileTarget('all:\n\t@true\n', input)).to.include('KUBE_CONTEXT ?= old-context\n')
  })

  it('rejects disagreement between installation and Secret upload targets', () => {
    const input = spec('cluster-a')
    input.preparation = {secretUpload: {kubeContext: 'cluster-b', provider: 'aws'}} as DeploymentSpec['preparation']
    expect(() => specKubernetesTarget(input)).to.throw('kubeContext must match')
    input.preparation!.secretUpload = {namespace: 'different', provider: 'aws'}
    expect(() => specKubernetesTarget(input)).to.throw('namespace must match')
  })

  it('rejects Make/shell interpolation and malformed namespace values', () => {
    for (const context of ['$(shell false)', 'cluster\nNAMESPACE=x', 'cluster#comment', 'cluster`false`', '']) {
      expect(() => bindMakefileTarget('', spec(context))).to.throw('Kubernetes context')
    }

    for (const namespace of ['UPPER', 'a/b', 'a'.repeat(64), '']) {
      expect(() => specKubernetesTarget(spec('cluster', namespace))).to.throw('namespace')
    }
  })
  it('uses one namespace for dstack and removes retired CLI callbacks from manager installation', () => {
    const input = spec('cluster', 'chain')
    input.dstackController = {enabled: true}
    input.capacityManager = {} as any
    expect(specDstackController(input)?.monitoring?.namespace).to.equal('chain')
    const source = 'DSTACK_NAMESPACE ?= dstack-system\ninstall-capacity-manager:\n\tscrollsdk setup capacity-manager credentials --dir .\n\thelm upgrade capacity-manager -n "$(NAMESPACE)"\ninstall-dstack-controller:\n\thelm upgrade dstack -n "$(DSTACK_NAMESPACE)"\n'
    const result = bindMakefileTarget(source, input)
    expect(result).not.to.include('DSTACK_NAMESPACE')
    expect(result).to.include('install-capacity-manager:\n\thelm')
    expect(result).not.to.include('setup capacity-manager')
    expect(bindMakefileTarget(result, input)).to.equal(result)
    input.dstackController.monitoring = {namespace: 'other'}
    expect(() => specDstackController(input)).to.throw('must match infrastructure.namespace')
  })

})

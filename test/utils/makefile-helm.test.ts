import {expect} from 'chai'

import {parseHelmUpgradeRecipes} from '../../src/utils/makefile-helm.js'

describe('Makefile Helm recipe parsing', () => {
  it('recognizes explicit global kube context, variables, continuations and a final recipe at EOF', () => {
    const content = 'CONTEXT := arn:aws:eks:us-east-1:123:cluster/devnet\nCHART ?= oci://example/l2-reth\nVERSION ?= 0.1.4\ninstall:\n\thelm --kube-context $(CONTEXT) upgrade -i l2-reth $(CHART) \\\n\t --version $(VERSION) --values values/reth.yaml -f values/genesis.yaml'
    expect(parseHelmUpgradeRecipes(content)).to.deep.equal([
      {chart: 'oci://example/l2-reth', release: 'l2-reth', valuesFiles: ['values/reth.yaml', 'values/genesis.yaml'], version: '0.1.4'},
    ])
  })

  it('keeps adjacent recipes separate and accepts equals options and quoted paths', () => {
    const content = 'install:\n\t@helm upgrade --install one oci://example/one --version=1.0 --values="one.yaml"\n\thelm upgrade -i two oci://example/two --version 2.0 -f "values/two files.yaml"\n'
    const recipes = parseHelmUpgradeRecipes(content)
    expect(recipes).to.have.length(2)
    expect(recipes[0].version).to.equal('1.0')
    expect(recipes[0].valuesFiles).to.deep.equal(['one.yaml'])
    expect(recipes[1].valuesFiles).to.deep.equal(['values/two files.yaml'])
  })

  it('does not run make functions or accept unresolved chart variables', () => {
    expect(() => parseHelmUpgradeRecipes('install:\n\thelm upgrade -i one $(MISSING)')).to.throw('Unresolved Make')
    expect(() => parseHelmUpgradeRecipes('CHART = $(shell echo something)\ninstall:\n\thelm upgrade -i one $(CHART)')).to.throw('Unresolved Make')
  })

  it('ignores comments, non-upgrade commands and non-recipe text', () => {
    expect(parseHelmUpgradeRecipes('# helm upgrade -i x y\n\thelm --kube-context arn repo update\ntext helm upgrade -i x y')).to.deep.equal([])
  })

  it('expands simple nested variables without confusing namespace arguments with the release', () => {
    expect(parseHelmUpgradeRecipes('REGISTRY = oci://example\nCHART = $(REGISTRY)/one\ninstall:\n\thelm upgrade --namespace default -i one $(CHART) --values=a.yaml,b.yaml')[0])
      .to.deep.equal({chart: 'oci://example/one', release: 'one', valuesFiles: ['a.yaml', 'b.yaml']})
  })
})

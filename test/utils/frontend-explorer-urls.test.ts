import {expect} from 'chai'

import {defaultEthereumExplorer, frontendExplorerUrlProblem} from '../../src/utils/frontend-explorer-urls.js'

describe('frontend explorer URLs', () => {
  it('leaves an unknown or local DA chain without a link', () => {
    expect(defaultEthereumExplorer('devnet')).to.equal('')
    expect(defaultEthereumExplorer('unknown')).to.equal('')
  })

  for (const value of [undefined, '', 'https://sochain.com/doge', 'https://sochain.com/dogetest', 'https://sepolia.etherscan.io', 'http://explorer.internal:8080']) {
    it(`accepts ${value}`, () => {
      expect(frontendExplorerUrlProblem('field', value)).to.equal(undefined)
    })
  }

  for (const value of ['not a url', 'ftp://explorer.dogeos.io', 'https://explorer.dogeos.io/tx?id=', 'https://explorer.dogeos.io/#tx', 'https://explorer.dogeos.io?', 7]) {
    it(`rejects the shape of ${value}`, () => {
      expect(frontendExplorerUrlProblem('field', value)).to.include('<base>/tx/<txid>')
    })
  }

  for (const value of ['https://sochain.com/dogetest/', 'https://sepolia.etherscan.io/', 'http://explorer.internal:8080//']) {
    it(`rejects the trailing slash of ${value}`, () => {
      expect(frontendExplorerUrlProblem('field', value)).to.include('remove the trailing slash')
    })
  }

  for (const host of ['explorer.example.invalid', 'explorer.example', 'explorer.test', 'localhost', 'app.localhost', 'example.com', 'l1.example.com']) {
    it(`rejects the placeholder host ${host}`, () => {
      expect(frontendExplorerUrlProblem('field', `https://${host}`)).to.include('placeholder host')
    })
  }

  it('does not mistake a real domain ending in a placeholder word for one', () => {
    expect(frontendExplorerUrlProblem('field', 'https://notexample.com')).to.equal(undefined)
    expect(frontendExplorerUrlProblem('field', 'https://latest')).to.equal(undefined)
  })
})

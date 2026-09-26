import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {StatusPageState, lockStatusPageApply} from '../../src/utils/status-page-state.js'

const target = () => ({componentIds: {}, initialStatus: '', pageId: '', showUptime: false, subdomain: ''})

describe('persistent status-page deployment binding', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-page-state-')) })
  afterEach(() => { fs.rmSync(root, {force: true, recursive: true}) })

  it('restores network bindings independently of Helm values and rejects changed targets', () => {
    const state = new StatusPageState(root, 'testnet')
    state.reserve({components: [], initialStatus: '', page: {action: 'create', id: '', name: 'Testnet', subdomain: 'dogeos-testnet'}})
    state.bind('page-testnet')
    const reloaded = new StatusPageState(root, 'testnet')
    const restored = target()
    expect(reloaded.restore(restored)).to.equal(true)
    expect(restored.pageId).to.equal('page-testnet')
    expect(restored.subdomain).to.equal('dogeos-testnet')
    expect(() => reloaded.restore({...target(), pageId: 'another-page'})).to.throw('explicit migration')
    expect(() => reloaded.restore({...target(), subdomain: 'new-testnet'})).to.throw('explicit migration')
    expect(() => new StatusPageState(root, 'mainnet')).to.throw('already bound to another network')
  })

  it('restores the network group independently of regenerated values and rejects retargeting', () => {
    const state = new StatusPageState(root, 'testnet')
    state.reserve({components: [], group: {action: 'reuse', id: 'testnet-group', name: 'Testnet'}, initialStatus: '', page: {action: 'unchanged', id: 'shared-page', name: 'DogeOS', subdomain: 'dogeos'}})
    state.bind('shared-page')
    const restored = {...target(), groupId: ''}
    const reloaded = new StatusPageState(root, 'testnet')
    expect(reloaded.restore(restored)).to.equal(true)
    expect(restored.groupId).to.equal('testnet-group')
    expect(() => reloaded.restore({...target(), groupId: 'mainnet-group'})).to.throw('explicit migration')
  })

  it('fails on corrupted state instead of treating the deployment as new', () => {
    fs.mkdirSync(path.join(root, '.data'))
    fs.writeFileSync(path.join(root, '.data/status-page-state.json'), '{invalid')
    expect(() => new StatusPageState(root, 'testnet')).to.throw('restore the deployment binding')
  })

  it('blocks concurrent applies on the same deployment root without removing their lock', () => {
    const release = lockStatusPageApply(root)
    expect(() => lockStatusPageApply(root)).to.throw('another apply may be running')
    expect(fs.existsSync(path.join(root, '.data/status-page-apply.lock'))).to.equal(true)
    release()
    const nextRelease = lockStatusPageApply(root)
    nextRelease()
    expect(fs.existsSync(path.join(root, '.data/status-page-apply.lock'))).to.equal(false)
  })
})

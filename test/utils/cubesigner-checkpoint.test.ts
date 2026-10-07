import * as toml from '@iarna/toml'
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {exportCubesignerCheckpoint, importCubesignerCheckpoint} from '../../src/utils/cubesigner-checkpoint.js'

describe('private CubeSigner deployment checkpoint', () => {
  let root: string
  const publicKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  const role = {keys: [{key_id: 'Key#fixture', key_type: 'Secp256k1', material_id: 'fixture', public_key: publicKey, public_key_compressed: publicKey, purpose: 'test'}], name: 'fixture', role_id: 'Role#fixture'}
  const options = () => ({deploymentDir: root, directory: '.data/private-cubesigner', instance: 'fixture', organization: 'Org#fixture', signerApiRoot: 'https://gamma.signer.cubist.dev'})
  const configFile = () => path.join(root, '.data/doge-config.toml')
  const sessionFile = () => path.join(root, 'secrets/cubesigner-signer-session.json')
  const checkpointFile = (name: string) => path.join(root, options().directory, name)

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cubesigner-checkpoint-'))
    fs.mkdirSync(path.join(root, '.data'))
    fs.mkdirSync(path.join(root, 'secrets'))
    fs.writeFileSync(configFile(), toml.stringify({cubesigner: {mode: 'transport_only', roles: [role]}, network: 'regtest'}))
    fs.writeFileSync(path.join(root, '.data/setup_defaults.toml'), toml.stringify({keep: 'fixture', tee_pubkey: publicKey}))
    fs.writeFileSync(sessionFile(), JSON.stringify({env: {'Dev-CubeSignerStack': {SignerApiRoot: options().signerApiRoot}}, org_id: options().organization, refresh_token: 'fixture-refresh', role_id: role.role_id, session_exp: Date.now() / 1000 + 3600, session_info: {refresh_token_exp: Date.now() / 1000 + 7200}, token: 'fixture-token'}))
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('restores the identity and session while preserving unrelated configuration and private modes', () => {
    const receipt = exportCubesignerCheckpoint(options())
    const session = fs.readFileSync(sessionFile(), 'utf8')
    fs.writeFileSync(configFile(), toml.stringify({cubesigner: {mode: 'transport_only'}, network: 'regtest'}))
    fs.writeFileSync(path.join(root, '.data/setup_defaults.toml'), toml.stringify({keep: 'fixture'}))
    fs.unlinkSync(sessionFile())
    expect(importCubesignerCheckpoint(options())).to.deep.equal(receipt)
    expect(fs.readFileSync(sessionFile(), 'utf8')).to.equal(session)
    const config = toml.parse(fs.readFileSync(configFile(), 'utf8'))
    expect(config.network).to.equal('regtest')
    expect(config.cubesigner).to.deep.equal({mode: 'transport_only', roles: [role]})
    expect(toml.parse(fs.readFileSync(path.join(root, '.data/setup_defaults.toml'), 'utf8')).keep).to.equal('fixture')
    expect(fs.statSync(path.join(root, options().directory)).mode % 0o1000).to.equal(0o700)
    for (const file of ['identity.json', 'receipt.json', 'session.json']) expect(fs.statSync(checkpointFile(file)).mode % 0o1000).to.equal(0o600)
    expect(fs.statSync(sessionFile()).mode % 0o1000).to.equal(0o600)
    expect(() => exportCubesignerCheckpoint(options())).to.throw('already exists')
  })

  it('rejects mismatched bindings and modified checkpoint contents', () => {
    exportCubesignerCheckpoint(options())
    for (const change of [{instance: 'other'}, {organization: 'Org#other'}, {signerApiRoot: 'https://prod.signer.cubist.dev'}]) expect(() => importCubesignerCheckpoint({...options(), ...change})).to.throw('mismatch')
    fs.appendFileSync(checkpointFile('session.json'), ' ')
    expect(() => importCubesignerCheckpoint(options())).to.throw('digest mismatch')
  })

  it('rejects expired sessions and overwriting another active identity', () => {
    exportCubesignerCheckpoint(options())
    const session = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'))
    session.session_exp = 1
    fs.writeFileSync(sessionFile(), JSON.stringify(session))
    expect(() => exportCubesignerCheckpoint({...options(), directory: '.data/expired'})).to.throw('expired')
    fs.writeFileSync(configFile(), toml.stringify({cubesigner: {roles: [{...role, role_id: 'Role#other'}]}}))
    expect(() => importCubesignerCheckpoint(options())).to.throw('different active')
  })

  it('rejects symlinked checkpoint files before loading credentials', () => {
    exportCubesignerCheckpoint(options())
    fs.unlinkSync(checkpointFile('session.json'))
    fs.symlinkSync(sessionFile(), checkpointFile('session.json'))
    expect(() => importCubesignerCheckpoint(options())).to.throw('symlink')
  })
})

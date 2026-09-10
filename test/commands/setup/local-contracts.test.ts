import * as toml from '@iarna/toml'
import {expect} from 'chai'
import {execFile} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {PassThrough} from 'node:stream'
import {promisify} from 'node:util'

import {generateLocalContractsArtifacts} from '../../../src/utils/local-contracts.js'

const execFileAsync = promisify(execFile)
const cli = path.resolve('bin/run.js')
const outputFiles = ['config-contracts.toml', 'genesis.yaml', 'frontend-config.yaml']

describe('local contracts generation', () => {
  let dir: string
  let source: string
  let deployment: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-contracts-test-'))
    source = path.join(dir, 'contracts source')
    deployment = path.join(dir, 'deployment with spaces')
    fs.mkdirSync(deployment)
    for (const folder of ['src', 'scripts', 'docker/scripts', 'lib', 'volume']) fs.mkdirSync(path.join(source, folder), {recursive: true})
    fs.writeFileSync(path.join(source, 'volume/config.toml'), 'untouched-source-volume')
    fs.writeFileSync(path.join(source, 'foundry.toml'), '[profile.default]\n')
    fs.writeFileSync(path.join(source, 'remappings.txt'), '')
    fs.writeFileSync(path.join(deployment, 'config.toml'), '')
  })
  afterEach(() => {fs.rmSync(dir, {force: true, recursive: true})})

  function setScript(body: string) {
    fs.writeFileSync(path.join(source, 'docker/scripts/gen-configs.sh'), `#!/bin/bash\nset -eu\n${body}\n`)
  }

  it('uses an isolated volume, publishes outputs and reuses only compiler caches', async () => {
    setScript(`test -f volume/config.toml
      test ! -e volume/source-only
      if test -f artifacts/prior; then echo cached >&2; fi
      mkdir -p artifacts cache/private-script
      echo compiled > artifacts/prior
      echo '{}' > cache/solidity-files-cache.json
      echo private > cache/private-script/run.json
      ${outputFiles.map(file => `echo generated > volume/${file}`).join('\n')}`)
    const logs = new PassThrough()
    let output = ''
    logs.on('data', chunk => {output += chunk})
    await generateLocalContractsArtifacts(source, deployment, logs)
    await generateLocalContractsArtifacts(source, deployment, logs)
    for (const file of outputFiles) expect(fs.readFileSync(path.join(deployment, file), 'utf8')).to.equal('generated\n')
    expect(output).to.include('cached')
    expect(fs.readFileSync(path.join(source, 'volume/config.toml'), 'utf8')).to.equal('untouched-source-volume')
    const cacheRoot = path.join(deployment, '.data/contracts-build')
    const cache = path.join(cacheRoot, fs.readdirSync(cacheRoot)[0])
    expect(fs.existsSync(path.join(cache, 'cache/private-script'))).to.equal(false)
    expect(fs.existsSync(path.join(cache, '.lock'))).to.equal(false)
  })

  for (const failure of ['exit 7', 'exit 0']) {
    it(`rejects failed or incomplete generation (${failure}) without replacing existing outputs`, async () => {
      for (const file of outputFiles) fs.writeFileSync(path.join(deployment, file), 'previous')
      setScript(`echo partial > volume/genesis.yaml\n${failure}`)
      let error: unknown
      try {
        await generateLocalContractsArtifacts(source, deployment, new PassThrough())
      } catch (error_) {error = error_}

      expect(error).to.be.instanceOf(Error)
      for (const file of outputFiles) expect(fs.readFileSync(path.join(deployment, file), 'utf8')).to.equal('previous')
      // A failed run releases its lock, allowing a corrected retry.
      setScript(outputFiles.map(file => `echo complete > volume/${file}`).join('\n'))
      await generateLocalContractsArtifacts(source, deployment, new PassThrough())
    })
  }

  it('routes the real CLI to local source without Docker or image resolution, preserving JSON stdout', async () => {
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    for (const tool of ['forge', 'jq']) fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', {mode: 0o755})
    fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 99\n', {mode: 0o755})
    setScript(`echo generator-log
      ${outputFiles.map(file => `echo '# generated' > volume/${file}`).join('\n')}`)
    const preload = path.join(dir, 'no-fetch.mjs')
    fs.writeFileSync(preload, "globalThis.fetch = async () => {throw new Error('Image resolution is forbidden')};")
    const result = await execFileAsync(process.execPath, ['--import', preload, cli, 'setup', 'gen-l2-artifacts', '--contracts-source', source, '-N', '--json', '--skip-deployment-salt-update', '--skip-l1-fee-vault-update'], {cwd: deployment, env: {...process.env, PATH: `${bin}:${process.env.PATH}`}, timeout: 30_000})
    const response = JSON.parse(result.stdout)
    expect(response.success).to.equal(true)
    expect(response.data.backend).to.equal('local')
    expect(response.data.contractsSource).to.equal(source)
    expect(response.data).not.to.have.property('imageTag')
    expect(result.stderr).to.include('generator-log')
    expect(fs.existsSync(path.join(deployment, 'values/frontends-config.yaml'))).to.equal(true)
    expect(toml.parse(fs.readFileSync(path.join(deployment, 'config.public.toml'), 'utf8'))).to.be.an('object')
  })

  it('rejects conflicting backends before modifying config', async () => {
    try {
      await execFileAsync(process.execPath, [cli, 'setup', 'gen-l2-artifacts', '--contracts-source', source, '--image-tag', 'unused', '-N'], {cwd: deployment, timeout: 30_000})
      expect.fail('Expected incompatible flags to fail')
    } catch (error) {
      expect((error as {code: number}).code).to.equal(2)
    }

    expect(fs.readFileSync(path.join(deployment, 'config.toml'), 'utf8')).to.equal('')
  })
})

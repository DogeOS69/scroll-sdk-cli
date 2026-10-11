import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {deploymentEnvFile, savedDeploymentEnvFile} from '../../src/utils/deployment-paths.js'
import {loadPreparationEnv} from '../../src/utils/preparation-io.js'

describe('conventional deployment environment paths', () => {
  let directory: string
  beforeEach(() => {directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-paths-'))})
  afterEach(() => {fs.rmSync(directory, {force: true, recursive: true})})

  it('allows process environment without a default file, but never ignores an explicit missing file', () => {
    expect(deploymentEnvFile(undefined, directory)).to.equal(undefined)
    const missing = path.join(directory, 'missing.env')
    expect(() => loadPreparationEnv(deploymentEnvFile(missing, directory))).to.throw('Cannot read')
  })

  it('uses deployment.env without searching other dotenv files', () => {
    fs.writeFileSync(path.join(directory, '.env'), '# not selected')
    fs.writeFileSync(path.join(directory, '.env.local'), '# not selected')
    expect(deploymentEnvFile(undefined, directory)).to.equal(undefined)
    fs.writeFileSync(path.join(directory, 'deployment.env'), '# selected')
    expect(deploymentEnvFile(undefined, directory)).to.equal(path.join(directory, 'deployment.env'))
  })

  it('retains the saved plan environment in runtime copies and permits an explicit override', () => {
    fs.mkdirSync(path.join(directory, '.scrollsdk'))
    const saved = path.join(directory, 'original.env')
    fs.writeFileSync(path.join(directory, '.scrollsdk/plan.json'), JSON.stringify({envFile: saved}))
    fs.writeFileSync(path.join(directory, 'deployment.env'), '# must not replace saved input')
    expect(savedDeploymentEnvFile(directory)).to.equal(saved)
    expect(() => loadPreparationEnv(savedDeploymentEnvFile(directory))).to.throw('Cannot read')
    const override = path.join(directory, 'override.env')
    expect(savedDeploymentEnvFile(directory, override)).to.equal(override)
  })

  it('uses the deployment directory environment when no reference was saved', () => {
    fs.mkdirSync(path.join(directory, '.scrollsdk'))
    fs.writeFileSync(path.join(directory, '.scrollsdk/plan.json'), '{}')
    fs.writeFileSync(path.join(directory, 'deployment.env'), '# selected')
    expect(savedDeploymentEnvFile(directory)).to.equal(path.join(directory, 'deployment.env'))
  })
})

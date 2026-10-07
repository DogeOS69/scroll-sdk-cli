import {spawn, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const REQUIRED_FILES = ['foundry.toml', 'remappings.txt', 'docker/scripts/gen-configs.sh']
const OUTPUT_FILES = ['config-contracts.toml', 'genesis.yaml', 'frontend-config.yaml']

/** Validate the explicit local backend before the command edits deployment inputs. */
export function validateContractsSource(source: string): string {
  const resolved = fs.realpathSync(path.resolve(source))
  for (const file of REQUIRED_FILES) {
    if (!fs.statSync(path.join(resolved, file), {throwIfNoEntry: false})?.isFile()) {
      throw new Error(`Contracts source is missing ${file}: ${resolved}`)
    }
  }

  for (const directory of ['src', 'scripts', 'docker', 'lib']) {
    if (!fs.statSync(path.join(resolved, directory), {throwIfNoEntry: false})?.isDirectory()) {
      throw new Error(`Contracts source is missing ${directory}/: ${resolved}`)
    }
  }

  for (const command of ['bash', 'forge', 'jq']) {
    const result = spawnSync(command, ['--version'], {stdio: 'ignore'})
    if (result.error || result.status !== 0) throw new Error(`Local contracts generation requires ${command} on PATH`)
  }

  return resolved
}

/** Run the same image entrypoint in an isolated project, using local Foundry. */
export async function generateLocalContractsArtifacts(source: string, deployment: string, logs: NodeJS.WritableStream): Promise<void> {
  const sourceId = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const cache = path.join(deployment, '.data', 'contracts-build', sourceId)
  fs.mkdirSync(cache, {mode: 0o700, recursive: true})
  const lock = path.join(cache, '.lock')
  try {
    fs.mkdirSync(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Local contracts generation is already running (or was interrupted). Check the process before removing ${lock}`)
    throw error
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-contracts-'))
  try {
    for (const directory of ['src', 'scripts', 'docker']) {
      fs.cpSync(path.join(source, directory), path.join(stage, directory), {recursive: true})
    }

    for (const file of ['foundry.toml', 'remappings.txt', 'package.json']) {
      if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(stage, file))
    }

    for (const directory of ['lib', 'node_modules']) {
      if (fs.existsSync(path.join(source, directory))) fs.symlinkSync(path.join(source, directory), path.join(stage, directory), 'dir')
    }

    // Only compiler outputs are cached; deployment volume and script caches are private to this run.
    const artifacts = fs.existsSync(path.join(cache, 'artifacts')) ? cache : source
    if (fs.existsSync(path.join(artifacts, 'artifacts'))) fs.cpSync(path.join(artifacts, 'artifacts'), path.join(stage, 'artifacts'), {recursive: true})
    const compilerCache = 'cache/solidity-files-cache.json'
    const priorCache = fs.existsSync(path.join(cache, compilerCache)) ? cache : source
    fs.mkdirSync(path.join(stage, 'cache'), {recursive: true})
    if (fs.existsSync(path.join(priorCache, compilerCache))) fs.copyFileSync(path.join(priorCache, compilerCache), path.join(stage, compilerCache))
    fs.mkdirSync(path.join(stage, 'volume'), {mode: 0o700})
    fs.copyFileSync(path.join(deployment, 'config.toml'), path.join(stage, 'volume/config.toml'))

    await new Promise<void>((resolve, reject) => {
      const child = spawn('bash', ['docker/scripts/gen-configs.sh'], {
        cwd: stage,
        env: {...process.env, FOUNDRY_JOBS: process.env.FOUNDRY_JOBS || '2', RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS || '2'},
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.pipe(logs, {end: false})
      child.stderr.pipe(logs, {end: false})
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`Local gen-configs.sh failed (${signal || `exit ${code}`}); see generator logs`))
      })
    })

    // Reject incomplete generation before publishing any output or accepting stale deployment files.
    for (const file of OUTPUT_FILES) {
      if (!fs.statSync(path.join(stage, 'volume', file), {throwIfNoEntry: false})?.size) throw new Error(`Local generator did not produce ${file}`)
    }

    for (const file of [...OUTPUT_FILES, 'native-doge-token-predeploy.json']) {
      const generated = path.join(stage, 'volume', file)
      if (fs.existsSync(generated)) fs.copyFileSync(generated, path.join(deployment, file))
    }

    if (fs.existsSync(path.join(stage, 'artifacts'))) {
      fs.rmSync(path.join(cache, 'artifacts'), {force: true, recursive: true})
      fs.cpSync(path.join(stage, 'artifacts'), path.join(cache, 'artifacts'), {recursive: true})
    }

    if (fs.existsSync(path.join(stage, compilerCache))) {
      fs.mkdirSync(path.join(cache, 'cache'), {recursive: true})
      fs.copyFileSync(path.join(stage, compilerCache), path.join(cache, compilerCache))
    }
  } finally {
    fs.rmSync(stage, {force: true, recursive: true})
    fs.rmSync(lock, {force: true, recursive: true})
  }
}

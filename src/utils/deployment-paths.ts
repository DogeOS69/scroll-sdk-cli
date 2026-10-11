import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_SPEC = 'deployment-spec.yaml'
export const DEFAULT_DEPLOYMENT = 'deployment'
export const DEFAULT_SDK = '../scroll-sdk'

// Explicit paths must fail at the reader if missing; only the conventional
// environment file is optional for operators supplying process environment.
export function deploymentEnvFile(explicit?: string, directory = process.cwd()): string | undefined {
  if (explicit) return path.resolve(explicit)
  const file = path.resolve(directory, 'deployment.env')
  return fs.existsSync(file) ? file : undefined
}

// Runtime copies retain the preparation plan's environment-file reference.
// Do not search parent directories or substitute a different file on resume.
export function savedDeploymentEnvFile(directory: string, explicit?: string): string | undefined {
  if (explicit) return path.resolve(explicit)
  const planFile = path.join(directory, '.scrollsdk/plan.json')
  if (fs.existsSync(planFile)) {
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as {envFile?: string}
    if (plan.envFile) return plan.envFile
  }

  return deploymentEnvFile(undefined, directory)
}

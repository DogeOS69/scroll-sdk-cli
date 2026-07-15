/* eslint-disable @typescript-eslint/no-explicit-any -- aws CLI JSON output is dynamic. */

import { execFileSync } from 'node:child_process'

export interface AwsCliOptions {
  json?: boolean
  profile?: string
  query?: string
  region?: string
}

/** Thin `aws` CLI shell-out, mirroring the KmsSignerProvisioner conventions. */
export class AwsCliRunner {
  constructor(private readonly profile?: string) {}

  json(args: string[], options: AwsCliOptions = {}): any {
    return this.run(args, { ...options, json: true })
  }

  run(args: string[], options: AwsCliOptions = {}): any {
    const fullArgs = [...args]
    if (options.region) fullArgs.push('--region', options.region)
    if (options.profile || this.profile) fullArgs.push('--profile', options.profile || this.profile as string)
    if (options.query) fullArgs.push('--query', options.query)
    if (options.json) fullArgs.push('--output', 'json')
    else if (options.query) fullArgs.push('--output', 'text')

    try {
      const output = execFileSync('aws', fullArgs, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (options.json) return output ? JSON.parse(output) : {}
      return output
    } catch (error: any) {
      const stderr = error?.stderr ? String(error.stderr).trim() : ''
      throw new Error(stderr || error?.message || `aws ${fullArgs.join(' ')} failed`)
    }
  }

  text(args: string[], options: AwsCliOptions = {}): string {
    return String(this.run(args, options))
  }
}

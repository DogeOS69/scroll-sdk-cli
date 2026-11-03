/* eslint-disable @typescript-eslint/no-explicit-any -- aws CLI JSON output is dynamic. */

import { execFileSync } from 'node:child_process'

/** The only AWS writes the CLI makes: content, never resource configuration. */
export type AwsContentWrite = 'object' | 'secret-value'

export interface AwsCliOptions {
  /** Explicitly allow one kind of content write for this call. */
  contentWrite?: AwsContentWrite
  json?: boolean
  profile?: string
  query?: string
  region?: string
}

const READ_ONLY = /^(describe|get|head|list|simulate)-/
// Local credential and kubeconfig helpers; they change no AWS resource.
const LOCAL_ONLY = new Set(['configure export-credentials', 'eks update-kubeconfig', 'sts get-session-token'])
const CONTENT_WRITES: Record<AwsContentWrite, ReadonlySet<string>> = {
  object: new Set(['s3api put-object']),
  'secret-value': new Set(['secretsmanager create-secret', 'secretsmanager put-secret-value']),
}

/**
 * Fail closed before spawning AWS. Infrastructure tooling (CloudFormation)
 * owns AWS resources; the CLI only reads them, uploads Secret values and
 * publishes objects into existing buckets. The pre-genesis `setup aws` stage
 * allows no writes at all.
 */
export function assertAwsReadOnly(args: string[], contentWrite?: AwsContentWrite): void {
  const command = args.slice(0, 2).join(' ')
  if (READ_ONLY.test(args[1] ?? '') || LOCAL_ONLY.has(command)) return
  if (contentWrite && process.env.SCROLLSDK_PREPARATION_STAGE !== 'aws' && CONTENT_WRITES[contentWrite].has(command)) return
  throw new Error(`scrollsdk does not create or change AWS resources; refusing aws ${command}. Manage AWS resources with the infrastructure templates`)
}

/** Thin `aws` CLI shell-out, mirroring the KmsSignerProvisioner conventions. */
export class AwsCliRunner {
  constructor(private readonly profile?: string) {}

  json(args: string[], options: AwsCliOptions = {}): any {
    return this.run(args, { ...options, json: true })
  }

  run(args: string[], options: AwsCliOptions = {}): any {
    assertAwsReadOnly(args, options.contentWrite)
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
      // Never fall back to execFileSync's message or the argv: arguments can
      // carry secrets (e.g. secretsmanager --secret-string).
      throw new Error(stderr || `aws ${args.slice(0, 2).join(' ')} failed (exit ${error?.status ?? error?.signal ?? 'unknown'})`)
    }
  }

  text(args: string[], options: AwsCliOptions = {}): string {
    return String(this.run(args, options))
  }
}

import {AwsCliRunner} from './aws-cli.js'

/** Read-only discovery used by the proof AWS wizard before it mutates AWS. */
export class ProofAwsDiscovery {
  private readonly aws: Pick<AwsCliRunner, 'json' | 'text'>
  private readonly environment: NodeJS.ProcessEnv

  constructor(
    profile?: string,
    aws?: Pick<AwsCliRunner, 'json' | 'text'>,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.aws = aws || new AwsCliRunner(profile)
    this.environment = environment
  }

  configuredRegion(): string | undefined {
    const environmentRegion = this.environment.AWS_REGION?.trim()
      || this.environment.AWS_DEFAULT_REGION?.trim()
    if (environmentRegion) return environmentRegion

    try {
      const configured = this.aws.text(['configure', 'get', 'region']).trim()
      return configured && configured !== 'None' ? configured : undefined
    } catch {
      return undefined
    }
  }

  eksClusters(region: string): string[] {
    const response = this.aws.json(['eks', 'list-clusters'], {region})
    const clusters: string[] = (Array.isArray(response?.clusters) ? response.clusters : [])
      .filter((value: unknown): value is string => typeof value === 'string' && value.trim() !== '')
      .map((value: string) => value.trim())
    return [...new Set(clusters)].sort()
  }
}

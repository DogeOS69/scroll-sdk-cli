export interface S3ArchiveUrlConfig {
  bucket?: string
  keyPrefix?: string
  publicBaseUrl?: string
  region?: string
}

export function buildS3PublicBaseUrl(config: S3ArchiveUrlConfig): string | undefined {
  const configured = config.publicBaseUrl?.trim()
  if (configured) return configured

  const bucket = config.bucket?.trim()
  const region = config.region?.trim()
  if (!bucket || !region) return undefined

  return `https://${bucket}.s3.${region}.amazonaws.com`
}

export function appendUrlPath(baseUrl: string | undefined, path: string | undefined): string | undefined {
  const base = baseUrl?.trim()
  if (!base) return undefined

  const cleanPath = path?.trim().replaceAll(/^\/+|\/+$/g, '')
  if (!cleanPath) return base

  return `${base.replaceAll(/\/+$/g, '')}/${cleanPath}`
}

export function buildS3PublicPrefixUrl(config: S3ArchiveUrlConfig): string | undefined {
  return appendUrlPath(buildS3PublicBaseUrl(config), config.keyPrefix)
}

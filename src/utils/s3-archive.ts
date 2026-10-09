/** Match eth-da-submitter's native prefix normalization; never rewrite object keys. */
export function normalizeS3ArchiveKeyPrefix(value = ''): string {
  const segments = value.trim().split('/').filter(Boolean)
  if (segments.some(segment => segment === '.' || segment === '..' || !/^[\w.-]+$/.test(segment))) {
    throw new Error("S3 archive key prefix segments may contain only ASCII letters, numbers, '.', '_', or '-'; . and .. are not allowed")
  }

  return segments.join('/')
}

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

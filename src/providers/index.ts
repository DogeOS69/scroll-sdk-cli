export * from './aws-node-public-p2p.js'
export * from './gcp-node-public-p2p.js'

// Provider registry
export const SUPPORTED_PROVIDERS = ['aws', 'gcp'] as const
export type SupportedProvider = typeof SUPPORTED_PROVIDERS[number]

export const PROVIDER_DISPLAY_NAMES = {
  aws: 'Amazon Web Services (AWS)',
  gcp: 'Google Cloud Platform (GCP)'
} as const 
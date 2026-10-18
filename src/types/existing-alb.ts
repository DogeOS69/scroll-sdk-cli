/** AWS resources are provisioned independently of application Helm releases. */
export interface ExistingAlbConfig {
  bindings: Record<string, {
    endpoint: string
    /** Actual Kubernetes Service name and numeric service port in the deployment namespace. */
    serviceRef: {name: string; port: number}
    targetGroupArn: string
  }>
  endpoints: Record<string, {
    listenerArn: string
    loadBalancerArn: string
  }>
  mode: 'existing'
}

/** Public edges owned by the AWS Load Balancer Controller, separate from external bindings. */
export interface SharedAlbConfig {
  certificateArn: string
  groupName: string
  services: Array<'blockscout-api' | 'blockscout-frontend' | 'frontends' | 'l2-reth-rpc-public' | 'l2-reth-rpc-public-ws'>
}

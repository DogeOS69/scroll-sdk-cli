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

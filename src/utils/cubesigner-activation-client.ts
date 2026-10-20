/* eslint-disable @typescript-eslint/no-explicit-any -- New read-only provider endpoints are absent from the installed SDK's generated types. */
import {CubeSignerClient, envs} from '@cubist-labs/cubesigner-sdk'
import {op} from '@cubist-labs/cubesigner-sdk/dist/src/fetch.js'
import {JsonFileSessionManager} from '@cubist-labs/cubesigner-sdk-fs-storage'
import os from 'node:os'
import path from 'node:path'

import {readCubesignerOrganization} from './cubesigner-organization.js'
import {readRoleScopedPolicyKey} from './cubesigner-policy-readback.js'
import {type PolicyReadbackClient} from './cubesigner-policy-reconcile.js'

export interface ActivationClient extends PolicyReadbackClient {
  apiRoot: string
  attestation(role: string): Promise<{jwt: string}>
  jwks(): Promise<unknown>
  sessions(role: string): Promise<any[]>
}
export async function connectActivationClient(sessionFile?: string): Promise<ActivationClient> {
  const client = await CubeSignerClient.create(new JsonFileSessionManager(sessionFile ?? process.env.CUBESIGNER_MANAGEMENT_TOKEN_FILE ?? path.join(os.homedir(), '.config/cubesigner/management-session.json')))
  const api = client.apiClient
  return {
    apiRoot: client.env.SignerApiRoot,
    // SDK 0.4.281's Full role endpoint: role-only access, never owner-only key attestation.
    attestation: role => api.exec((op as any)('/v0/org/{org_id}/roles/{role_id}/attest', 'get'), {params: {path: {role_id: role}, query: {verbosity: 'Full'}}} as any) as Promise<{jwt: string}>,
    authorities: async () => (await client.org().policyEngineConfiguration())?.allowed_http_authorities ?? [],
    environment: Object.entries(envs).find(([, env]) => env.SignerApiRoot === client.env.SignerApiRoot)?.[0] ?? 'unknown',
    async jwks() {
      const response = await fetch(`${client.env.SignerApiRoot.replace(/\/$/, '')}/v0/attestation/.well-known/jwks.json`, {signal: AbortSignal.timeout(15_000)})
      if (!response.ok) throw new Error('Provider attestation key lookup failed')
      return response.json()
    },
    key: (role, key) => readRoleScopedPolicyKey(api, role, key),
    ...await readCubesignerOrganization(client),
    policy: (name, version) => api.policyGet(name, version as `v${number}`),
    role: id => api.roleGet(id),
    sessions: id => api.sessionsList(id).fetchAll(),
  }
}

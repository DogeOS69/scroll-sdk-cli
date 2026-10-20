/* eslint-disable @typescript-eslint/no-explicit-any -- New read-only provider endpoints are absent from the installed SDK's generated types. */
import {CubeSignerClient, envs} from '@cubist-labs/cubesigner-sdk'
import {JsonFileSessionManager} from '@cubist-labs/cubesigner-sdk-fs-storage'
import os from 'node:os'
import path from 'node:path'

import {readRoleScopedPolicyKey} from './cubesigner-policy-readback.js'
import {type PolicyReadbackClient} from './cubesigner-policy-reconcile.js'

export interface ActivationClient extends PolicyReadbackClient {
  apiRoot: string
  sessions(role: string): Promise<any[]>
}
export async function connectActivationClient(sessionFile?: string): Promise<ActivationClient> {
  const client = await CubeSignerClient.create(new JsonFileSessionManager(sessionFile ?? process.env.CUBESIGNER_MANAGEMENT_TOKEN_FILE ?? path.join(os.homedir(), '.config/cubesigner/management-session.json')))
  const api = client.apiClient
  return {
    apiRoot: client.env.SignerApiRoot,
    authorities: async () => (await client.org().policyEngineConfiguration())?.allowed_http_authorities ?? [],
    environment: Object.entries(envs).find(([, env]) => env.SignerApiRoot === client.env.SignerApiRoot)?.[0] ?? 'unknown',
    key: (role, key) => readRoleScopedPolicyKey(api, role, key),
    organization: client.orgId,
    policy: (name, version) => api.policyGet(name, version as `v${number}`),
    role: id => api.roleGet(id),
    sessions: id => api.sessionsList(id).fetchAll(),
  }
}

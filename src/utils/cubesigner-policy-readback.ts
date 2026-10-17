import type {CubeSignerClient} from '@cubist-labs/cubesigner-sdk'

import {op} from '@cubist-labs/cubesigner-sdk/dist/src/fetch.js'

import {PolicyReconciliationError} from './cubesigner-policy-reconcile.js'

/** Older installed SDK types omit details/key_info, which the provider's role GET supports.
 * https://github.com/cubist-labs/CubeSigner-TypeScript-SDK/blob/main/packages/sdk/src/schema.ts
 * Never substitute the outer role-level policy for the nested key-level policy.
 */
export async function readRoleScopedPolicyKey(api: Pick<CubeSignerClient['apiClient'], 'exec'>, roleId: string, keyId: string): Promise<unknown> {
  const params = {path: {key_id: keyId, role_id: roleId}, query: {details: true}}
  const value: unknown = await api.exec(op('/v0/org/{org_id}/roles/{role_id}/keys/{key_id}', 'get'), {params})
  const response = value as {key_id?: string; key_info?: {key_id?: string}; role_id?: string} | undefined
  if (response?.role_id !== roleId || response?.key_id !== keyId || response.key_info?.key_id !== keyId) {
    throw new PolicyReconciliationError('Role-scoped key readback lacks matching detailed key_info; check role GetKey access')
  }

  return response.key_info
}

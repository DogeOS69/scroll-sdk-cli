interface OrganizationClient {
  org(): {fetch(): Promise<{name?: null | string; org_id: string}>}
  orgId: string
}

/** Resolve session aliases through the provider without rewriting session credentials. */
export async function readCubesignerOrganization(client: OrganizationClient): Promise<{organization: string; organizationName?: string}> {
  const org = await client.org().fetch()
  if (typeof org.org_id !== 'string' || !org.org_id.startsWith('Org#')
    || (client.orgId !== org.org_id && client.orgId !== org.name)) {
    throw new Error('Management session organization readback mismatch')
  }

  return {organization: org.org_id, organizationName: org.name || undefined}
}

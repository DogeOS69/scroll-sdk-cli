interface OrganizationClient {
  org(): {fetch(): Promise<{name?: null | string; org_id: string}>}
  orgId: string
}

/** Accept an alias only after provider readback binds it to the selected organization. */
export function matchesCubesignerOrganization(value: unknown, identity: {organization: string; organizationName?: string}): boolean {
  return typeof value === 'string' && value.length > 0 && (value === identity.organization || value === identity.organizationName)
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

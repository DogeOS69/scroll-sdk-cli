import type {ValidationError} from '../types/deployment-spec.js'

import {deploymentSpecFields} from '../generated/deployment-spec-fields.js'

/** Field/structure validation only; semantic and required-input checks remain in the generator. */
export function validateDeploymentSpecFields(value: unknown): ValidationError[] {
  const errors: ValidationError[] = []
  const error = (path: string, message: string): void => {
    // Preserve the established error contract for the controller's strict input schema.
    const code = path === 'dstackController' || path.startsWith('dstackController.')
      ? 'E015_INVALID_DSTACK_CONTROLLER_CONFIG' : 'E016_INVALID_SPEC_FIELD'
    errors.push({code, message, path})
  }

  function visit(input: unknown, schemaPath: string, displayPath: string): void {
    if (input === undefined) return
    const shape = deploymentSpecFields[schemaPath]
    if (!shape) {
      if (input !== null && typeof input === 'object') error(displayPath, 'must be a scalar value')
      return
    }

    if (shape.kind === 'array') {
      if (Array.isArray(input)) {input.forEach((item, index) => visit(item, `${schemaPath}[]`, `${displayPath}[${index}]`))}
      else {error(displayPath, 'must be an array')}

      return
    }

    if (!input || typeof input !== 'object' || Array.isArray(input) || input instanceof Date) {
      error(displayPath || '$', 'must be an object')
      return
    }

    for (const [key, item] of Object.entries(input)) {
      const child = displayPath ? `${displayPath}.${key}` : key
      if (shape.kind === 'record') visit(item, `${schemaPath}.*`, child)
      else if (shape.keys?.includes(key)) visit(item, `${schemaPath}.${key}`, child)
      else error(child, child === 'proofSystem' ? 'proofSystem has been removed; use compiler-backed proofTopology' : 'is not a supported DeploymentSpec field')
    }
  }

  visit(value, '$', '')
  const signing = (value as {signing?: {tsoServiceUrl?: unknown}} | null)?.signing
  if (signing?.tsoServiceUrl !== undefined) {
    error('signing.tsoServiceUrl', 'is not supported; configure frontend.hosts.tso for the public signer endpoint. In-cluster services use the internal TSO service address')
  }

  return errors
}

export function assertDeploymentSpecFields(value: unknown): void {
  const errors = validateDeploymentSpecFields(value)
  if (errors.length > 0) throw new Error(errors.map(({message, path}) => `${path}: ${message}`).join('; '))
}

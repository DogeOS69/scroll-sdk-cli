/**
 * Non-Interactive Mode Utilities for scroll-sdk-cli
 *
 * This module provides utilities for running CLI commands without interactive prompts.
 * When --non-interactive is set, all values must come from config files or fail fast.
 */

import chalk from 'chalk'

import { CliExitError, type ErrorResponse } from './json-output.js'

/**
 * Represents a missing field that was required but not found in config
 */
export interface MissingField {
  /** The config path where this field should be defined (e.g., "[db.admin].PUBLIC_HOST") */
  configPath: string
  /** Human-readable description of what this field is for */
  description: string
  /** The field/key name that was missing */
  field: string
}

/**
 * Context object for tracking non-interactive mode state during command execution
 */
export interface NonInteractiveContext {
  /** The command being executed (for error reporting) */
  command: string
  /** Whether non-interactive mode is enabled */
  enabled: boolean
  /** Whether JSON output mode is enabled */
  jsonOutput: boolean
  /** List of required fields that were missing */
  missingFields: MissingField[]
}

/**
 * Create a new non-interactive context for a command
 */
export function createNonInteractiveContext(
  command: string,
  nonInteractive: boolean,
  jsonOutput: boolean = false
): NonInteractiveContext {
  return {
    command,
    enabled: nonInteractive,
    jsonOutput,
    missingFields: [],
  }
}

/**
 * Resolve a value that might contain an environment variable reference.
 *
 * Supports the pattern: $ENV:VARIABLE_NAME
 *
 * @example
 * resolveEnvValue("$ENV:DB_PASSWORD") // Returns process.env.DB_PASSWORD or undefined
 * resolveEnvValue("literal-value")    // Returns "literal-value"
 */
export function resolveEnvValue(value: string | undefined): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  const envPattern = /^\$ENV:(\w+)$/
  const match = value.match(envPattern)

  if (match) {
    const envVarName = match[1]
    const envValue = process.env[envVarName]
    if (envValue === undefined) {
      console.error(chalk.yellow(`Warning: Environment variable ${envVarName} referenced via $ENV: is not set`))
      return undefined
    }

    if (envValue === '') {
      console.error(chalk.yellow(`Warning: Environment variable ${envVarName} is set but empty`))
      return undefined
    }

    return envValue
  }

  return value
}

/**
 * Check if a value is an unresolved environment variable reference
 */
export function isUnresolvedEnvRef(value: string | undefined): boolean {
  if (!value) return false
  return value.startsWith('$ENV:')
}

/**
 * In non-interactive mode, use the config value. In interactive mode, run the prompt.
 *
 * If non-interactive and value is missing, records it as a missing field (doesn't throw).
 *
 * @param ctx - The non-interactive context
 * @param promptFn - The async function that runs the interactive prompt
 * @param configValue - The value from config (may be undefined or contain $ENV: reference)
 * @param fieldMeta - Metadata about this field for error reporting
 * @param required - Whether this field is required (default: true)
 * @returns The resolved value, or undefined if missing in non-interactive mode
 */
export async function resolveOrPrompt<T extends string>(
  ctx: NonInteractiveContext,
  promptFn: () => Promise<T>,
  configValue: T | string | undefined,
  fieldMeta: Omit<MissingField, 'required'>,
  required: boolean = true
): Promise<T | undefined> {
  // Interactive mode - just run the prompt
  if (!ctx.enabled) {
    return promptFn()
  }

  // Non-interactive mode - try to resolve from config
  const resolved = resolveEnvValue(configValue as string) as T | undefined

  if (resolved !== undefined && resolved !== '') {
    return resolved
  }

  // Value is missing - record it if required
  if (required) {
    ctx.missingFields.push(fieldMeta)
  }

  return undefined
}

/**
 * Resolve a select/choice prompt in non-interactive mode.
 *
 * @param ctx - The non-interactive context
 * @param promptFn - The async function that runs the interactive select prompt
 * @param configValue - The value from config
 * @param validChoices - Array of valid choice values
 * @param fieldMeta - Metadata about this field for error reporting
 * @param required - Whether this field is required (default: true)
 */
export async function resolveOrSelect<T extends string>(
  ctx: NonInteractiveContext,
  promptFn: () => Promise<T>,
  configValue: T | string | undefined,
  validChoices: T[],
  fieldMeta: Omit<MissingField, 'required'>,
  required: boolean = true
): Promise<T | undefined> {
  // Interactive mode - just run the prompt
  if (!ctx.enabled) {
    return promptFn()
  }

  // Non-interactive mode - resolve and validate
  const resolved = resolveEnvValue(configValue as string) as T | undefined

  if (resolved !== undefined && resolved !== '') {
    // Validate the value is one of the valid choices
    if (validChoices.includes(resolved)) {
      return resolved
    }

    // Invalid value - record as missing with details
    ctx.missingFields.push({
      ...fieldMeta,
      description: `${fieldMeta.description}. Valid values: ${validChoices.join(', ')}. Got: "${resolved}"`,
    })
    return undefined
  }

  // Value is missing
  if (required) {
    ctx.missingFields.push({
      ...fieldMeta,
      description: `${fieldMeta.description}. Valid values: ${validChoices.join(', ')}`,
    })
  }

  return undefined
}

/**
 * Resolve a confirmation prompt in non-interactive mode.
 *
 * In non-interactive mode, confirmations default to true (proceed) unless
 * explicitly set to false in config.
 *
 * @param ctx - The non-interactive context
 * @param promptFn - The async function that runs the interactive confirm prompt
 * @param configValue - The value from config (boolean, string "true"/"false", or undefined)
 * @param defaultValue - Default value when not specified (default: true)
 */
export async function resolveConfirm(
  ctx: NonInteractiveContext,
  promptFn: () => Promise<boolean>,
  configValue: boolean | string | undefined,
  defaultValue: boolean = true
): Promise<boolean> {
  // Interactive mode - just run the prompt
  if (!ctx.enabled) {
    return promptFn()
  }

  // Non-interactive mode - resolve value
  if (configValue === undefined || configValue === null || configValue === '') {
    return defaultValue
  }

  if (typeof configValue === 'boolean') {
    return configValue
  }

  // Handle string values
  const strValue = String(configValue).toLowerCase()
  if (strValue === 'true' || strValue === 'yes' || strValue === '1') {
    return true
  }

  if (strValue === 'false' || strValue === 'no' || strValue === '0') {
    return false
  }

  return defaultValue
}

/**
 * Validate that all required fields were found. If any are missing, outputs
 * a structured error and throws CliExitError (allowing finally blocks to run).
 *
 * Call this after all resolveOrPrompt calls to ensure the command can proceed.
 *
 * @param ctx - The non-interactive context
 * @throws {CliExitError} if required fields are missing
 */
export function validateAndExit(ctx: NonInteractiveContext): void {
  if (ctx.missingFields.length === 0) {
    return
  }

  const message = `Missing ${ctx.missingFields.length} required configuration value(s) for non-interactive mode`
  const response: ErrorResponse = {
    command: ctx.command,
    error: {
      category: 'CONFIGURATION',
      code: 'E601_MISSING_FIELD',
      context: {
        missingFields: ctx.missingFields,
      },
      message,
      recoverable: true,
    },
    success: false,
    timestamp: new Date().toISOString(),
  }

  if (ctx.jsonOutput) {
    console.log(JSON.stringify(response, null, 2))
  } else {
    console.error(chalk.red(`\n✖ Non-interactive mode failed for command: ${ctx.command}`))
    console.error(chalk.red(`\nMissing ${ctx.missingFields.length} required configuration value(s):\n`))

    for (const field of ctx.missingFields) {
      console.error(chalk.yellow(`  • ${field.field}`))
      console.error(chalk.gray(`    Config path: ${field.configPath}`))
      console.error(chalk.gray(`    ${field.description}\n`))
    }

    console.error(chalk.cyan('To fix: Add these values to your config.toml file'))
    console.error(chalk.cyan('Or run without --non-interactive to use interactive prompts.\n'))
    console.error(chalk.gray('Tip: Use $ENV:VARIABLE_NAME syntax in config.toml for secrets'))
  }

  throw new CliExitError(response)
}

/**
 * Log a message to stderr (preserves stdout for JSON output)
 */
export function logToStderr(message: string): void {
  console.error(message)
}

/**
 * Check if we should skip a confirmation in non-interactive mode
 */
export function shouldSkipConfirmation(ctx: NonInteractiveContext): boolean {
  return ctx.enabled
}

/**
 * JSON Output Utilities for scroll-sdk-cli
 *
 * Provides structured JSON output for agent consumption.
 * JSON goes to stdout, human-readable logs go to stderr.
 */

import chalk from 'chalk'

/**
 * Custom error class for structured CLI errors.
 * Thrown instead of calling process.exit(1) so that finally blocks and
 * resource cleanup can run before the process terminates.
 *
 * Commands using oclif's `this.catch()` or top-level try/catch should
 * check for this error type and output the response before exiting.
 */
export class CliExitError extends Error {
  readonly code: string
  readonly category: ErrorCategory
  readonly recoverable: boolean
  readonly context?: Record<string, unknown>
  readonly response: ErrorResponse

  constructor(response: ErrorResponse) {
    super(response.error.message)
    this.name = 'CliExitError'
    this.code = response.error.code
    this.category = response.error.category
    this.recoverable = response.error.recoverable
    this.context = response.error.context
    this.response = response
  }
}

/**
 * Error categories for agent recovery strategies
 */
export type ErrorCategory =
  | 'CONFIGURATION'  // Config file issue
  | 'DOCKER'         // Container issues
  | 'FUNDING'        // Insufficient funds
  | 'INTERNAL'       // Unexpected error
  | 'KUBERNETES'     // K8s issues
  | 'NETWORK'        // RPC/API unreachable
  | 'PREREQUISITE'   // Missing dependency (docker, kubectl, etc.)
  | 'VALIDATION'     // Input validation failed

/**
 * Standard success response envelope
 */
export interface SuccessResponse<T> {
  command: string
  data: T
  duration_ms: number
  success: true
  timestamp: string
  warnings?: string[]
}

/**
 * Standard error response envelope
 */
export interface ErrorResponse {
  command: string
  duration_ms?: number
  error: {
    category: ErrorCategory
    code: string
    context?: Record<string, unknown>
    message: string
    recoverable: boolean
  }
  success: false
  timestamp: string
}

/**
 * Combined response type
 */
export type CommandResponse<T> = ErrorResponse | SuccessResponse<T>

/**
 * Context for tracking command execution and building responses
 */
export class JsonOutputContext {
  private command: string
  private jsonEnabled: boolean
  private startTime: number
  private warnings: string[] = []

  constructor(command: string, jsonEnabled: boolean = false) {
    this.command = command
    this.jsonEnabled = jsonEnabled
    this.startTime = Date.now()
  }

  /**
   * Check if JSON output is enabled
   */
  get isJsonEnabled(): boolean {
    return this.jsonEnabled
  }

  /**
   * Add a warning that will be included in the response
   */
  addWarning(message: string): void {
    this.warnings.push(message)
    // Also log to stderr for visibility
    if (!this.jsonEnabled) {
      console.error(chalk.yellow(`⚠ ${message}`))
    }
  }

  /**
   * Build and throw a structured error (as CliExitError).
   * Callers should let this propagate to the command's catch handler
   * which will output the response and exit cleanly after resource cleanup.
   */
  error(
    code: string,
    message: string,
    category: ErrorCategory,
    recoverable: boolean = false,
    context?: Record<string, unknown>
  ): never {
    const response: ErrorResponse = {
      command: this.command,
      duration_ms: this.getDuration(),
      error: {
        category,
        code,
        message,
        recoverable,
        ...(context && { context }),
      },
      success: false,
      timestamp: new Date().toISOString(),
    }

    if (this.jsonEnabled) {
      console.log(JSON.stringify(response, null, 2))
    } else {
      console.error(chalk.red(`\n✖ Error: ${message}`))
      console.error(chalk.gray(`  Code: ${code}`))
      console.error(chalk.gray(`  Category: ${category}`))
      console.error(chalk.gray(`  Recoverable: ${recoverable}`))
      if (context) {
        console.error(chalk.gray(`  Context: ${JSON.stringify(context)}`))
      }
    }

    throw new CliExitError(response)
  }

  /**
   * Log an info message
   */
  info(message: string): void {
    if (this.jsonEnabled) {
      console.error(chalk.blue(message))
    } else {
      console.log(chalk.blue(message))
    }
  }

  /**
   * Log a message (to stderr if JSON mode, to stdout otherwise)
   */
  log(message: string): void {
    if (this.jsonEnabled) {
      console.error(message)
    } else {
      console.log(message)
    }
  }

  /**
   * Log a key-value pair
   */
  logKeyValue(key: string, value: string): void {
    const formatted = `${chalk.cyan(key)} = ${chalk.green(`"${value}"`)}`
    if (this.jsonEnabled) {
      console.error(formatted)
    } else {
      console.log(formatted)
    }
  }

  /**
   * Log a section header
   */
  logSection(title: string): void {
    const formatted = chalk.bold.underline(`\n${title}`)
    if (this.jsonEnabled) {
      console.error(formatted)
    } else {
      console.log(formatted)
    }
  }

  /**
   * Log a success message (human-readable, not part of JSON response)
   */
  logSuccess(message: string): void {
    if (this.jsonEnabled) {
      console.error(chalk.green(message))
    } else {
      console.log(chalk.green(message))
    }
  }

  /**
   * Output a success response
   */
  success<T>(data: T): void {
    if (this.jsonEnabled) {
      const response: SuccessResponse<T> = {
        command: this.command,
        data,
        duration_ms: this.getDuration(),
        success: true,
        timestamp: new Date().toISOString(),
        ...(this.warnings.length > 0 && { warnings: this.warnings }),
      }
      console.log(JSON.stringify(response, null, 2))
    }
  }

  /**
   * Calculate duration since context creation
   */
  private getDuration(): number {
    return Date.now() - this.startTime
  }
}

/**
 * Error code definitions with metadata
 */
export const ERROR_CODES = {
  // Prerequisites (E1xx)
  E100_DOCKER_NOT_RUNNING: { category: 'PREREQUISITE' as ErrorCategory, recoverable: true },
  E101_CONFIG_NOT_FOUND: { category: 'CONFIGURATION' as ErrorCategory, recoverable: true },
  E102_DATA_DIR_MISSING: { category: 'CONFIGURATION' as ErrorCategory, recoverable: true },
  E103_DOGE_CONFIG_MISSING: { category: 'CONFIGURATION' as ErrorCategory, recoverable: true },
  E104_KUBECTL_NOT_CONNECTED: { category: 'PREREQUISITE' as ErrorCategory, recoverable: true },

  // Funding (E2xx)
  E200_HELPER_UNFUNDED: { category: 'FUNDING' as ErrorCategory, recoverable: true },
  E201_INSUFFICIENT_L1_BALANCE: { category: 'FUNDING' as ErrorCategory, recoverable: true },
  E202_UTXO_SPENT: { category: 'FUNDING' as ErrorCategory, recoverable: false },

  // Network (E3xx)
  E300_L1_RPC_UNREACHABLE: { category: 'NETWORK' as ErrorCategory, recoverable: true },
  E301_L2_RPC_UNREACHABLE: { category: 'NETWORK' as ErrorCategory, recoverable: true },
  E302_BLOCKBOOK_UNREACHABLE: { category: 'NETWORK' as ErrorCategory, recoverable: true },
  E303_CELESTIA_RPC_UNREACHABLE: { category: 'NETWORK' as ErrorCategory, recoverable: true },
  E304_DATABASE_UNREACHABLE: { category: 'NETWORK' as ErrorCategory, recoverable: true },

  // Docker (E4xx)
  E400_DOCKER_IMAGE_PULL_FAILED: { category: 'DOCKER' as ErrorCategory, recoverable: true },
  E401_DOCKER_CONTAINER_FAILED: { category: 'DOCKER' as ErrorCategory, recoverable: false },
  E402_DOCKER_TIMEOUT: { category: 'DOCKER' as ErrorCategory, recoverable: true },

  // Kubernetes (E5xx)
  E500_K8S_NOT_CONNECTED: { category: 'KUBERNETES' as ErrorCategory, recoverable: true },
  E501_INGRESS_NOT_FOUND: { category: 'KUBERNETES' as ErrorCategory, recoverable: false },
  E502_SECRET_PUSH_FAILED: { category: 'KUBERNETES' as ErrorCategory, recoverable: true },

  // Validation & Configuration (E6xx)
  E600_INVALID_ADDRESS: { category: 'VALIDATION' as ErrorCategory, recoverable: false },
  E601_MISSING_FIELD: { category: 'CONFIGURATION' as ErrorCategory, recoverable: true },
  E602_INVALID_CONFIG_FORMAT: { category: 'VALIDATION' as ErrorCategory, recoverable: false },

  // Internal (E9xx)
  E900_UNEXPECTED_ERROR: { category: 'INTERNAL' as ErrorCategory, recoverable: false },
} as const

/**
 * Get error metadata by code
 */
export function getErrorMeta(code: keyof typeof ERROR_CODES): {
  category: ErrorCategory
  recoverable: boolean
} {
  return ERROR_CODES[code] || ERROR_CODES.E900_UNEXPECTED_ERROR
}

/**
 * Create a simple error response object (without exiting)
 */
export function createErrorResponse(
  command: string,
  code: string,
  message: string,
  category: ErrorCategory,
  recoverable: boolean,
  context?: Record<string, unknown>
): ErrorResponse {
  return {
    command,
    error: {
      category,
      code,
      message,
      recoverable,
      ...(context && { context }),
    },
    success: false,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Create a simple success response object
 */
export function createSuccessResponse<T>(
  command: string,
  data: T,
  durationMs: number,
  warnings?: string[]
): SuccessResponse<T> {
  return {
    command,
    data,
    duration_ms: durationMs,
    success: true,
    timestamp: new Date().toISOString(),
    ...(warnings && warnings.length > 0 && { warnings }),
  }
}

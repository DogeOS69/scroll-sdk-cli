/**
 * JSON Output Utilities for scroll-sdk-cli
 *
 * Provides structured JSON output for agent consumption.
 * JSON goes to stdout, human-readable logs go to stderr.
 */

import chalk from 'chalk'

/**
 * Error categories for agent recovery strategies
 */
export type ErrorCategory =
  | 'PREREQUISITE'   // Missing dependency (docker, kubectl, etc.)
  | 'CONFIGURATION'  // Config file issue
  | 'NETWORK'        // RPC/API unreachable
  | 'FUNDING'        // Insufficient funds
  | 'DOCKER'         // Container issues
  | 'KUBERNETES'     // K8s issues
  | 'VALIDATION'     // Input validation failed
  | 'INTERNAL'       // Unexpected error

/**
 * Standard success response envelope
 */
export interface SuccessResponse<T> {
  success: true
  command: string
  timestamp: string
  duration_ms: number
  data: T
  warnings?: string[]
}

/**
 * Standard error response envelope
 */
export interface ErrorResponse {
  success: false
  command: string
  timestamp: string
  duration_ms?: number
  error: {
    code: string
    message: string
    category: ErrorCategory
    recoverable: boolean
    context?: Record<string, unknown>
  }
}

/**
 * Combined response type
 */
export type CommandResponse<T> = SuccessResponse<T> | ErrorResponse

/**
 * Context for tracking command execution and building responses
 */
export class JsonOutputContext {
  private startTime: number
  private warnings: string[] = []
  private command: string
  private jsonEnabled: boolean

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
   * Calculate duration since context creation
   */
  private getDuration(): number {
    return Date.now() - this.startTime
  }

  /**
   * Output a success response
   */
  success<T>(data: T): void {
    if (this.jsonEnabled) {
      const response: SuccessResponse<T> = {
        success: true,
        command: this.command,
        timestamp: new Date().toISOString(),
        duration_ms: this.getDuration(),
        data,
        ...(this.warnings.length > 0 && { warnings: this.warnings }),
      }
      console.log(JSON.stringify(response, null, 2))
    }
  }

  /**
   * Output an error response and exit
   */
  error(
    code: string,
    message: string,
    category: ErrorCategory,
    recoverable: boolean = false,
    context?: Record<string, unknown>
  ): never {
    if (this.jsonEnabled) {
      const response: ErrorResponse = {
        success: false,
        command: this.command,
        timestamp: new Date().toISOString(),
        duration_ms: this.getDuration(),
        error: {
          code,
          message,
          category,
          recoverable,
          ...(context && { context }),
        },
      }
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
    process.exit(1)
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

  // Validation (E6xx)
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
    success: false,
    command,
    timestamp: new Date().toISOString(),
    error: {
      code,
      message,
      category,
      recoverable,
      ...(context && { context }),
    },
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
    success: true,
    command,
    timestamp: new Date().toISOString(),
    duration_ms: durationMs,
    data,
    ...(warnings && warnings.length > 0 && { warnings }),
  }
}

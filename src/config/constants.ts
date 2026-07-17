import {DumpOptions} from 'js-yaml'
import * as fs from 'node:fs'
import {dirname} from 'node:path'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Common file paths used across the application
 */

// Setup defaults TOML file path relative to working directory
export const SETUP_DEFAULTS_TOML_PATH = '.data/setup_defaults.toml'
export const GENERATE_BRIDGE_INFO_FILE = '.data/GenerateBridgeInfo.toml'

// Get absolute path for setup defaults TOML
export const getSetupDefaultsPath = (): string => path.resolve(process.cwd(), SETUP_DEFAULTS_TOML_PATH)

/**
 * Template content readers
 */

// Get project root directory from this file location
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Calculate project root and source config directory
const projectRoot = path.resolve(__dirname, '../../')
const srcConfigDir = path.join(projectRoot, 'src/config')

// Read setup defaults template from file
export const getSetupDefaultsTemplate = (): string => {
  const templatePath = path.join(srcConfigDir, 'setup_defaults.toml')
  return fs.readFileSync(templatePath, 'utf8')
}

// Read doge config template from file
export const getDogeConfigTemplate = (): string => {
  const templatePath = path.join(srcConfigDir, 'doge-config.toml')
  return fs.readFileSync(templatePath, 'utf8')
}

// For backward compatibility, export as constants
export const SETUP_DEFAULTS_TEMPLATE = getSetupDefaultsTemplate()
export const DOGE_CONFIG_TEMPLATE = getDogeConfigTemplate()

/**
 * Internal l1-interface service endpoints consumed by L2 geth nodes.
 * These are cluster-local service names, not real Ethereum DA endpoints.
 */
export const L1_INTERFACE_RPC_ENDPOINT = 'http://l1-interface:8545'
export const L1_INTERFACE_RPC_WEBSOCKET_ENDPOINT = 'ws://l1-devnet:8546'
export const L1_INTERFACE_BEACON_API_ENDPOINT = 'http://l1-interface:5052'
export const L2_RPC_ENDPOINT = 'http://l2-rpc:8545'

/**
 * YAML formatting options
 */

/**
 * Standard YAML dump options for consistent formatting across all commands
 * This ensures all production.yaml files have the same format
 */
export const YAML_DUMP_OPTIONS: DumpOptions = {
  forceQuotes: false, // Force quotes on all strings
  lineWidth: -1, // No line width limit
  noRefs: true, // No references/anchors
  quotingType: '"', // Use double quotes
  styles: {'!!str': '|'},
}

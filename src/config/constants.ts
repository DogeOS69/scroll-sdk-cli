import * as path from 'path'
import * as fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname} from 'node:path'
import {DumpOptions} from 'js-yaml'

/**
 * Common file paths used across the application
 */

// Setup defaults TOML file path relative to working directory
export const SETUP_DEFAULTS_TOML_PATH = 'crates/test_utils/config/setup_defaults.toml'

// Get absolute path for setup defaults TOML
export const getSetupDefaultsPath = (): string => {
  return path.resolve(process.cwd(), SETUP_DEFAULTS_TOML_PATH)
}

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
  return fs.readFileSync(templatePath, 'utf-8')
}

// Read doge config template from file
export const getDogeConfigTemplate = (): string => {
  const templatePath = path.join(srcConfigDir, 'doge-config.toml')
  return fs.readFileSync(templatePath, 'utf-8')
}

// For backward compatibility, export as constants
export const SETUP_DEFAULTS_TEMPLATE = getSetupDefaultsTemplate()
export const DOGE_CONFIG_TEMPLATE = getDogeConfigTemplate()

/**
 * YAML formatting options
 */

/**
 * Standard YAML dump options for consistent formatting across all commands
 * This ensures all production.yaml files have the same format
 */
export const YAML_DUMP_OPTIONS: DumpOptions = {
  lineWidth: -1, // No line width limit
  noRefs: true, // No references/anchors
  quotingType: '"', // Use double quotes
  forceQuotes: false, // Force quotes on all strings
  styles: {'!!str': '|'},
}

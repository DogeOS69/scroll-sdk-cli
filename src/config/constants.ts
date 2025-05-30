import * as path from 'path'

/**
 * Common file paths used across the application
 */

// Setup defaults TOML file path relative to working directory
export const SETUP_DEFAULTS_TOML_PATH = 'crates/test_utils/config/setup_defaults.toml'

// Get absolute path for setup defaults TOML
export const getSetupDefaultsPath = (): string => {
  return path.resolve(process.cwd(), SETUP_DEFAULTS_TOML_PATH)
}

// Template setup defaults TOML path (relative to src/config)
export const SETUP_DEFAULTS_TEMPLATE_PATH = 'src/config/setup_defaults.toml' 
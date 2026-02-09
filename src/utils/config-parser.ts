import yaml from 'js-yaml'
import fs from 'node:fs'
import toml from 'toml'

export function parseYamlConfig(filePath: string): unknown {
  try {
    const fileContents = fs.readFileSync(filePath, 'utf8')
    return yaml.load(fileContents)
  } catch (error) {
    throw new Error(`Error parsing YAML config: ${error}`)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TOML parsing returns dynamic structure
export function parseTomlConfig(filePath: string): any {
  try {
    const fileContents = fs.readFileSync(filePath, 'utf8')
    return toml.parse(fileContents)
  } catch (error) {
    throw new Error(`Error parsing TOML config: ${error}`)
  }
}
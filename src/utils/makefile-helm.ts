export interface HelmUpgradeRecipe {
  chart: string
  release: string
  valuesFiles: string[]
  version?: string
}

/** Read direct Helm recipes without running make, a shell, or Make functions. */
export function parseHelmUpgradeRecipes(content: string): HelmUpgradeRecipe[] {
  const lines = content.replaceAll(/\\\r?\n\s*/g, ' ').split(/\r?\n/)
  const variables = new Map<string, string>()
  for (const line of lines) {
    const assignment = line.match(/^([A-Z_a-z]\w*)\s*(\?=|:=|\+=|=)\s*(.*?)\s*(?:#.*)?$/)
    if (!assignment) continue
    const [, name, operator, value] = assignment
    if (operator === '?=' && variables.has(name)) continue
    variables.set(name, operator === '+=' ? `${variables.get(name) || ''} ${value}`.trim() : value)
  }

  const expand = (value: string): string => {
    for (let depth = 0; depth < 20; depth++) {
      const next = value.replaceAll(/\$\(([A-Z_a-z]\w*)\)|\${([A-Z_a-z]\w*)}/g,
        (reference, parenthesized, braced) => variables.get(parenthesized || braced) ?? reference)
      if (next === value) break
      value = next
    }

    return value
  }

  const recipes: HelmUpgradeRecipe[] = []
  for (const line of lines) {
    if (!/^\t[+@-]*helm\s/.test(line)) continue
    const tokens = expand(line.replace(/^\t[+@-]*/, '')).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map(token => token.replaceAll(/"([^"]*)"|'([^']*)'/g, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted)) || []
    const upgradeIndex = tokens.indexOf('upgrade')
    if (upgradeIndex < 1) continue
    const args = tokens.slice(upgradeIndex + 1)
    const positional: string[] = []
    const valuesFiles: string[] = []
    let version: string | undefined
    for (let index = 0; index < args.length; index++) {
      const token = args[index]
      if (token.startsWith('#')) break
      if (['--atomic', '--create-namespace', '--install', '--wait', '-i'].includes(token)) continue
      const option = token.split('=')[0]
      if (['--kube-context', '--namespace', '--set', '--set-file', '--set-string', '--timeout', '--values', '--version', '-f', '-n'].includes(option)) {
        const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : args[++index]
        if (!value) throw new Error(`Missing ${option} value in Helm recipe`)
        if (option === '--version') version = value
        if (option === '-f' || option === '--values') valuesFiles.push(...value.split(','))
        continue
      }

      if (token.startsWith('-')) continue
      positional.push(token)
    }

    if (positional.length < 2) throw new Error('Cannot determine release and chart from Helm upgrade recipe')
    const [release, chart] = positional
    if ([release, chart, version || '', ...valuesFiles].some(value => /\$[({]/.test(value))) {
      throw new Error(`Unresolved Make variable or function in Helm recipe for ${release}; use a literal value or simple Make variable`)
    }

    recipes.push({chart, release, valuesFiles, ...(version ? {version} : {})})
  }

  return recipes
}

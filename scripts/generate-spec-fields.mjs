import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'src/types/deployment-spec.ts')
const program = ts.createProgram([entry], {strict: true, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, skipLibCheck: true})
const checker = program.getTypeChecker()
const source = program.getSourceFile(entry)
const declaration = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'DeploymentSpec')
const fields = {}

function visit(input, location, ancestors = new Set()) {
  const type = checker.getNonNullableType(input)
  if (ancestors.has(type)) throw new Error(`Recursive spec type at ${location}`)
  const parents = new Set([...ancestors, type])
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    throw new Error(`Unbounded spec type at ${location}; declare an explicit configuration shape`)
  }
  if (type.isUnion()) {
    if (type.types.some(member => member.flags & ts.TypeFlags.Object)) throw new Error(`Object union needs an explicit schema at ${location}`)
    return
  }
  if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return
  if (checker.isArrayType(type)) {
    fields[location] = {kind: 'array'}
    visit(checker.getTypeArguments(type)[0], `${location}[]`, parents)
    return
  }
  const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.String)
  if (indexed) {
    fields[location] = {kind: 'record'}
    visit(indexed, `${location}.*`, parents)
    return
  }
  const properties = checker.getPropertiesOfType(type).sort((a, b) => a.name > b.name ? 1 : -1)
  fields[location] = {keys: properties.map(property => property.name), kind: 'object'}
  for (const property of properties) {
    visit(checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? property.declarations[0]), `${location}.${property.name}`, parents)
  }
}

visit(checker.getTypeAtLocation(declaration), '$')
const output = `// Generated from DeploymentSpec and its referenced types. Run npm run spec:fields.\nexport const deploymentSpecFields: Record<string, {keys?: readonly string[]; kind: 'array' | 'object' | 'record'}> = {\n${Object.entries(fields).sort(([a], [b]) => a > b ? 1 : -1).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`).join('\n')}\n}\n`
const destination = path.join(root, 'src/generated/deployment-spec-fields.ts')
if (process.argv.includes('--check')) {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== output) {
    throw new Error('DeploymentSpec field table is stale; run npm run spec:fields and include the generated change')
  }
} else {
  fs.mkdirSync(path.dirname(destination), {recursive: true})
  fs.writeFileSync(destination, output)
}

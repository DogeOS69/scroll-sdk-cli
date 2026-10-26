import {Command, Flags} from '@oclif/core'

import {readProofArtifactStore} from '../../utils/artifact-stores.js'
import {readPublicationKit} from '../../utils/deployment-kit-publication.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {exportPreparationDeploymentKit, publishPreparationDeploymentKit} from '../../utils/preparation-deployment-kit.js'
import {normalizeProofKeyPrefix} from '../../utils/proof-aws-provisioner.js'

export default class PublishDeploymentKit extends Command {
  static description = 'Publish the canonical signer kit in the selected artifacts S3 bucket, verify anonymous HTTPS downloads, and record its URL and manifest hash'

  static flags = {
    apply: Flags.boolean({default: false, description: "Upload missing immutable objects and ensure the deployment's anonymous GetObject grant covers its deployment-kits/ namespace"}),
    'aws-profile': Flags.string({description: 'AWS profile used for kit publication'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
  }

  // Lower-level setup utility; retain direct access for focused maintenance.
  static override hidden = true

  async run(): Promise<void> {
    const {flags} = await this.parse(PublishDeploymentKit)
    const output = new JsonOutputContext('setup publish-deployment-kit', flags.json)
    try {
      const root = process.cwd()
      if (!flags.apply) {
        const {configPath, kit} = await exportPreparationDeploymentKit(root)
        const {store} = readProofArtifactStore(root, configPath)
        readPublicationKit(kit)
        output.success({applied: false, bucket: store.bucket, keyPrefix: `${normalizeProofKeyPrefix(store.keyPrefix)}/deployment-kits/${kit.kitVersion}/`, manifest_sha256: kit.manifestSha256, region: store.region, version: kit.kitVersion})
        return
      }

      const published = await publishPreparationDeploymentKit(root, flags['aws-profile'])
      output.info(`Governance reference: version ${published.version}, URL ${published.url}, manifest SHA-256 ${published.manifest_sha256}`)
      output.success({applied: true, ...published})
    } catch (error) {
      output.error('E805_DEPLOYMENT_KIT_PUBLICATION_FAILED', error instanceof Error ? error.message : 'Kit publication failed', 'CONFIGURATION', true)
    }
  }
}

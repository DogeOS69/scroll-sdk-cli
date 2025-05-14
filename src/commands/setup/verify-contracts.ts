import {select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import Docker from 'dockerode'

export default class ContractsVerification extends Command {
  static override description = 'Set up contracts verification'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --image-tag verify-03267b6897c93080973252acb202ddcde035be99',
  ]

  static override flags = {
    'image-tag': Flags.string({
      description: 'Specify the Docker image tag to use',
      required: false,
    }),
  }

  public async run(): Promise<void> {
    this.log(chalk.blue('Running docker command to contracts verification...'))

    const {flags} = await this.parse(ContractsVerification)

    const imageTag = await this.getDockerImageTag(flags['image-tag'])
    this.log(chalk.blue(`Using Docker image tag: ${imageTag}`))

    await this.runDockerCommand(imageTag)
  }

  private async fetchDockerTags(): Promise<string[]> {
    try {
      const response = await fetch(
        'https://registry.hub.docker.com/v2/repositories/dogeos69/scroll-stack-contracts/tags?page_size=100',
      )
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      return data.results.map((tag: any) => tag.name).filter((tag: string) => tag.startsWith('verify'))
    } catch (error) {
      this.error(`Failed to fetch Docker tags: ${error}`)
    }
  }

  private async getDockerImageTag(providedTag: string | undefined): Promise<string> {
    const defaultTag = 'verify-03267b6897c93080973252acb202ddcde035be99'

    if (!providedTag) {
      return defaultTag
    }

    const tags = await this.fetchDockerTags()

    if (providedTag.startsWith('gen-configs-v') && tags.includes(providedTag)) {
      return providedTag
    }

    if (providedTag.startsWith('v') && tags.includes(`verify-${providedTag}`)) {
      return `verify-${providedTag}`
    }

    if (/^\d+\.\d+\.\d+$/.test(providedTag) && tags.includes(`verify-v${providedTag}`)) {
      return `verify-v${providedTag}`
    }

    const selectedTag = await select({
      choices: tags.map((tag) => ({name: tag, value: tag})),
      message: 'Select a Docker image tag:',
    })

    return selectedTag
  }

  private async runDockerCommand(imageTag: string): Promise<void> {
    const docker = new Docker()
    const image = `dogeos69/scroll-stack-contracts:${imageTag}`

    try {
      this.log(chalk.cyan('Pulling Docker Image...'))
      // Pull the image if it doesn't exist locally
      const pullStream = await docker.pull(image)
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(pullStream, (err, res) => {
          if (err) {
            reject(err)
          } else {
            this.log(chalk.green('Image pulled successfully'))
            resolve(res)
          }
        })
      })

      this.log(chalk.cyan('Creating Docker Container...'))
      // Create and run the container
      const container = await docker.createContainer({
        Cmd: [], // Add any command if needed
        HostConfig: {
          Binds: [`${process.cwd()}:/contracts/volume`],
        },
        Image: image,
      })

      this.log(chalk.cyan('Starting Container'))
      await container.start()

      // Wait for the container to finish and get the logs
      const stream = await container.logs({
        follow: true,
        stderr: true,
        stdout: true,
      })

      // Print the logs
      stream.pipe(process.stdout)

      // Wait for the container to finish
      await new Promise((resolve) => {
        container.wait((err, data) => {
          if (err) {
            this.error(`Container exited with error: ${err}`)
          } else if (data.StatusCode !== 0) {
            this.error(`Container exited with status code: ${data.StatusCode}`)
          }

          resolve(null)
        })
      })

      // Remove the container
      await container.remove()
    } catch (error) {
      this.error(`Failed to run Docker command: ${error}`)
    }
  }
}

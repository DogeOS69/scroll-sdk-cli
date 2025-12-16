import {select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import Docker from 'dockerode'

import { CONTRACTS_DOCKER_DEFAULT_TAG, DOCKER_REPOSITORY, DOCKER_TAGS_URL } from '../../constants/docker.js'

export default class ContractsVerification extends Command {
  static override description = 'Set up contracts verification'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --image-tag verify-v0.2.0-debug',
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
        `${DOCKER_TAGS_URL}?page_size=100`,
      )
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      return data.results.map((tag: any) => tag.name).filter((tag: string) => tag.startsWith('verify-'))
    } catch (error) {
      this.error(`Failed to fetch Docker tags: ${error}`)
    }
  }

  private async getDockerImageTag(providedTag: string | undefined): Promise<string> {
    const defaultTag = `verify-${CONTRACTS_DOCKER_DEFAULT_TAG}`

    if (!providedTag) {
      return defaultTag
    }

    const tags = await this.fetchDockerTags()

    // If user gives full tag starting with "verify-", use it directly if it exists
    if (providedTag.startsWith('verify-') && tags.includes(providedTag)) {
      return providedTag
    }

    // If the user passes version without prefix, prepend "verify-" and check
    if (providedTag.startsWith('v') && tags.includes(`verify-${providedTag}`)) {
      return `verify-${providedTag}`
    }

    // If the user passes pure semantic version (e.g. 0.2.0), prepend "verify-v"
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
    const image = `${DOCKER_REPOSITORY}:${imageTag}`

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
      // Note: Container must run as root because forge is installed in /root/.foundry/
      // We fix file ownership after the container exits
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

      // Fix file ownership on POSIX systems (Docker runs as root, creates root-owned files)
      // Use a lightweight container to chown files since non-root can't chown root-owned files
      if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
        const uid = process.getuid()
        const gid = process.getgid()
        if (uid !== 0) {
          this.log(chalk.cyan('Fixing file ownership...'))
          try {
            // Pull alpine if not available
            try {
              await docker.pull('alpine:latest')
            } catch {
              // Ignore pull errors - image might already exist
            }

            const chownContainer = await docker.createContainer({
              Cmd: ['chown', '-R', `${uid}:${gid}`, '/volume'],
              HostConfig: {
                AutoRemove: true,
                Binds: [`${process.cwd()}:/volume`],
              },
              Image: 'alpine:latest',
            })
            await chownContainer.start()
            await chownContainer.wait()
          } catch (chownError) {
            this.log(chalk.yellow(`Warning: Could not fix file ownership: ${chownError}`))
            this.log(chalk.yellow('Files may be owned by root. Run: sudo chown -R $(id -u):$(id -g) .'))
          }
        }
      }
    } catch (error) {
      this.error(`Failed to run Docker command: ${error}`)
    }
  }
}
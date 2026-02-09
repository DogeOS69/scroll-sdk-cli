/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic YAML config operations */
import chalk from 'chalk'

import type { NodeLBProvider } from './aws-node-public-p2p.js'

export class GCPNodeStaticIPProvider implements NodeLBProvider {
  async checkPrerequisites(): Promise<boolean> {
    console.log(chalk.blue('Checking GCP prerequisites...'));
    console.log(chalk.red('GCP provider is not yet implemented'));
    return false;
  }

  async setupLb(flags: any, bootnodeCount: number): Promise<string[]> {
    console.log(chalk.blue('Starting GCP Node Static IP Setup...'));
    console.log(chalk.blue(`Will setup static IPs for ${bootnodeCount} bootnode(s)`));
    console.log(chalk.red('GCP provider is not yet implemented'));
    throw new Error('GCP provider is not yet implemented. Please use AWS provider for now.');
  }
} 
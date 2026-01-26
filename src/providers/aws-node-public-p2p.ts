/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic YAML config operations */
import { input } from '@inquirer/prompts'
import chalk from 'chalk'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { YAML_DUMP_OPTIONS } from '../config/constants.js'
import { executeCommand } from '../utils/command-executor.js'

export interface NodeLBProvider {
  checkPrerequisites(): Promise<boolean>
  setupLb(flags: any, bootnodeCount: number): Promise<string[]>
}

export class AWSNodeLBProvider implements NodeLBProvider {
  private accountId: string;
  private clusterName: string;
  private region: string;

  constructor() {
    this.region = '';
    this.clusterName = '';
    this.accountId = '';
  }

  async checkPrerequisites(): Promise<boolean> {
    const commands = [
      { cmd: 'aws --version', name: 'AWS CLI' },
      { cmd: 'eksctl version', name: 'eksctl' },
      { cmd: 'kubectl version --client', name: 'kubectl' },
      { cmd: 'helm version', name: 'Helm' }
    ];

    console.log(chalk.blue('Checking AWS prerequisites...'));

    for (const { cmd, name } of commands) {
      try {
        await executeCommand(cmd, false);
        console.log(chalk.green(`✓ ${name} is installed`));
      } catch {
        console.log(chalk.red(`✗ ${name} is not installed or not in PATH`));
        return false;
      }
    }

    try {
      await executeCommand('aws sts get-caller-identity', false);
      console.log(chalk.green('✓ AWS credentials configured'));
    } catch {
      console.log(chalk.red('✗ AWS credentials not configured, please run "aws configure"'));
      return false;
    }

    console.log(chalk.green('All AWS prerequisites met!'));
    return true;
  }

  async setupLb(flags: any, bootnodeCount: number): Promise<string[]> {
    console.log(chalk.blue('Starting AWS P2P Loadbalancer...'));
    console.log('====================================');

    if (flags['cluster-name']) {
      this.clusterName = flags['cluster-name'];
    } else {
      this.clusterName = await input({ message: 'Enter your EKS cluster name:' });
      if (!this.clusterName) {
        throw new Error('Cluster name cannot be empty');
      }
    }

    if (flags.region) {
      this.region = flags.region;
    } else {
      this.region = await input({ message: 'Enter your AWS region (e.g., us-east-2):' });
      if (!this.region) {
        throw new Error('AWS region cannot be empty');
      }
    }

    console.log('Verifying cluster exists...');
    const clusterExists = await this.verifyClusterExists(this.clusterName, this.region);
    if (!clusterExists) {
      throw new Error(`Cluster '${this.clusterName}' not found in region '${this.region}'`);
    }

    this.accountId = await this.getAwsAccountId();

    console.log('Configuration:');
    console.log(`  Cluster: ${this.clusterName}`);
    console.log(`  Region: ${this.region}`);
    console.log(`  Account ID: ${this.accountId}`);
    console.log('');

    try {
      await this.configureIamPermissions(this.accountId);
      await this.installLoadBalancerController(this.clusterName, this.region);
      console.log(chalk.blue(`Setting up LB for ${bootnodeCount} bootnode(s)`))

      const valuesDir = flags['values-dir']
      await this.updateProductionFiles(valuesDir, bootnodeCount, this.region, this.clusterName);

      const verificationPassed = await this.verifyAwsSetup(this.accountId, this.region, bootnodeCount);
      if (verificationPassed) {
        console.log(chalk.green('🚀 AWS P2P setup completed successfully!'));
      } else {
        console.log(chalk.yellow('⚠️  AWS P2P setup completed with warnings - some verification checks failed'));
        console.log(chalk.yellow('💡 You may need to troubleshoot the failed components before deployment'));
        throw new Error('AWS P2P setup failed');
      }

      const ns = flags.namespace || 'default';
      console.log(chalk.blue('💡 To get LoadBalancer domains after deployment:'));
      for (let i = 0; i < bootnodeCount; i++) {
        console.log(chalk.blue(`  kubectl get service l2-bootnode-${i}-p2p -n ${ns} -o jsonpath='{.status.loadBalancer.ingress[0].hostname}{\\"\\n\\"}'`));
      }

      return [];
    } catch (error) {
      console.log(chalk.red('Error occurred during AWS setup:'));
      console.log(chalk.red(error instanceof Error ? error.message : String(error)));
      throw new Error('AWS P2P Load Balancer setup failed');
    }
  }

  private async configL2BootnodeP2p(doc: any, index: number, region?: string, clusterName?: string) {

    if (!doc.service) doc.service = {};
    if (!doc.service.p2p) doc.service.p2p = {};

    const p2pCfg = doc.service.p2p;
    p2pCfg.enabled = true;

    if (!p2pCfg.annotations || typeof p2pCfg.annotations !== 'object') {
      p2pCfg.annotations = {};
    }

    const {annotations} = p2pCfg;

    annotations['service.beta.kubernetes.io/aws-load-balancer-type'] ||= 'nlb';
    annotations['service.beta.kubernetes.io/aws-load-balancer-scheme'] ||= 'internet-facing';
    annotations['service.beta.kubernetes.io/aws-load-balancer-nlb-target-type'] ||= 'ip';
    annotations['service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled'] = 'true';
    const lbNamePrefix = clusterName ? `${clusterName}-` : '';
    annotations['service.beta.kubernetes.io/aws-load-balancer-name'] = `${lbNamePrefix}b-${index}`;
  }

  private async configureIamPermissions(accountId: string): Promise<void> {
    console.log(chalk.blue('Configuring IAM permissions for AWS Load Balancer Controller...'));

    // 1. Associate IAM OIDC provider
    console.log('Associating IAM OIDC provider...');
    try {
      await executeCommand(`eksctl utils associate-iam-oidc-provider --region "${this.region}" --cluster "${this.clusterName}" --approve`);
      console.log(chalk.green('✓ IAM OIDC provider associated'));
    } catch {
      console.log(chalk.yellow('⚠️  IAM OIDC provider may already be associated'));
    }

    // 2. Download IAM policy JSON
    console.log('Downloading AWS Load Balancer Controller IAM policy...');
    const policyFile = 'iam_policy.json';
    try {
      await executeCommand(`curl -o ${policyFile} https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json`);
      console.log(chalk.green(`✓ IAM policy downloaded to ${policyFile}`));
    } catch {
      throw new Error('Failed to download IAM policy file');
    }

    // 3. Get policy name from user or use default
    const policyName = 'AWSLoadBalancerControllerIAMPolicy';
    
    // 4. Create IAM policy
    console.log(`Creating IAM policy: ${policyName}...`);
    try {
      await executeCommand(`aws iam create-policy --policy-name "${policyName}" --policy-document file://${policyFile}`);
      console.log(chalk.green(`✓ IAM policy ${policyName} created`));
    } catch {
      console.log(chalk.yellow(`⚠️  IAM policy ${policyName} may already exist`));
    }

    // 5. Get service account name from user or use default
    const serviceAccountName = 'aws-load-balancer-controller';
   
    // 6. Create IAM service account
    console.log(`Creating IAM service account: ${serviceAccountName}...`);
    const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;
    
    try {
      await executeCommand(`eksctl create iamserviceaccount \
        --cluster "${this.clusterName}" \
        --namespace kube-system \
        --name "${serviceAccountName}" \
        --attach-policy-arn "${policyArn}" \
        --override-existing-serviceaccounts \
        --approve \
        --region "${this.region}"`);
      console.log(chalk.green(`✓ IAM service account ${serviceAccountName} created with policy ${policyName}`));
    } catch (error) {
      throw new Error(`Failed to create IAM service account: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 7. Clean up downloaded policy file
    try {
      if (fs.existsSync(policyFile)) {
        fs.unlinkSync(policyFile);
        console.log(chalk.green(`✓ Cleaned up ${policyFile}`));
      }
    } catch {
      console.log(chalk.yellow(`⚠️  Could not clean up ${policyFile}`));
    }

    console.log(chalk.green('IAM permissions configured successfully!'));
  }

  private async getAwsAccountId(): Promise<string> {
    const { stdout } = await executeCommand('aws sts get-caller-identity --query "Account" --output text', false);
    return stdout.trim();
  }

  private async installLoadBalancerController(clusterName: string, region: string): Promise<void> {

    console.log('Adding EKS Helm repository...');
    await executeCommand('helm repo add eks https://aws.github.io/eks-charts');
    await executeCommand('helm repo update');

    const { stdout: vpcId } = await executeCommand(`aws eks describe-cluster --name "${clusterName}" --region "${region}" --query "cluster.resourcesVpcConfig.vpcId" --output text`, false);

    console.log('Installing or upgrading AWS Load Balancer Controller...');

    await executeCommand(`helm upgrade -i aws-load-balancer-controller eks/aws-load-balancer-controller \
        -n kube-system \
        --set clusterName="${clusterName}" \
        --set serviceAccount.create=false \
        --set serviceAccount.name=aws-load-balancer-controller \
        --set region="${region}" \
        --set vpcId="${vpcId.trim()}"`);


    console.log('Waiting for AWS Load Balancer Controller to be ready...');

    try {
      await executeCommand('kubectl wait --for=condition=available --timeout=180s deployment/aws-load-balancer-controller -n kube-system', false);
    } catch {
      console.log(chalk.yellow('Deployment not ready within timeout, checking pod status...'));

      try {
        const { stdout } = await executeCommand('kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller -o jsonpath="{.items[*].status.phase}"', false);
        const { stdout: podNames } = await executeCommand('kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller -o jsonpath="{.items[*].metadata.name}"', false);

        console.log(`Pod statuses: ${stdout}`);

        const pods = podNames.split(' ').filter(Boolean);
        for (const pod of pods) {
          try {
            const { stdout: logs } = await executeCommand(`kubectl logs ${pod} -n kube-system --tail=5`, false);
            if (logs.includes('Unauthorized') || logs.includes('unable to create controller')) {
              throw new Error(`AWS Load Balancer Controller pod ${pod} has permission issues. This usually indicates the IAM service account was not created properly.`);
            }
          } catch {
          }
        }
      } catch {
      }

      throw new Error('AWS Load Balancer Controller failed to become ready within timeout');
    }

    try {
      const { stdout } = await executeCommand('kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller --field-selector=status.phase=Running --no-headers | wc -l', false);
      const runningPods = Number.parseInt(stdout.trim(), 10);
      if (runningPods === 0) {
        throw new Error('No AWS Load Balancer Controller pods are running');
      }

      console.log(chalk.green(`✓ ${runningPods} AWS Load Balancer Controller pod(s) running`));
    } catch {
      throw new Error('Failed to verify AWS Load Balancer Controller pod status');
    }

    console.log(chalk.green('AWS Load Balancer Controller installed successfully!'));
  }

  /**
   * Safely parse AWS CLI JSON output. When the CLI returns the literal strings
   * "None", "null" or an empty value, JSON.parse will throw. This helper
   * normalises those cases to null and suppresses parse errors so that the
   * caller can handle them gracefully.
   */
  private safeJsonParse(input: string): any | null {
    try {
      const trimmed = input?.trim();
      if (!trimmed || trimmed === 'None' || trimmed === 'null') {
        return null;
      }

      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private async updateProductionFiles(valuesDir: string, bootnodeCount: number, region: string, clusterName: string): Promise<void> {
    console.log(chalk.blue('Updating production YAML files...'));

    for (let i = 0; i < bootnodeCount; i++) {
      const prodFile = path.join(valuesDir, `l2-bootnode-production-${i}.yaml`);

      if (fs.existsSync(prodFile)) {
        console.log(`Updating ${prodFile}...`);

        let content = fs.readFileSync(prodFile, 'utf8');

        const yamlData = yaml.load(content) as any;

        await this.configL2BootnodeP2p(yamlData, i, region, clusterName);

        content = yaml.dump(yamlData, YAML_DUMP_OPTIONS);
        fs.writeFileSync(prodFile, content);

        // console.log(chalk.green(`Updated ${prodFile} with allocation ID: ${allocationIds[i]}`));
      } else {
        console.log(chalk.yellow(`Production file ${prodFile} not found, skipping...`));
      }
    }
  }

  private async verifyAwsSetup(_accountId: string, _region: string, _bootnodeCount: number): Promise<boolean> {
    console.log(chalk.blue('Verifying setup...'));

    let allChecksPass = true;

    try {
      const { stdout } = await executeCommand(`kubectl get deployment aws-load-balancer-controller -n kube-system -o jsonpath='{.status.conditions[?(@.type=="Available")].status}'`, false);
      if (stdout.trim() === 'True') {
        console.log(chalk.green('✓ AWS Load Balancer Controller is running'));
      } else {
        console.log(chalk.red('✗ AWS Load Balancer Controller is not ready'));
        allChecksPass = false;
      }
    } catch {
      console.log(chalk.red('✗ AWS Load Balancer Controller not found'));
      allChecksPass = false;
    }

    return allChecksPass;
  }

  private async verifyClusterExists(clusterName: string, region: string): Promise<boolean> {
    try {
      await executeCommand(`aws eks describe-cluster --name "${clusterName}" --region "${region}"`, false);
      return true;
    } catch {
      return false;
    }
  }
} 
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { spawn } from 'node:child_process';

export interface CommandResult {
  stderr: string;
  stdout: string;
}

export interface CommandError extends Error {
  code?: null | number;
  stderr?: string;
  stdout?: string;
}

/**
 * Execute a command with real-time output display
 * @param command The command to execute
 * @param prompt Whether to prompt user for confirmation, defaults to true
 * @returns Promise<CommandResult> Result object containing stdout and stderr
 */
export async function executeCommand(
  command: string,
  prompt: boolean = false
): Promise<CommandResult> {
  if (prompt) {
    const confirmation = await confirm({
      default: true,
      message: `\n${command}\nThis will execute the command: `
    });
    if (!confirmation) {
      throw new Error('Command execution cancelled by user');
    }
  }

  const topLine = chalk.gray('-'.repeat(80));
  console.log(topLine);
  console.log(chalk.blue(`$ ${command}`));
  console.log(chalk.gray('------'));
  
  return new Promise((resolve, reject) => {
    const process = spawn(command, [], { 
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      console.log(text.trim());
    });
    
    process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      console.log(chalk.yellow(text.trim()));
    });
    
    process.on('close', (code: null | number) => {
      if (code === 0) {
        console.log(chalk.green(`✓ Command completed successfully`));
        console.log(topLine);
        resolve({ stderr: stderr.trim(), stdout: stdout.trim() });
      } else {
        console.log(chalk.red(`✗ Command failed with exit code ${code}`));
        console.log(topLine);
        const error = new Error(`Command failed with exit code ${code}`) as CommandError;
        error.stdout = stdout.trim();
        error.stderr = stderr.trim();
        error.code = code;
        reject(error);
      }
    });
    
    process.on('error', (error: Error) => {
      console.log(topLine);
      console.log(chalk.red(`✗ Command error: ${error.message}`));
      reject(error);
    });
  });
} 
import * as readline from 'readline';
import * as crypto from 'crypto';
import { execFileSync } from 'node:child_process';
import { setPassword, isPasswordSet } from './auth/password.service';
import { saveServerConfig, config } from './config';
import { generateSelfSignedCert } from './tls/cert.generator';
import { logger } from './utils/logger';
import { macBuildScriptPath } from './remote/paths';

/** Builds the macOS remote helper. Failing here costs remote access, nothing else. */
function buildRemoteHelper(): void {
  if (process.platform !== 'darwin') return;
  const script = macBuildScriptPath();
  try {
    execFileSync('bash', [script], { stdio: 'inherit' });
  } catch {
    console.warn(
      'Fernzugriffs-Helfer konnte nicht gebaut werden. Der Server laeuft normal weiter;\n' +
      'fuer den Fernzugriff spaeter nachholen mit:\n' +
      `  bash ${script}`,
    );
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function main(): Promise<void> {
  logger.info('\n╔══════════════════════════════════════╗');
  logger.info('║      TMS Terminal – Setup Wizard     ║');
  logger.info('╚══════════════════════════════════════╝\n');

  // Password
  if (isPasswordSet()) {
    const change = await question('Password already set. Change it? (y/N): ');
    if (change.toLowerCase() === 'y') {
      const pw = await question('New password: ');
      if (pw.length < 8) {
        logger.error('Password must be at least 8 characters');
        rl.close();
        process.exit(1);
      }
      await setPassword(pw);
      logger.success('Password updated');
    }
  } else {
    const pw = await question('Set a password for remote access: ');
    if (pw.length < 8) {
      logger.error('Password must be at least 8 characters');
      rl.close();
      process.exit(1);
    }
    await setPassword(pw);
    logger.success('Password saved');
  }

  // Port
  const portInput = await question(`Port (default ${config.port}): `);
  const port = portInput ? parseInt(portInput, 10) : config.port;
  if (isNaN(port) || port < 1 || port > 65535) {
    logger.error('Invalid port');
    rl.close();
    process.exit(1);
  }
  saveServerConfig({ port });
  logger.success(`Port set to ${port}`);

  // JWT Secret
  const jwtSecret = crypto.randomBytes(64).toString('hex');
  saveServerConfig({ jwtSecret });
  logger.success('JWT secret generated');

  // TLS Certificate
  const certInfo = generateSelfSignedCert();
  logger.info(`\n  Certificate fingerprint (SHA-256):`);
  logger.info(`  ${certInfo.fingerprint}\n`);
  logger.info('  Save this fingerprint to verify the connection in the app.\n');

  buildRemoteHelper();

  logger.info('Setup complete! Start the server with: npm run dev\n');
  rl.close();
}

main().catch((err) => {
  logger.error(err.message);
  rl.close();
  process.exit(1);
});

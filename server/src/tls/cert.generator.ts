import * as forge from 'node-forge';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { config, saveServerConfig } from '../config';
import { logger } from '../utils/logger';

export interface CertInfo {
  certPath: string;
  keyPath: string;
  fingerprint: string;
}

export function generateSelfSignedCert(): CertInfo {
  const certsDir = config.certsDir;
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  }

  // Check if cert already exists
  if (fs.existsSync(config.certFile) && fs.existsSync(config.keyFile)) {
    const certPem = fs.readFileSync(config.certFile, 'utf-8');
    const fingerprint = getFingerprint(certPem);
    logger.info('Using existing TLS certificate');
    return { certPath: config.certFile, keyPath: config.keyFile, fingerprint };
  }

  logger.info('Generating self-signed TLS certificate...');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(16).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

  const attrs = [
    { name: 'commonName', value: 'TMS Terminal Server' },
    { name: 'organizationName', value: 'TMS Terminal' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: '127.0.0.1' },
        { type: 2, value: 'localhost' },
      ],
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  fs.writeFileSync(config.certFile, certPem, { mode: 0o644 });
  fs.writeFileSync(config.keyFile, keyPem, { mode: 0o600 });

  const fingerprint = getFingerprint(certPem);

  saveServerConfig({ certFingerprint: fingerprint });
  logger.success('TLS certificate generated');

  return { certPath: config.certFile, keyPath: config.keyFile, fingerprint };
}

function getFingerprint(certPem: string): string {
  const der = forge.pki.pemToDer(certPem);
  const hash = crypto.createHash('sha256').update(Buffer.from(der.getBytes(), 'binary')).digest('hex');
  return (hash.match(/.{2}/g) ?? []).join(':').toUpperCase();
}

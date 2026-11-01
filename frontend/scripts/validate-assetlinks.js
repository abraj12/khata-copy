/**
 * Digital Asset Links Validator
 * Verifies that frontend/public/.well-known/assetlinks.json conforms strictly to Google Digital Asset Links spec.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const assetlinksPath = path.resolve(__dirname, '../public/.well-known/assetlinks.json');

console.log('[VALIDATOR] Checking Digital Asset Links:', assetlinksPath);

if (!fs.existsSync(assetlinksPath)) {
  console.error('[ERROR] assetlinks.json not found at:', assetlinksPath);
  process.exit(1);
}

let content;
try {
  content = JSON.parse(fs.readFileSync(assetlinksPath, 'utf8'));
} catch (err) {
  console.error('[ERROR] Failed to parse assetlinks.json as JSON:', err.message);
  process.exit(1);
}

if (!Array.isArray(content) || content.length === 0) {
  console.error('[ERROR] assetlinks.json must be a non-empty JSON array.');
  process.exit(1);
}

const SHA256_FINGERPRINT_REGEX = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;

for (const [idx, entry] of content.entries()) {
  if (!entry.relation || !entry.relation.includes('delegate_permission/common.handle_all_urls')) {
    console.error(`[ERROR] Entry ${idx}: relation must contain "delegate_permission/common.handle_all_urls"`);
    process.exit(1);
  }

  if (!entry.target || entry.target.namespace !== 'android_app') {
    console.error(`[ERROR] Entry ${idx}: target.namespace must be "android_app"`);
    process.exit(1);
  }

  if (entry.target.package_name !== 'in.algions.khata') {
    console.error(`[ERROR] Entry ${idx}: target.package_name must be "in.algions.khata", received: "${entry.target.package_name}"`);
    process.exit(1);
  }

  if (!Array.isArray(entry.target.sha256_cert_fingerprints) || entry.target.sha256_cert_fingerprints.length === 0) {
    console.error(`[ERROR] Entry ${idx}: sha256_cert_fingerprints must be a non-empty array`);
    process.exit(1);
  }

  for (const fp of entry.target.sha256_cert_fingerprints) {
    if (!SHA256_FINGERPRINT_REGEX.test(fp)) {
      console.error(`[ERROR] Entry ${idx}: Invalid SHA-256 fingerprint format: "${fp}"`);
      process.exit(1);
    }
  }
}

console.log('[SUCCESS] Digital Asset Links validation passed: in.algions.khata configured correctly with valid SHA-256 fingerprints.');

import argon2 from 'argon2';
import readline from 'readline';

/**
 * Interactive Hidden-Input Password Prompt (No terminal echo, no command-line args)
 */
function promptHiddenPassword(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    process.stdout.write(promptText);

    // Mute stdout during password entry to prevent echoing
    const stdin = process.stdin;
    let password = '';

    const onData = (char: Buffer) => {
      const str = char.toString('utf-8');
      for (const ch of str) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          rl.close();
          process.stdout.write('\n');
          resolve(password);
          return;
        } else if (ch === '\u0008' || ch === '\x7f') {
          // Backspace
          password = password.slice(0, -1);
        } else if (ch.charCodeAt(0) >= 32) {
          password += ch;
        }
      }
    };

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  console.log('\n======================================================');
  console.log('   Khata Owner Argon2id Password Hash Generator       ');
  console.log('======================================================');
  console.log('This script securely hashes your password with Argon2id.');
  console.log('Input is hidden and will never be echoed or saved.\n');

  try {
    const pass1 = await promptHiddenPassword('Enter owner password: ');
    if (!pass1 || pass1.length < 8) {
      console.error('\x1b[31m[ERROR] Password must be at least 8 characters long.\x1b[0m');
      process.exit(1);
    }

    const pass2 = await promptHiddenPassword('Confirm owner password: ');
    if (pass1 !== pass2) {
      console.error('\x1b[31m[ERROR] Passwords do not match. Please try again.\x1b[0m');
      process.exit(1);
    }

    console.log('\nComputing Argon2id hash (memory: 64MB, time: 3 passes, parallelism: 4)...');

    const hash = await argon2.hash(pass1, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MB
      timeCost: 3,       // 3 iterations
      parallelism: 4,    // 4 parallel threads
    });

    console.log('\n\x1b[32m[SUCCESS] Hash generated successfully!\x1b[0m\n');
    console.log('Copy this value to your Render Environment Variable OWNER_PASSWORD_HASH:');
    console.log('------------------------------------------------------------------------');
    console.log(hash);
    console.log('------------------------------------------------------------------------\n');
    console.log('NOTE: When rotating password, remember to invalidate old sessions in PostgreSQL.');
  } catch (err) {
    console.error('[ERROR]', (err as Error).message);
    process.exit(1);
  }
}

main();

'use strict';

// Only run for global installs — skip when used as a local dependency.
if (process.env.npm_config_global !== 'true') process.exit(0);

const { homedir } = require('node:os');
const { join } = require('node:path');
const { readFileSync, appendFileSync, existsSync } = require('node:fs');

const MARKER = '# mnemon shell completion';

function tryAppend(rcFile, shell) {
  try {
    const content = existsSync(rcFile) ? readFileSync(rcFile, 'utf8') : '';
    if (content.includes(MARKER)) return; // already set up
    appendFileSync(rcFile, `\n${MARKER}\neval "$(mnemon --completion ${shell})"\n`);
    console.log(`[mnemon] Shell completion enabled. Run: source ${rcFile}`);
  } catch {
    // No write permission or other OS error — skip silently.
  }
}

const shell = process.env.SHELL ?? '';
const home = homedir();

if (shell.endsWith('zsh')) {
  tryAppend(join(home, '.zshrc'), 'zsh');
} else if (shell.endsWith('bash')) {
  const rc = process.platform === 'darwin'
    ? join(home, '.bash_profile')
    : join(home, '.bashrc');
  tryAppend(rc, 'bash');
}

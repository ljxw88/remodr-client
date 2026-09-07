#!/usr/bin/env node
const { execFileSync } = require('child_process');

function run(env = process.env) {
  if (/^refs\/tags\/v.+$/.test(env.GITHUB_REF || '')) return 0;
  if (env.GITHUB_REF !== 'refs/heads/main') {
    console.error('Releases must run from main or a v-prefixed version tag.');
    return 1;
  }

  // Query the remote rather than the checkout's potentially stale origin/main.
  const mainSha = execFileSync(
    'git',
    ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'],
    { encoding: 'utf8' },
  ).trim().split(/\s+/)[0];
  if (!mainSha || mainSha !== env.GITHUB_SHA) {
    console.error(`Refusing stale preview: build ${env.GITHUB_SHA}, current main ${mainSha}.`);
    return 1;
  }
  return 0;
}

module.exports = { run };

if (require.main === module) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`Unable to verify release source: ${error.message}`);
    process.exitCode = 1;
  }
}

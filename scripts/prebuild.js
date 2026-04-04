#!/usr/bin/env node
// Generate build-info.json with git commit hash and build date
const fs = require('fs');
const { execSync } = require('child_process');

const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: 'pipe' }).toString().trim();
  } catch {
    return 'unknown';
  }
})();

const date = new Date().toISOString().slice(0, 10);

fs.writeFileSync(
  'src/main/build-info.json',
  JSON.stringify({ commit, date })
);

console.log(`[prebuild] commit=${commit} date=${date}`);

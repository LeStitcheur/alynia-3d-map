// npm run deploy [-- "message de commit"]
//  1. commits every change and pushes the source code to `main`
//  2. publishes public/ to the `gh-pages` branch (served by GitHub Pages)
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import ghpages from 'gh-pages';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const REPO = pkg.repository.url;
const BRANCH = 'main';

const sh = (cmd) => execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim();
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

if (!existsSync('public/model/hospital.glb')) {
  console.error('public/model/hospital.glb manquant : lancez d\'abord `npm run build:model`.');
  process.exit(1);
}

// --- 1. source -> main -------------------------------------------------------
if (!existsSync('.git')) run(`git init -b ${BRANCH}`);
const ident = (k) => { try { return sh(`git config ${k}`); } catch { return ''; } };
if (!ident('user.name') || !ident('user.email')) {
  console.error('Identité Git manquante. Configurez-la une fois :\n  git config --global user.name "Votre nom"\n  git config --global user.email "vous@exemple.com"');
  process.exit(1);
}
const remotes = sh('git remote').split('\n');
if (!remotes.includes('origin')) run(`git remote add origin ${REPO}`);
else if (sh('git remote get-url origin') !== REPO) run(`git remote set-url origin ${REPO}`);

run('git add -A');
if (sh('git status --porcelain')) {
  const msg = process.argv[2] || `deploy: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  run(`git commit -m "${msg.replace(/"/g, '\\"')}"`);
} else {
  console.log('Aucun changement à committer.');
}
run(`git push -u origin HEAD:${BRANCH}`);

// --- 2. public/ -> gh-pages --------------------------------------------------
console.log('Publication de public/ sur la branche gh-pages…');
await ghpages.publish('public', {
  repo: REPO,
  branch: 'gh-pages',
  dotfiles: true,
  nojekyll: true,
  message: `site: ${sh('git rev-parse --short HEAD')}`,
});

const [, owner, name] = REPO.match(/github\.com\/([^/]+)\/([^/.]+)/) || [];
console.log(`\nDéployé ✔  Code : ${REPO}`);
if (owner) console.log(`Site : https://${owner.toLowerCase()}.github.io/${name}/  (activer Pages sur la branche gh-pages au premier déploiement)`);

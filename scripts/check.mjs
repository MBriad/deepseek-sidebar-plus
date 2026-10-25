import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (!manifest.version) throw new Error('manifest.json is missing version');
if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (packageJson.version !== manifest.version) {
  throw new Error(`package.json version ${packageJson.version} does not match manifest ${manifest.version}`);
}

const required = [
  'manifest.json',
  'background.js',
  'rules.json',
  'src/sidebar.html',
  'src/sidebar.js',
  'src/pdf-reader.html',
  'src/pdf-reader.js',
  'src/pdfjs-viewer.html',
  'src/pdfjs-viewer.js',
  'src/vendor/pdfjs/build/pdf.mjs',
  'src/vendor/pdfjs/build/pdf.worker.mjs',
  'tests/fixtures/text.pdf'
];
for (const file of required) {
  if (!existsSync(join(root, file))) throw new Error(`missing ${file}`);
}

const jsFiles = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'vendor') continue;
      walk(full);
      continue;
    }
    if (entry.endsWith('.js') || entry.endsWith('.mjs')) jsFiles.push(full);
  }
}
walk(root);

for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`syntax error in ${file}:\n${error.stderr?.toString() || error.message}`);
  }
}

console.log(`Checked ${jsFiles.length} JS files, manifest ${manifest.version}`);

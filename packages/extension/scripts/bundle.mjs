// Bump the patch version in every package.json, build, and copy the result
// into the desktop app's bundled defaults (src/defaults/workspace/extension),
// which the app syncs to ~/.wolffish/workspace/extension on every launch.
import { execSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const target = resolve(root, '..', '..', 'src', 'defaults', 'workspace', 'extension');

const packageFiles = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return packageFiles(full);
    return entry.name === 'package.json' ? [full] : [];
  });

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

const [major, minor, patch] = readJson(join(root, 'package.json')).version.split('.').map(Number);
const version = `${major}.${minor}.${patch + 1}`;

for (const file of packageFiles(root)) {
  const pkg = readJson(file);
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`Version → ${version}`);

execSync('pnpm build', { cwd: root, stdio: 'inherit' });

const built = readJson(join(dist, 'manifest.json')).version;
if (built !== version) throw new Error(`dist/manifest.json is ${built}, expected ${version}`);

const devOnly = new Set(['refresh.js', '.DS_Store']);
rmSync(target, { recursive: true, force: true });
cpSync(dist, target, {
  recursive: true,
  filter: src => !src.endsWith('.map') && !devOnly.has(basename(src)),
});

console.log(`Bundled extension v${version} → ${relative(process.cwd(), target)}`);

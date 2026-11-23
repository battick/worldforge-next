import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const rows = [];
const notices = ['# Direct dependency notices', '', 'Generated from the installed packages. Transitive dependency versions and license identifiers are also recorded in package-lock.json.', ''];
for (const [group, dependencies] of Object.entries({ runtime: manifest.dependencies, development: manifest.devDependencies })) {
  for (const name of Object.keys(dependencies)) {
    const directory = path.join(root, 'node_modules', name);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    rows.push({ name, version: pkg.version, license: pkg.license, group });
    const license = fs.readdirSync(directory).find(file => /^licen[sc]e(?:\.md|\.txt)?$/i.test(file));
    notices.push(`## ${name} ${pkg.version}`, '', `License: ${pkg.license}`, '', license ? fs.readFileSync(path.join(directory, license), 'utf8') : 'No license text included in package root; see upstream package repository.', '');
  }
}
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/dependencies.json'), JSON.stringify(rows, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'docs/THIRD_PARTY_NOTICES.md'), notices.join('\n'));
console.log(`Recorded ${rows.length} direct dependency versions and notices.`);

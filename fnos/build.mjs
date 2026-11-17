import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = process.argv[2] ?? '1.0.0';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a version such as 1.0.0');
const fnpack = process.env.FNPACK || 'fnpack';
const stage = await mkdtemp(join(tmpdir(), 'iptv-fpk-'));
const output = resolve(root, 'dist');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed with exit code ${result.status}`);
}

run(fnpack, ['create', 'iptv-manager'], stage);
const pkg = join(stage, 'iptv-manager');
const app = join(pkg, 'app');
const copy = (source, target) => copyFile(join(root, 'fnos', source), join(pkg, target));
const manifest = await readFile(join(root, 'fnos', 'manifest'), 'utf8');
await writeFile(join(pkg, 'manifest'), manifest.replace(/^version=.*$/m, 'version=' + version));
await Promise.all([
  copy('main', 'cmd/main'),
  copy('privilege.json', 'config/privilege'),
  copy('resource.json', 'config/resource'),
  copy('ui-config.json', 'app/ui/config'),
  copy('icon-64.png', 'ICON.PNG'),
  copy('icon-256.png', 'ICON_256.PNG'),
  copy('icon-64.png', 'app/ui/images/icon_64.png'),
  copy('icon-256.png', 'app/ui/images/icon_256.png')
]);
for (const script of await readdir(join(pkg, 'cmd'))) await chmod(join(pkg, 'cmd', script), 0o755);
for (const file of ['server.js', 'epg.js', 'package.json', 'package-lock.json', 'public', 'node_modules']) {
  await cp(join(root, file), join(app, file), { recursive: true });
}

run(fnpack, ['build'], pkg);
const packages = (await readdir(pkg)).filter(name => name.endsWith('.fpk'));
if (packages.length !== 1) throw new Error('Expected one FPK from fnpack');
await mkdir(output, { recursive: true });
const target = join(output, `IPTV-${version}-fnOS.fpk`);
await copyFile(join(pkg, packages[0]), target);
console.log(target);

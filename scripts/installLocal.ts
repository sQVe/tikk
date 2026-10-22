import { mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const checkout = join(import.meta.dir, '..');
const configured = Bun.env['TIKK_INSTALL_DIR'];
const hasConfigured = configured !== undefined && configured !== '';
const installDirectory = hasConfigured ? configured : join(homedir(), '.local', 'bin');
const target = join(installDirectory, 'tikk');
const temporary = join(installDirectory, `.tikk-${process.pid}.tmp`);

await mkdir(installDirectory, { recursive: true });

const build = Bun.spawnSync(['bun', 'build', '--compile', 'src/index.ts', '--outfile', temporary], {
  cwd: checkout,
  stdout: 'pipe',
  stderr: 'pipe',
});

if (build.exitCode !== 0) {
  await rm(temporary, { force: true });
  process.stderr.write(build.stderr.toString());
  process.exit(build.exitCode);
}

await rename(temporary, target);
process.stdout.write(`Installed ${target}\n`);

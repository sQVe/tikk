import { expect, it } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

// Loads the settings reader and the project resolver in a fresh process, and lists every module
// the process loaded.
const loadedModulesOf = async (): Promise<string[]> => {
  const script = [
    `await import(${JSON.stringify(join(root, 'src/config.ts'))});`,
    `await import(${JSON.stringify(join(root, 'src/project.ts'))});`,
    'console.log(Object.keys(require.cache).join("\\n"));',
  ].join('\n');

  const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]);

  expect(exitCode).toBe(0);

  return stdout.split('\n').filter((line) => line !== '');
};

it('loads the settings reader and project resolver without the terminal UI packages', async () => {
  const modules = await loadedModulesOf();

  expect(modules).toContain(join(root, 'src/config.ts'));

  const uiModules = modules.filter((path) =>
    /[\\/]node_modules[\\/](react|@opentui)[\\/]/.test(path),
  );

  expect(uiModules).toEqual([]);
});

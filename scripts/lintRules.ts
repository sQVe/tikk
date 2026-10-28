import { existsSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ESTree, Plugin } from '@oxlint/plugins';

interface ModuleLocation {
  module: string;
  entry: boolean;
  directory: boolean;
}

interface PackagePolicy {
  builtins: boolean;
  packages: string[];
}

type ImportSource =
  | ESTree.ImportDeclaration
  | ESTree.ExportNamedDeclaration
  | ESTree.ExportAllDeclaration;

const folderModules = new Set(['ticket', 'fact', 'store', 'cache', 'sync', 'cli', 'tui']);

const flatModules = new Set([
  'invariant',
  'result',
  'project',
  'github',
  'index',
  'terminal',
  'storeEffects',
  'sessionEffects',
  'syncEffects',
  'config',
  'remap',
]);

const allowedImports = new Map<string, Set<string>>([
  ['invariant', new Set()],
  ['result', new Set()],
  ['ticket', new Set(['invariant', 'result'])],
  ['fact', new Set(['ticket', 'invariant', 'result'])],
  ['store', new Set(['ticket', 'fact', 'invariant', 'result'])],
  ['cache', new Set(['ticket', 'fact', 'invariant', 'result'])],
  ['sync', new Set(['fact', 'ticket', 'invariant', 'result'])],
  ['project', new Set(['config', 'ticket', 'invariant', 'result'])],
  ['github', new Set(['result'])],
  ['cli', new Set(['ticket', 'fact', 'github', 'invariant', 'result'])],
  ['config', new Set(['result'])],
  ['remap', new Set(['config', 'tui', 'invariant', 'result'])],
  ['tui', new Set(['cli', 'invariant', 'result'])],
  ['terminal', new Set(['cli', 'tui'])],
  ['storeEffects', new Set(['store'])],
  ['sessionEffects', new Set(['cache', 'cli', 'result', 'store', 'storeEffects', 'ticket'])],
  ['syncEffects', new Set(['cli', 'fact', 'project', 'store', 'storeEffects', 'sync'])],
  ['index', new Set([...folderModules, ...flatModules])],
]);

const noPackages: PackagePolicy = { builtins: false, packages: [] };

const packagePolicies = new Map<string, PackagePolicy>([
  ['ticket', { builtins: false, packages: ['zod'] }],
  ['fact', { builtins: false, packages: ['zod'] }],
  ['store', { builtins: true, packages: ['nanoid'] }],
  ['cache', { builtins: true, packages: ['zod'] }],
  ['sync', { builtins: true, packages: ['zod'] }],
  ['github', { builtins: false, packages: ['zod'] }],
  ['cli', { builtins: false, packages: ['node:util'] }],
  ['config', { builtins: true, packages: ['zod'] }],
  ['remap', { builtins: false, packages: ['@opentui/keymap'] }],
  [
    'tui',
    {
      builtins: false,
      packages: ['react', '@opentui/core', '@opentui/keymap', '@opentui/react'],
    },
  ],
  [
    'terminal',
    {
      builtins: false,
      packages: ['react', '@opentui/core', '@opentui/keymap', '@opentui/react'],
    },
  ],
  ['storeEffects', { builtins: true, packages: [] }],
  ['sessionEffects', { builtins: true, packages: [] }],
  ['syncEffects', { builtins: true, packages: [] }],
  ['index', { builtins: true, packages: ['zod'] }],
]);

// Files outside src/ that a module may import, relative to the package root.
const outsideImports = new Map([
  ['cli', new Set(['package.json'])],
  ['index', new Set(['package.json'])],
]);

const packageRoots = new Map<string, string | undefined>();

// The nearest package.json marks the root, so a `src` segment above it never counts.
const packageRootOf = (directory: string): string | undefined => {
  if (packageRoots.has(directory)) {
    return packageRoots.get(directory);
  }

  const parent = dirname(directory);
  let root: string | undefined = directory;

  if (!existsSync(join(directory, 'package.json'))) {
    root = parent === directory ? undefined : packageRootOf(parent);
  }

  packageRoots.set(directory, root);

  return root;
};

const escapesDirectory = (path: string): boolean =>
  path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);

const sourceDirectoryOf = (filename: string): string | undefined => {
  const root = packageRootOf(dirname(filename));

  return root === undefined ? undefined : join(root, 'src');
};

// Returns the path relative to `src/`, or `undefined` for a file outside it.
const sourcePathOf = (filename: string): string | undefined => {
  const sourceDirectory = sourceDirectoryOf(filename);

  if (sourceDirectory === undefined) {
    return undefined;
  }

  const path = relative(sourceDirectory, filename);

  return escapesDirectory(path) ? undefined : path;
};

const isTestFile = (filename: string): boolean => /\.test\.tsx?$/.test(filename);

const locate = (path: string): ModuleLocation | undefined => {
  const segments = path.replace(/\.[jt]sx?$/, '').split(sep);
  const [first = '', second] = segments;
  const flatModule = first.replace(/\.test$/, '');

  if (segments.length === 1 && flatModules.has(flatModule)) {
    return { module: flatModule, entry: first === flatModule, directory: false };
  }

  if (!folderModules.has(first)) {
    return undefined;
  }

  const entry = segments.length === 2 && second === first;

  return { module: first, entry, directory: segments.length === 1 };
};

const filePathOf = (url: string): string | undefined => {
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
};

// Returns `undefined` for a package name and `null` for a file URL that names no local path.
const localPathOf = (specifier: string, directory: string): string | null | undefined => {
  if (/^file:/i.test(specifier)) {
    return filePathOf(specifier) ?? null;
  }

  if (!specifier.startsWith('.') && !isAbsolute(specifier)) {
    return undefined;
  }

  return resolve(directory, specifier);
};

const isRuntimeBuiltin = (specifier: string): boolean => {
  const bunBuiltin = specifier === 'bun' || specifier.startsWith('bun:');

  return bunBuiltin || specifier.startsWith('node:') || isBuiltin(specifier);
};

const packageNameOf = (specifier: string): string => {
  const segments = specifier.split('/');
  const name = specifier.startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1);

  return name.join('/');
};

const packageBoundary = (
  importer: string,
  specifier: string,
  testFile: boolean,
): string | undefined => {
  const builtin = isRuntimeBuiltin(specifier);
  const testExempt = specifier === 'bun:test' || builtin;

  if (testFile && testExempt) {
    return undefined;
  }

  const policy = packagePolicies.get(importer) ?? noPackages;
  const name = builtin ? specifier : packageNameOf(specifier);

  if (policy.packages.includes(name)) {
    return undefined;
  }

  if (builtin) {
    return policy.builtins ? undefined : 'builtin';
  }

  return 'package';
};

const moduleBoundary = (importer: string, target: ModuleLocation): string | undefined => {
  if (target.directory) {
    return 'directory';
  }

  if (target.module === importer) {
    return undefined;
  }

  if (!target.entry) {
    return 'private';
  }

  return allowedImports.get(importer)?.has(target.module) === true ? undefined : 'module';
};

const literalSourceOf = (source: ESTree.Expression): string | undefined => {
  if (source.type === 'Literal' && typeof source.value === 'string') {
    return source.value;
  }

  if (source.type !== 'TemplateLiteral' || source.expressions.length > 0) {
    return undefined;
  }

  return source.quasis[0]?.value.cooked ?? undefined;
};

const lintRules: Plugin = {
  meta: { name: 'tikk' },
  rules: {
    'module-boundaries': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          unknownFile: 'File "{{file}}" is not in a known module. Move it into one.',
          unknownTarget:
            'Module "{{importer}}" imports "{{target}}", which is not in a known module.',
          escape: 'Module "{{importer}}" imports "{{target}}", which is outside src/.',
          directory:
            'Module "{{importer}}" imports the directory "{{target}}". Import its entry file.',
          private:
            'Module "{{importer}}" imports "{{target}}", a private file of another module. Import its entry file.',
          module:
            'Module "{{importer}}" may not import "{{target}}": the module table refuses that edge.',
          builtin: 'Module "{{importer}}" must not import the built-in "{{target}}".',
          package: 'Module "{{importer}}" must not import the package "{{target}}".',
          dynamic:
            'Module "{{importer}}" has a computed dynamic import or `require()`. Use a string literal so its boundary can be checked.',
        },
      },
      create(context) {
        const filename = context.physicalFilename;
        const sourceDirectory = sourceDirectoryOf(filename);

        if (sourceDirectory === undefined) {
          return {};
        }

        const path = relative(sourceDirectory, filename);

        if (escapesDirectory(path)) {
          return {};
        }

        const location = locate(path);
        const importer = location?.directory === false ? location.module : undefined;

        if (importer === undefined) {
          return {
            Program(node) {
              context.report({ node, messageId: 'unknownFile', data: { file: path } });
            },
          };
        }

        const testFile = isTestFile(filename);

        const boundaryOf = (specifier: string): string | undefined => {
          const localPath = localPathOf(specifier, dirname(filename));

          if (localPath === undefined) {
            return packageBoundary(importer, specifier, testFile);
          }

          if (localPath === null) {
            return 'unknownTarget';
          }

          const targetPath = relative(sourceDirectory, localPath);

          if (escapesDirectory(targetPath)) {
            const packagePath = relative(dirname(sourceDirectory), localPath);

            return outsideImports.get(importer)?.has(packagePath) === true ? undefined : 'escape';
          }

          const target = locate(targetPath);

          return target === undefined ? 'unknownTarget' : moduleBoundary(importer, target);
        };

        const check = (source: ESTree.StringLiteral) => {
          const messageId = boundaryOf(source.value);

          if (messageId !== undefined) {
            context.report({ node: source, messageId, data: { importer, target: source.value } });
          }
        };

        const checkSource = (node: ImportSource) => {
          if (node.source !== null) {
            check(node.source);
          }
        };

        const checkLoaded = (node: ESTree.Node, source: ESTree.Argument) => {
          const specifier = source.type === 'SpreadElement' ? undefined : literalSourceOf(source);

          if (specifier === undefined) {
            context.report({ node, messageId: 'dynamic', data: { importer } });

            return;
          }

          const messageId = boundaryOf(specifier);

          if (messageId !== undefined) {
            context.report({ node, messageId, data: { importer, target: specifier } });
          }
        };

        return {
          ImportDeclaration: checkSource,
          ExportNamedDeclaration: checkSource,
          ExportAllDeclaration: checkSource,
          TSImportType(node) {
            check(node.source);
          },
          TSImportEqualsDeclaration(node) {
            if (node.moduleReference.type === 'TSExternalModuleReference') {
              check(node.moduleReference.expression);
            }
          },
          ImportExpression(node) {
            checkLoaded(node, node.source);
          },
          CallExpression(node) {
            const [source] = node.arguments;
            const requireCall = node.callee.type === 'Identifier' && node.callee.name === 'require';

            if (requireCall && source !== undefined) {
              checkLoaded(node, source);
            }
          },
        };
      },
    },
    'throw-only-in-invariant': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          throw:
            'Throw only in `src/invariant.ts`. Return a typed result for an expected failure, or call `invariant` for a bug.',
        },
      },
      create(context) {
        const filename = context.physicalFilename;
        const path = sourcePathOf(filename);
        const exempt = path === undefined || path === 'invariant.ts' || isTestFile(filename);

        if (exempt) {
          return {};
        }

        return {
          ThrowStatement(node) {
            context.report({ node, messageId: 'throw' });
          },
        };
      },
    },
  },
};

export default lintRules;

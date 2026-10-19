import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';

import type { StoreInitEffects } from './storeInit.ts';
import type { TicketFileFunctions } from './ticketFiles.ts';

export const nodeTicketFiles: TicketFileFunctions = {
  readdir: (directory) => readdir(directory),
  stat: (path) => stat(path),
  readFile: (path) => readFile(path),
  mkdir: async (directory) => {
    await mkdir(directory, { recursive: true });
  },
  writeFileExclusive: async (path, text) => {
    const handle = await open(path, 'wx');

    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  },
  writeFile: (path, text) => writeFile(path, text),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
};

export const nodeStoreFiles: Pick<StoreInitEffects, 'readFile' | 'mkdir' | 'writeFile'> = {
  readFile: (path) => readFile(path, 'utf8'),
  mkdir: nodeTicketFiles.mkdir,
  writeFile: nodeTicketFiles.writeFile,
};

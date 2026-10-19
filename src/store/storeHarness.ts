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
    const write = handle.writeFile(text);

    const succeeded = await write.then(
      () => true,
      () => false,
    );

    await handle.close();

    // This call created the file, so a failed write removes it, then rejects with the write error.
    if (!succeeded) {
      await unlink(path).catch(() => undefined);
    }

    await write;
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

import { existsSync } from 'node:fs';
import {
  appendFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { newIdSuffix } from './store/store.ts';
import type {
  FactFileFunctions,
  LogFileFunctions,
  StoreInitEffects,
  StoreLockFunctions,
  TicketFileFunctions,
} from './store/store.ts';

export const ticketFiles: TicketFileFunctions = {
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
  randomIdSuffix: () => newIdSuffix(),
};

export const logFiles: LogFileFunctions = {
  mkdir: ticketFiles.mkdir,
  writeFile: ticketFiles.writeFile,
  rename: ticketFiles.rename,
  unlink: ticketFiles.unlink,
  randomIdSuffix: ticketFiles.randomIdSuffix,
};

export const factFiles: FactFileFunctions = {
  readdir: ticketFiles.readdir,
  stat: ticketFiles.stat,
  mkdir: ticketFiles.mkdir,
  readFileFrom: (path, fromByte) => Bun.file(path).slice(fromByte).bytes(),
  appendFile: (path, text) => appendFile(path, text),
};

export const storeLock: StoreLockFunctions = {
  pid: process.pid,
  writeFile: (path, text) => writeFile(path, text),
  link: (existingPath, newPath) => link(existingPath, newPath),
  randomSuffix: () => crypto.randomUUID(),
  readFile: (path) => readFile(path, 'utf8'),
  unlink: ticketFiles.unlink,
  readdir: ticketFiles.readdir,
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch (error) {
      return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    }
  },
  sleep: (milliseconds) => Bun.sleep(milliseconds),
  now: () => Date.now(),
};

export const storeFiles: Pick<StoreInitEffects, 'readFile' | 'mkdir' | 'writeFile'> = {
  readFile: (path) => readFile(path, 'utf8'),
  mkdir: ticketFiles.mkdir,
  writeFile: ticketFiles.writeFile,
};

export const openFailureCode = (storeRoot: string): 'storeError' | 'notInitialized' => {
  const configured = existsSync(join(storeRoot, 'tikk.json'));

  return configured ? 'storeError' : 'notInitialized';
};

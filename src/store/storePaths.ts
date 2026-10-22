import { join, resolve } from 'node:path';

import type { ProjectName, TicketId } from '../ticket/ticket.ts';

export interface StoreRootInputs {
  tikkHome: string | undefined;
  homeDirectory: string;
}

export interface Store {
  root: string;
}

export const resolveStoreRoot = ({ tikkHome, homeDirectory }: StoreRootInputs): string => {
  if (tikkHome !== undefined && tikkHome !== '') {
    return resolve(tikkHome);
  }

  return join(resolve(homeDirectory), '.local', 'share', 'tikk');
};

export const ticketsDirectory = (store: Store): string => join(store.root, 'tickets');

export const projectDirectory = (store: Store, project: ProjectName): string =>
  join(ticketsDirectory(store), project);

export const ticketFilePath = (
  store: Store,
  project: ProjectName,
  id: TicketId,
  slug: string,
): string => join(projectDirectory(store, project), `${id}-${slug}.md`);

export const lockFilePath = (store: Store): string => join(store.root, '.git', 'tikk.lock');

export const breakerFilePath = (store: Store): string =>
  join(store.root, '.git', 'tikk.lock.break');

export const factsDirectory = (store: Store): string => join(store.root, 'facts');

export const factFilePath = (store: Store, machine: string, month: string): string =>
  join(factsDirectory(store), machine, `${month}.jsonl`);

export const logsDirectory = (store: Store): string => join(store.root, 'logs');

export const logFilePath = (store: Store, hash: string): string =>
  join(logsDirectory(store), `${hash}.log`);

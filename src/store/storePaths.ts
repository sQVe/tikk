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

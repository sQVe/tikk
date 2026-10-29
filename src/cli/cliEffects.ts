import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { ProjectName, TicketFrontMatter, TicketId } from '../ticket/ticket.ts';

export interface CliTicket {
  id: TicketId;
  path: string;
  hash: string;
  error: string | null;
  frontMatter: TicketFrontMatter;
  body: string;
}

export interface CliTicketOutline {
  id: TicketId;
  frontMatter: Pick<TicketFrontMatter, 'kind' | 'title' | 'status' | 'parent' | 'archived'>;
}

export interface CliFailure {
  code:
    | 'notInitialized'
    | 'notFound'
    | 'changedOnDisk'
    | 'parseError'
    | 'invalidArguments'
    | 'storeError'
    | 'conflict'
    | 'locked'
    | 'ghError'
    | 'idShared';
  message: string;
}

interface CliMessage {
  message: string;
}

export interface EditorCleanupFailure {
  kind: 'cleanup';
  message: string;
}

type EditorFailure = EditorCleanupFailure | { kind: 'cancelled' | 'failed'; message: string };

interface CreatedFile {
  id: TicketId;
  path: string;
  hash: string;
}

export interface FactAppendReason {
  kind: 'invalid' | 'failed' | 'shared';
  message: string;
}

interface FileWriteReason {
  kind: 'notFound' | 'changedOnDisk' | 'failed';
  message: string;
}

interface CliLookupReason {
  kind: 'notFound' | 'failed';
  message: string;
}

export interface CliSession extends Disposable {
  refresh: () => Promise<Result<undefined, CliMessage>>;
  getTicket: (id: TicketId) => Result<CliTicket, CliLookupReason>;
  findTicketPath: (id: TicketId) => Result<string, CliLookupReason>;
  listTickets: (options: { includeArchived: boolean }) => Result<CliTicket[], CliMessage>;
  // Tickets whose files parse, with only the fields that place them in their tree.
  listTicketOutlines: () => Result<CliTicketOutline[], CliMessage>;
  // False only when the archive sweep surely has nothing to do.
  mayHaveArchiveWork: (now: Date) => Result<boolean, CliMessage>;
  listErrors: () => Result<{ path: string; message: string }[], CliMessage>;
  listTicketFolderFiles: (
    project: ProjectName,
    id: TicketId,
  ) => Promise<Result<string[], CliMessage>>;
  designFilePath: (project: ProjectName, id: TicketId) => string;
  listFacts: (ticketIds?: TicketId[]) => Promise<Result<Fact[], CliMessage>>;
  listStateFacts: (ticketIds?: TicketId[]) => Promise<Result<Fact[], CliMessage>>;
  listArchiveFacts: () => Promise<Result<Fact[], CliMessage>>;
  lockStore: () => Promise<Result<StoreLock, StoreLockReason>>;
  // One attempt that never waits for another holder.
  tryLockStore: () => Promise<Result<StoreLock, StoreLockReason>>;
  checkIdUnshared: (id: TicketId) => Result<undefined, FactAppendReason>;
  appendFact: (machine: string, fact: Fact) => Promise<Result<{ path: string }, FactAppendReason>>;
  storeLog: (text: string) => Promise<Result<{ hash: string }, CliMessage>>;
  createTicketFile: (
    project: ProjectName,
    title: string,
    text: string,
  ) => Promise<Result<CreatedFile, FileWriteReason>>;
  writeTicketFile: (
    path: string,
    expectedHash: string,
    text: string,
  ) => Promise<Result<{ hash: string }, FileWriteReason>>;
}

interface StoreLockReason {
  kind: 'locked' | 'failed';
  message: string;
}

interface StoreLock {
  release: () => Promise<void>;
}

interface SessionReason {
  code: 'notInitialized' | 'storeError';
  message: string;
}

export interface SyncSummary {
  committed: boolean;
  pending: string[];
  aliases: { from: string; to: string; path: string }[];
  remote: boolean;
  fetched: boolean;
  merged: boolean;
  pushed: boolean;
}

interface RemoteStoreSummary {
  store: string;
  created: boolean;
  remote: string;
  pushed: boolean;
}

interface SyncFailure {
  code: 'notInitialized' | 'storeError' | 'conflict' | 'locked';
  message: string;
}

export interface CliEffects {
  initStore: () => Promise<Result<{ store: string; created: boolean }, CliMessage>>;
  initRemoteStore: (url: string) => Promise<Result<RemoteStoreSummary, SyncFailure>>;
  syncStore: () => Promise<Result<SyncSummary, SyncFailure>>;
  runBackgroundSync: () => Promise<void>;
  scheduleSync: () => Promise<void>;
  fetchRemote: () => Promise<void>;
  mergeFetched: () => Promise<void>;
  openSession: () => Promise<Result<CliSession, SessionReason>>;
  resolveProject: () => Promise<Result<ProjectName, CliMessage>>;
  readTextFile: (path: string) => Promise<string | undefined>;
  runEditor: (path: string, signal: AbortSignal) => Promise<Result<undefined, EditorFailure>>;
  resolveMachine: () => Promise<Result<string, CliMessage>>;
  runGh: (args: string[], signal: AbortSignal) => Promise<Result<string, CliMessage>>;
  now: () => Date;
  newItemId: () => string;
}

export interface CommandInput {
  args: string[];
  json: boolean;
  effects: CliEffects;
  session: CliSession;
}

interface CommandOutput {
  json: unknown;
  text: string;
}

export type CommandResult = Result<CommandOutput, CliFailure>;

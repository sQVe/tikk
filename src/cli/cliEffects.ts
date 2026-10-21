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

export interface CliFailure {
  code:
    | 'notInitialized'
    | 'notFound'
    | 'changedOnDisk'
    | 'parseError'
    | 'invalidArguments'
    | 'storeError'
    | 'conflict'
    | 'locked';
  message: string;
}

interface CliMessage {
  message: string;
}

interface CreatedFile {
  id: TicketId;
  path: string;
  hash: string;
}

interface FactAppendReason {
  kind: 'invalid' | 'failed';
  message: string;
}

interface FileWriteReason {
  kind: 'notFound' | 'changedOnDisk' | 'failed';
  message: string;
}

export interface CliSession extends Disposable {
  refresh: () => Promise<Result<undefined, CliMessage>>;
  getTicket: (id: TicketId) => Result<CliTicket, CliMessage>;
  findTicketPath: (id: TicketId) => Result<string, CliMessage>;
  listTickets: (options: { includeArchived: boolean }) => CliTicket[];
  listErrors: () => { path: string; message: string }[];
  listFacts: (ticketIds?: TicketId[]) => Promise<Result<Fact[], CliMessage>>;
  listStateFacts: (ticketIds?: TicketId[]) => Promise<Result<Fact[], CliMessage>>;
  lockStore: () => Promise<Result<StoreLock, StoreLockReason>>;
  appendFact: (machine: string, fact: Fact) => Promise<Result<{ path: string }, FactAppendReason>>;
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

export interface CliEffects {
  initStore: () => Promise<Result<{ store: string; created: boolean }, CliMessage>>;
  openSession: () => Promise<Result<CliSession, SessionReason>>;
  resolveProject: () => Promise<Result<ProjectName, CliMessage>>;
  readTextFile: (path: string) => Promise<string | undefined>;
  runEditor: (path: string) => Promise<Result<undefined, CliMessage>>;
  resolveMachine: () => Promise<Result<string, CliMessage>>;
  now: () => Date;
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

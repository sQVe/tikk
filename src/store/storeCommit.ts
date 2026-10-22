import type { Result } from '../result.ts';

export type StoreGit = (args: string[]) => Promise<Result<string, { message: string }>>;

const fallbackIdentity = ['-c', 'user.name=tikk', '-c', 'user.email=tikk@localhost'];

// A signing setup may wait for a passphrase, and tikk never prompts.
const unsigned = ['-c', 'commit.gpgsign=false'];

// Returns the arguments that go before the Git command of a commit or merge. A machine with no Git
// identity still commits, as tikk.
export const commitArguments = async (runGit: StoreGit, root: string): Promise<string[]> => {
  const email = await runGit(['-C', root, 'config', 'user.email']);
  const configured = email.ok && email.value.trim() !== '';

  return configured ? unsigned : [...unsigned, ...fallbackIdentity];
};

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakePullRequest {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  base: string;
  head: string;
  mergeCommit: string | null;
}

export interface FakeGh {
  directory: string;
  setPullRequest: (pullRequest: FakePullRequest) => Promise<void>;
  cleanup: () => Promise<void>;
}

// Answers the `gh pr view`, `gh repo view`, and `gh api .../compare/...` calls from a JSON file,
// so a test can change the pull request between two commands.
const script = `#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pullRequest = JSON.parse(readFileSync(join(import.meta.dir, 'pull-request.json'), 'utf8'));
const [command] = process.argv.slice(2);

if (command === 'repo') {
  console.log(JSON.stringify({ defaultBranchRef: { name: 'main' } }));
} else if (command === 'api') {
  console.log('ahead');
} else {
  console.log(
    JSON.stringify({
      number: 7,
      state: pullRequest.state,
      baseRefName: pullRequest.base,
      headRefOid: pullRequest.head,
      mergeCommit: pullRequest.mergeCommit === null ? null : { oid: pullRequest.mergeCommit },
    }),
  );
}
`;

export const createFakeGh = async (initial: FakePullRequest): Promise<FakeGh> => {
  const directory = await mkdtemp(join(tmpdir(), 'tikk-gh-'));
  const scriptPath = join(directory, 'gh');

  const setPullRequest = async (pullRequest: FakePullRequest): Promise<void> => {
    await writeFile(join(directory, 'pull-request.json'), JSON.stringify(pullRequest));
  };

  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  await setPullRequest(initial);

  const cleanup = async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  };

  return { directory, setPullRequest, cleanup };
};

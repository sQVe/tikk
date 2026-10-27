import type { ConfigSettings } from './config.ts';
import type { Result } from './result.ts';
import { parseProjectName } from './ticket/ticket.ts';
import type { ProjectName } from './ticket/ticket.ts';

export type GitOutcome =
  | { kind: 'output'; stdout: string }
  | { kind: 'failed' }
  | { kind: 'unavailable'; message: string };

export interface ProjectEffects {
  runGit: (args: string[]) => Promise<GitOutcome>;
  // Reads the settings of the config file. A failure names the file.
  readSettings: () => Result<ConfigSettings, string>;
  hostName: string;
}

export interface ProjectReason {
  message: string;
}

const machinePattern = /^[a-z0-9][a-z0-9._-]*$/;

const personalProject = 'personal';

const repositoryPatterns = [
  /^[^@/\s]+@[^:/\s]+:(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?\/?$/,
  /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?\/?$/,
];

const parseRepository = (url: string): { owner: string; name: string } | undefined => {
  for (const pattern of repositoryPatterns) {
    const groups = pattern.exec(url.trim())?.groups;

    if (groups?.['owner'] !== undefined && groups['name'] !== undefined) {
      return { owner: groups['owner'], name: groups['name'] };
    }
  }

  return undefined;
};

const settingsOf = (effects: ProjectEffects): Result<ConfigSettings, ProjectReason> => {
  const settings = effects.readSettings();

  if (settings.ok) {
    return settings;
  }

  return { ok: false, reason: { message: settings.reason } };
};

const readMappings = (effects: ProjectEffects): Result<Map<string, string>, ProjectReason> => {
  const settings = settingsOf(effects);
  const mappings = new Map<string, string>();

  if (!settings.ok) {
    return settings;
  }

  for (const [key, value] of Object.entries(settings.value.projects)) {
    mappings.set(key.toLowerCase(), value);
  }

  return { ok: true, value: mappings };
};

export const resolveMachine = (effects: ProjectEffects): Result<string, ProjectReason> => {
  const settings = settingsOf(effects);

  if (!settings.ok) {
    return settings;
  }

  const configured = settings.value.machine;
  const machine = (configured ?? effects.hostName).toLowerCase();

  if (machinePattern.test(machine)) {
    return { ok: true, value: machine };
  }

  const source = configured === undefined ? 'The host name' : 'The "machine" config';

  return {
    ok: false,
    reason: {
      message: `${source} "${machine}" is not a valid machine name. Set "machine" in ~/.config/tikk/config.json to a name that matches ${machinePattern.source}.`,
    },
  };
};

const personalResult = (): Result<ProjectName, ProjectReason> => parseProjectName(personalProject);

export const resolveProject = async (
  cwd: string,
  effects: ProjectEffects,
): Promise<Result<ProjectName, ProjectReason>> => {
  const remote = await effects.runGit(['-C', cwd, 'remote', 'get-url', 'origin']);

  if (remote.kind === 'unavailable') {
    return { ok: false, reason: { message: `Cannot run git: ${remote.message}` } };
  }

  if (remote.kind === 'failed') {
    return personalResult();
  }

  const repository = parseRepository(remote.stdout);

  if (repository === undefined) {
    return personalResult();
  }

  const mappings = readMappings(effects);

  if (!mappings.ok) {
    return mappings;
  }

  const mapped = mappings.value.get(`${repository.owner}/${repository.name}`.toLowerCase());
  const parsed = parseProjectName(mapped ?? repository.name.toLowerCase());

  if (parsed.ok) {
    return parsed;
  }

  return {
    ok: false,
    reason: {
      message: `Cannot use repository "${repository.owner}/${repository.name}" as a project name. Add a mapping to the "projects" config in ~/.config/tikk/config.json.`,
    },
  };
};

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A repository's own git config (.git/config) can name programs that git runs during everyday read
 * commands: core.fsmonitor during `git status`, diff and textconv drivers during `git diff`, `log` and
 * `blame`, filters while checking files for changes, gpg for signatures. Such a config can come with
 * a project, for example in an archive that includes .git. So git runs without asking (when building
 * the system prompt, or as a read-only Bash command) only in a repository whose own config has nothing
 * but these everyday settings. Anything else is asked about first.
 */
const PLAIN_KEYS = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|sparsecheckout|sparsecheckoutcone|untrackedcache|splitindex|commitgraph|multipackindex|checkstat|trustctime|quotepath|abbrev|compression|loosecompression|fscache|longpaths)$/,
  /^remote\..+\.(url|pushurl|fetch|push|tagopt|prune|prunetags|mirror|promisor|partialclonefilter|skipdefaultupdate|skipfetchall)$/,
  /^branch\..+\.(remote|pushremote|merge|rebase|description)$/,
  /^submodule\..+\.(url|active|branch|shallow)$/,
  /^user\.(name|email|signingkey|useconfigonly)$/,
  /^(pull\.(rebase|ff)|push\.(default|autosetupremote|followtags)|fetch\.(prune|prunetags)|init\.defaultbranch|merge\.(ff|conflictstyle))$/,
  /^(rebase\.(autosquash|autostash|updaterefs)|rerere\.(enabled|autoupdate)|gc\.(auto|autodetach)|index\.(version|threads|skiphash))$/,
  /^(feature\.manyfiles|maintenance\.(auto|strategy)|commit\.gpgsign|tag\.gpgsign|color\..+|column\..+|alias\..+)$/,
  /^status\.(short|branch|showuntrackedfiles|relativepaths|aheadbehind)$/,
  /^extensions\.(objectformat|worktreeconfig|partialclone|refstorage|preciousobjects)$/,
];

/** Environment for git commands run without asking: no optional index writes, which would run hooks. */
export const QUIET_GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' };

/** The .git directory (or .git file, for worktrees and submodules) that dir is in, if any. */
export function findGitDir(dir: string): string | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const candidate = path.join(d, '.git');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(d) === d) return undefined;
  }
}

/**
 * The settings in the repository's own config (local and worktree, includes followed) that are not
 * known to be harmless, plus "submodules" when it has any: each submodule has a config of its own,
 * which git status and friends use too. Empty means git can run here without asking; undefined means
 * git could not read the config (git missing, a broken repository), which is treated like a risky one.
 */
export function riskyGitConfig(cwd: string): string[] | undefined {
  let out: string;
  try {
    out = execFileSync('git', ['config', '--list', '--show-scope', '-z'], {
      cwd,
      env: { ...process.env, ...QUIET_GIT_ENV },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).toString();
  } catch {
    return undefined;
  }
  const fields = out.split('\0');
  const risky = new Set<string>();
  if (hasSubmodules(cwd)) risky.add('submodules');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [scope, key] = [fields[i], fields[i + 1].split('\n')[0].toLowerCase()];
    if ((scope === 'local' || scope === 'worktree') && !PLAIN_KEYS.some(p => p.test(key))) risky.add(key);
  }
  return [...risky];
}

/** The repository's git folder: .git itself, or where a .git file (worktree, submodule) points. */
function realGitDir(gitDir: string): string {
  if (!fs.statSync(gitDir).isFile()) return gitDir;
  const target = /^gitdir: (.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'))?.[1].trim();
  if (!target) throw new Error(`${gitDir} names no git folder`);
  return path.resolve(path.dirname(gitDir), target);
}

/** Whether the repository cwd is in has submodules (a .gitmodules file, or modules in its git folder). */
function hasSubmodules(cwd: string): boolean {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return false;
  if (fs.existsSync(path.join(path.dirname(gitDir), '.gitmodules'))) return true;
  try {
    return fs.existsSync(path.join(realGitDir(gitDir), 'modules'));
  } catch {
    return true;
  }
}

/**
 * The hooks the repository has: executable files in its hooks folder (the shared one, for a
 * worktree) other than the *.sample files git creates. They run on commit, checkout, merge, push and
 * so on, so a project that comes with hooks gets no "don't ask again" rule for git, and the approval
 * prompt names them. Read commands such as status and diff run none (with GIT_OPTIONAL_LOCKS=0).
 */
export function gitHooks(cwd: string): string[] {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return [];
  try {
    let dir = realGitDir(gitDir);
    const common = path.join(dir, 'commondir');
    if (fs.existsSync(common)) dir = path.resolve(dir, fs.readFileSync(common, 'utf8').trim());
    const hooks = path.join(dir, 'hooks');
    return fs.readdirSync(hooks).filter(f => {
      if (f.endsWith('.sample')) return false;
      try {
        fs.accessSync(path.join(hooks, f), fs.constants.X_OK);
        return fs.statSync(path.join(hooks, f)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** The branch HEAD points at, read from the files so no git command runs, or undefined. */
export function currentBranch(gitDir: string): string | undefined {
  try {
    const dir = realGitDir(gitDir);
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : /^[0-9a-f]{7,}$/.test(head) ? `(detached at ${head.slice(0, 7)})` : undefined;
  } catch {
    return undefined;
  }
}

import {
  buildVaultRegistry,
  resolveConfigSource,
  expandTilde,
  VaultConfigError,
  FALLBACK_VAULT_NAME,
} from '../vaultConfig.js';
import { resolveDefaultExcludeTags } from '../excludeTags.js';

const HOME = '/home/tester';
const DEFAULT_NOTES = '/opt/library/notes';
const existsAll = () => true;
const existsNone = () => false;
/** A valid station entry, as an inline YAML mapping; `build` resolves STATION_KEY. */
const STATION = '{type: station, url: "https://station.lan", api_key_env: STATION_KEY}';

/** Convenience: build from YAML with paths assumed to exist. */
function build(yaml: string | undefined, overrides: Partial<Parameters<typeof buildVaultRegistry>[0]> = {}) {
  return buildVaultRegistry({
    rawConfig: yaml,
    defaultNotesDir: DEFAULT_NOTES,
    homeDir: HOME,
    pathExists: existsAll,
    getEnv: (name) => (name === 'STATION_KEY' ? 'sekret' : undefined),
    ...overrides,
  });
}

/** Path of a registry's first vault, which these tests expect to be local. */
function localPath(reg: ReturnType<typeof buildVaultRegistry>): string {
  const v = reg.vaults[0];
  if (v.type !== 'local') throw new Error(`expected a local vault, got ${v.type}`);
  return v.path;
}

describe('expandTilde', () => {
  test('bare ~ expands to the home dir', () => {
    expect(expandTilde('~', HOME)).toBe(HOME);
  });
  test('~/… expands against the home dir', () => {
    expect(expandTilde('~/vault', HOME)).toBe('/home/tester/vault');
  });
  test('absolute path is left untouched', () => {
    expect(expandTilde('/srv/vault', HOME)).toBe('/srv/vault');
  });
  test('a mid-string ~ is not expanded', () => {
    expect(expandTilde('/a/~/b', HOME)).toBe('/a/~/b');
  });
});

describe('buildVaultRegistry — NOTES_DIR fallback (no config file)', () => {
  test('regression: NOTES_DIR set → one default vault at that path, default exclude tags', () => {
    const reg = build(undefined, { notesDirEnv: '/srv/myvault' });
    expect(reg.vaults).toEqual([
      { type: 'local', name: FALLBACK_VAULT_NAME, path: '/srv/myvault', contextFile: 'profile.md' },
    ]);
    expect(reg.defaultVault).toBe(FALLBACK_VAULT_NAME);
    expect(reg.defaultExcludeTags).toEqual(['archived', 'historical']);
  });

  test('NOTES_DIR unset → falls back to defaultNotesDir', () => {
    const reg = build(undefined, { notesDirEnv: undefined });
    expect(localPath(reg)).toBe(DEFAULT_NOTES);
  });

  test('NOTES_DIR empty string → falls back to defaultNotesDir', () => {
    const reg = build(undefined, { notesDirEnv: '' });
    expect(localPath(reg)).toBe(DEFAULT_NOTES);
  });

  test('fallback does not consult pathExists (zero-migration boot)', () => {
    // Even with a predicate that rejects everything, the fallback must succeed.
    expect(() => build(undefined, { notesDirEnv: '/srv/myvault', pathExists: existsNone })).not.toThrow();
  });
});

describe('buildVaultRegistry — happy paths', () => {
  test('single vault, no default_vault → that vault is the default', () => {
    const reg = build('vaults:\n  personal: {path: ~/vault}\n');
    expect(reg.defaultVault).toBe('personal');
    expect(reg.vaults).toEqual([
      { type: 'local', name: 'personal', path: '/home/tester/vault', contextFile: 'profile.md' },
    ]);
  });

  test('multi-vault: tilde expansion, contextFile default, sync carried, default honored', () => {
    const yaml = [
      'default_vault: personal',
      'vaults:',
      '  personal: {path: ~/vault}',
      '  dnd: {path: ~/dnd-vault, context_file: campaign.md}',
      '  work-shared: {path: ~/work/design-docs, sync: git-publication}',
    ].join('\n');
    const reg = build(yaml);
    expect(reg.defaultVault).toBe('personal');
    expect(reg.vaults).toEqual([
      { type: 'local', name: 'personal', path: '/home/tester/vault', contextFile: 'profile.md' },
      { type: 'local', name: 'dnd', path: '/home/tester/dnd-vault', contextFile: 'campaign.md' },
      { type: 'local', name: 'work-shared', path: '/home/tester/work/design-docs', sync: 'git-publication', contextFile: 'profile.md' },
    ]);
  });

  test('global exclude_tags override the default set', () => {
    const reg = build('exclude_tags: [draft, wip]\nvaults:\n  personal: {path: ~/vault}\n');
    expect(reg.defaultExcludeTags).toEqual(['draft', 'wip']);
  });

  test('exclude_tags: [] opts out of the default exclude set', () => {
    const reg = build('exclude_tags: []\nvaults:\n  personal: {path: ~/vault}\n');
    expect(reg.defaultExcludeTags).toEqual([]);
  });

  test('absolute vault path is preserved as-is', () => {
    const reg = build('vaults:\n  personal: {path: /srv/vault}\n');
    expect(localPath(reg)).toBe('/srv/vault');
  });
});

describe('buildVaultRegistry — validation (named fail-fast errors)', () => {
  const cases: Array<{ name: string; yaml: string; code: string; overrides?: object }> = [
    {
      name: 'more than one vault without default_vault → default_required',
      yaml: 'vaults:\n  a: {path: ~/a}\n  b: {path: ~/b}\n',
      code: 'default_required',
    },
    {
      name: 'default_vault names a missing vault → default_unknown',
      yaml: 'default_vault: nope\nvaults:\n  a: {path: ~/a}\n',
      code: 'default_unknown',
    },
    {
      name: 'default vault is git-publication → default_is_shared (leak guard)',
      yaml: 'default_vault: shared\nvaults:\n  shared: {path: ~/s, sync: git-publication}\n  local: {path: ~/l}\n',
      code: 'default_is_shared',
    },
    {
      name: 'uppercase vault name → bad_vault_name',
      yaml: 'vaults:\n  Personal: {path: ~/vault}\n',
      code: 'bad_vault_name',
    },
    {
      name: 'vault name with a space → bad_vault_name',
      yaml: 'vaults:\n  "my vault": {path: ~/vault}\n',
      code: 'bad_vault_name',
    },
    {
      name: 'vault name with a leading hyphen → bad_vault_name',
      yaml: 'vaults:\n  "-x": {path: ~/vault}\n',
      code: 'bad_vault_name',
    },
    {
      name: 'empty vaults mapping → no_vaults',
      yaml: 'vaults: {}\n',
      code: 'no_vaults',
    },
    {
      name: 'missing vaults key → no_vaults',
      yaml: 'default_vault: personal\n',
      code: 'no_vaults',
    },
    {
      name: 'vault missing a path → malformed',
      yaml: 'vaults:\n  personal: {sync: git-publication}\n',
      code: 'malformed',
    },
    {
      name: 'unknown sync value → malformed',
      yaml: 'vaults:\n  personal: {path: ~/v, sync: rsync}\n',
      code: 'malformed',
    },
    {
      name: 'non-list exclude_tags → malformed',
      yaml: 'exclude_tags: draft\nvaults:\n  personal: {path: ~/vault}\n',
      code: 'malformed',
    },
    {
      name: 'scalar (non-mapping) config → malformed',
      yaml: 'just a string\n',
      code: 'malformed',
    },
    {
      name: 'empty / comment-only config file → malformed (not silent fallback)',
      yaml: '# just a comment\n',
      code: 'malformed',
    },
    {
      name: 'vaults is a scalar (wrong type, not missing) → malformed',
      yaml: 'vaults: nope\n',
      code: 'malformed',
    },
    {
      name: 'vaults is a list (wrong type) → malformed',
      yaml: 'vaults:\n  - personal\n',
      code: 'malformed',
    },
    {
      name: 'unknown vault type → malformed',
      yaml: 'vaults:\n  personal: {type: s3, path: ~/v}\n',
      code: 'malformed',
    },
    {
      name: 'personal vault + station as default → default_is_shared',
      yaml: `default_vault: team\nvaults:\n  personal: {path: ~/v}\n  team: ${STATION}\n`,
      code: 'default_is_shared',
    },
    {
      name: 'station without url → malformed',
      yaml: 'vaults:\n  team: {type: station, api_key_env: STATION_KEY}\n',
      code: 'malformed',
    },
    {
      name: 'station with a non-http url → malformed',
      yaml: 'vaults:\n  team: {type: station, url: "ftp://station.lan", api_key_env: STATION_KEY}\n',
      code: 'malformed',
    },
    {
      name: 'station without api_key_env → malformed',
      yaml: 'vaults:\n  team: {type: station, url: "https://station.lan"}\n',
      code: 'malformed',
    },
    {
      name: 'station whose api_key_env is not an env var name → malformed',
      yaml: 'vaults:\n  team: {type: station, url: "https://station.lan", api_key_env: "sk-live-123 456"}\n',
      code: 'malformed',
    },
    {
      name: 'station with a path → malformed',
      yaml: 'vaults:\n  team: {type: station, url: "https://station.lan", api_key_env: STATION_KEY, path: ~/t}\n',
      code: 'malformed',
    },
    {
      name: 'station with sync → malformed',
      yaml: 'vaults:\n  team: {type: station, url: "https://station.lan", api_key_env: STATION_KEY, sync: git-publication}\n',
      code: 'malformed',
    },
    {
      name: 'station with a non-positive timeout_ms → malformed',
      yaml: 'vaults:\n  team: {type: station, url: "https://station.lan", api_key_env: STATION_KEY, timeout_ms: 0}\n',
      code: 'malformed',
    },
    {
      name: 'station whose key env var is unset → api_key_missing',
      yaml: 'vaults:\n  team: {type: station, url: "https://station.lan", api_key_env: OTHER_KEY}\n',
      code: 'api_key_missing',
    },
    {
      name: 'station whose key env var is empty → api_key_missing',
      yaml: `vaults:\n  team: ${STATION}\n`,
      code: 'api_key_missing',
      overrides: { getEnv: () => '' },
    },
  ];

  test.each(cases)('$name', ({ yaml, code, overrides }) => {
    let thrown: unknown;
    try {
      build(yaml, overrides);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultConfigError);
    expect((thrown as VaultConfigError).code).toBe(code);
  });

  test('a station entry parses, with the key read from its env var and defaults applied', () => {
    const reg = build(`default_vault: personal\nvaults:\n  personal: {path: ~/v}\n  team: ${STATION}\n`);
    expect(reg.vaults[1]).toEqual({
      type: 'station',
      name: 'team',
      url: 'https://station.lan',
      apiKeyEnv: 'STATION_KEY',
      apiKey: 'sekret',
      timeoutMs: 5000,
      contextFile: 'profile.md',
    });
  });

  test('a station entry honors timeout_ms and context_file', () => {
    const reg = build(
      'vaults:\n  team: {type: station, url: "http://localhost:8080/base", api_key_env: STATION_KEY, timeout_ms: 250, context_file: team.md}\n',
    );
    expect(reg.vaults[0]).toMatchObject({ url: 'http://localhost:8080/base', timeoutMs: 250, contextFile: 'team.md' });
  });

  test('explicit type: local is the same as omitting it', () => {
    const reg = build('vaults:\n  personal: {type: local, path: ~/v}\n');
    expect(reg.vaults[0]).toEqual({ type: 'local', name: 'personal', path: '/home/tester/v', contextFile: 'profile.md' });
  });

  test('a station-only config is valid, with the station as default', () => {
    const reg = build(`vaults:\n  team: ${STATION}\n`);
    expect(reg.defaultVault).toBe('team');
  });

  test('without a personal vault, any shared vault may be the default', () => {
    const reg = build(
      `default_vault: shared\nvaults:\n  shared: {path: ~/s, sync: git-publication}\n  team: ${STATION}\n`,
    );
    expect(reg.defaultVault).toBe('shared');
  });

  test('a station needs no path, so path existence is not checked for it', () => {
    expect(() => build(`vaults:\n  team: ${STATION}\n`, { pathExists: existsNone })).not.toThrow();
  });

  test('a vault path that does not exist → path_missing (+ directory message)', () => {
    let thrown: unknown;
    try {
      build('vaults:\n  personal: {path: ~/vault}\n', { pathExists: existsNone });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultConfigError);
    expect((thrown as VaultConfigError).code).toBe('path_missing');
    expect((thrown as VaultConfigError).message).toMatch(/not an existing directory/);
  });

  test('empty config file → malformed with a clear "config file is empty" message', () => {
    let thrown: unknown;
    try {
      build('# just a comment\n');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultConfigError);
    expect((thrown as VaultConfigError).code).toBe('malformed');
    expect((thrown as VaultConfigError).message).toMatch(/config file is empty/i);
  });

  test('invalid YAML → parse_error', () => {
    let thrown: unknown;
    try {
      build('vaults:\n  personal: {path: [unclosed\n');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultConfigError);
    expect((thrown as VaultConfigError).code).toBe('parse_error');
  });
});

describe('exclude-tags resolution end-to-end (AC1: env wins over YAML)', () => {
  // Mirrors mcp-entry.ts: resolveDefaultExcludeTags(env, registry.defaultExcludeTags).
  test('DOSSIER_EXCLUDE_TAGS overrides the YAML exclude_tags', () => {
    const reg = build('exclude_tags: [archived, historical]\nvaults:\n  personal: {path: ~/vault}\n');
    expect(resolveDefaultExcludeTags('draft,wip', reg.defaultExcludeTags)).toEqual(['draft', 'wip']);
  });

  test('unset env → the YAML exclude_tags are used', () => {
    const reg = build('exclude_tags: [draft]\nvaults:\n  personal: {path: ~/vault}\n');
    expect(resolveDefaultExcludeTags(undefined, reg.defaultExcludeTags)).toEqual(['draft']);
  });

  test('empty-string env → [] opt-out beats the YAML exclude_tags', () => {
    const reg = build('exclude_tags: [archived]\nvaults:\n  personal: {path: ~/vault}\n');
    expect(resolveDefaultExcludeTags('', reg.defaultExcludeTags)).toEqual([]);
  });

  test('no YAML exclude_tags + unset env → the default exclude set', () => {
    const reg = build('vaults:\n  personal: {path: ~/vault}\n');
    expect(resolveDefaultExcludeTags(undefined, reg.defaultExcludeTags)).toEqual(['archived', 'historical']);
  });
});

describe('resolveConfigSource — resolution chain', () => {
  const join = (...parts: string[]) => parts.join('/');

  test('DOSSIER_CONFIG set and file exists → that file', () => {
    const src = resolveConfigSource(
      { DOSSIER_CONFIG: '/etc/dossier.yaml' },
      { homeDir: HOME, fileExists: existsAll, join },
    );
    expect(src).toEqual({ kind: 'file', path: '/etc/dossier.yaml' });
  });

  test('DOSSIER_CONFIG set but file missing → config_not_found', () => {
    expect(() =>
      resolveConfigSource({ DOSSIER_CONFIG: '/nope.yaml' }, { homeDir: HOME, fileExists: existsNone, join }),
    ).toThrow(VaultConfigError);
  });

  test('no DOSSIER_CONFIG, XDG default file exists → XDG path', () => {
    const src = resolveConfigSource(
      {},
      { homeDir: HOME, fileExists: (p) => p === '/home/tester/.config/dossier/config.yaml', join },
    );
    expect(src).toEqual({ kind: 'file', path: '/home/tester/.config/dossier/config.yaml' });
  });

  test('honors XDG_CONFIG_HOME when set', () => {
    const src = resolveConfigSource(
      { XDG_CONFIG_HOME: '/custom/xdg' },
      { homeDir: HOME, fileExists: (p) => p === '/custom/xdg/dossier/config.yaml', join },
    );
    expect(src).toEqual({ kind: 'file', path: '/custom/xdg/dossier/config.yaml' });
  });

  test('nothing set and no XDG file → fallback', () => {
    const src = resolveConfigSource({}, { homeDir: HOME, fileExists: existsNone, join });
    expect(src).toEqual({ kind: 'fallback' });
  });
});

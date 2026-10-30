import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// @ts-expect-error -- plain ESM build script without type declarations
import { buildBootstrap, listMigrations, prepareForSingleTransaction, sha256, topLevelLineStarts } from '../../scripts/clean-install/build-bootstrap.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const INSTALL = path.join(ROOT, 'supabase', 'clean-install');
const read = (p: string) => fs.readFileSync(p, 'utf8');

type Override = {
  version: string;
  migration_file: string;
  override_file: string;
  treatment: string;
  original_sha256: string;
  override_sha256: string;
  effects_retained: string[];
  effects_not_replayed: string[];
};
const manifest = JSON.parse(read(path.join(INSTALL, 'manifest.json'))) as {
  denied_project_refs: string[];
  overrides: Override[];
};
const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const GUARD = '20260701200000_clean_install_outbound_request_guard.sql';
const DEFAULTS = '20261031090000_clean_install_integration_defaults.sql';
const ISSUE45_VERSION = '20261028140000';
const DENIED = manifest.denied_project_refs[0];
const version = (f: string) => f.split('_', 1)[0];
const withoutComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

describe('clean-install: ordering of the safety migrations', () => {
  it('the outbound request guard runs before any migration that uses pg_net, pg_cron or the http extension', () => {
    const risky = files.filter((f) => f !== GUARD && /net\.http_|cron\.(schedule|alter_job)|extensions\.http_|create extension[^;]*(pg_net|pg_cron)/i.test(read(path.join(MIGRATIONS, f))));
    expect(risky.length).toBeGreaterThan(0);
    expect(files.indexOf(GUARD)).toBeGreaterThanOrEqual(0);
    for (const f of risky) expect(version(f) > version(GUARD)).toBe(true);
    expect(files.indexOf(GUARD)).toBe(files.indexOf(risky[0]) - 1);
  });

  it('the integration-defaults migration is the latest migration and runs after #45, validity and P1', () => {
    expect(files[files.length - 1]).toBe(DEFAULTS);
    expect(version(DEFAULTS) > ISSUE45_VERSION).toBe(true);
    expect(version(DEFAULTS) > '20261029100000').toBe(true);
  });

  it('the guard blocks every pg_net request that is not on an explicit allowlist', () => {
    const sql = read(path.join(MIGRATIONS, GUARD));
    expect(sql).toMatch(/BEFORE INSERT ON net\.http_request_queue/);
    expect(sql).toMatch(/RAISE EXCEPTION 'Outbound HTTP request blocked/);
    expect(sql).toMatch(/REVOKE ALL ON SCHEMA platform_ops FROM anon, authenticated/);
    expect(withoutComments(sql)).not.toMatch(/INSERT INTO platform_ops\.outbound_request_allowlist/i);
  });

  it('the defaults migration deactivates jobs, removes hard-coded invokers and asserts the result', () => {
    const sql = read(path.join(MIGRATIONS, DEFAULTS));
    expect(sql).toMatch(/cron\.alter_job\(job_id := j\.jobid, active := false\)/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.invoke_queue_processor\(fn_slug text\)/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.invoke_scheduled_briefings\(\)/);
    expect(sql).toMatch(/functions still embed a Supabase project address/);
    expect(sql).toMatch(/scheduled job\(s\) are still active/);
    expect(withoutComments(sql)).not.toMatch(/INSERT INTO platform_ops\.(runtime_config|outbound_request_allowlist)/i);
    expect(sql).not.toMatch(/https:\/\/[a-z0-9]+\.supabase\.co/i);
  });
});

describe('clean-install: original project references', () => {
  it('only the two known historical migrations mention the original project', () => {
    const hits = files.filter((f) => read(path.join(MIGRATIONS, f)).includes(DENIED));
    expect(hits).toEqual([
      '20260701201005_fix_pg_cron_queue_sweeps_with_cron_secret.sql',
      '20260707060457_20260707_schedule_briefing_runner_cron.sql',
    ]);
  });

  it('nothing else in the clean-install tooling targets the original project', () => {
    for (const f of fs.readdirSync(path.join(INSTALL, 'overrides'))) {
      expect(read(path.join(INSTALL, 'overrides', f))).not.toContain(DENIED);
    }
    expect(read(path.join(MIGRATIONS, DEFAULTS))).not.toContain(DENIED);
    expect(read(path.join(MIGRATIONS, GUARD))).not.toContain(DENIED);
  });
});

describe('clean-install: historical overrides', () => {
  it('covers exactly the eight migrations that cannot be replayed verbatim', () => {
    expect(manifest.overrides.map((o) => o.version).sort()).toEqual([
      '20260712095937', '20260722093701', '20260725073902', '20260725073951',
      '20260801092711', '20260802230228', '20260804050844', '20260804100038',
    ]);
  });

  it('historical files are unchanged and overrides match their reviewed checksums', () => {
    for (const o of manifest.overrides) {
      expect(sha256(read(path.join(MIGRATIONS, o.migration_file)))).toBe(o.original_sha256);
      expect(sha256(read(path.join(INSTALL, o.override_file)))).toBe(o.override_sha256);
      const text = read(path.join(INSTALL, o.override_file));
      expect(text).toContain(`Original SHA-256: ${o.original_sha256}`);
      expect(text).toContain(`Treatment: ${o.treatment}`);
    }
  });

  it('repaired files differ from the original only by rejoining one split comment line', () => {
    for (const o of manifest.overrides.filter((x) => x.treatment === 'repaired_export_defect')) {
      const original = read(path.join(MIGRATIONS, o.migration_file));
      const body = read(path.join(INSTALL, o.override_file)).replace(/^\/\*[\s\S]*?\*\/\n/, '');
      const a = original.split('\n');
      const b = body.split('\n');
      expect(a.length - b.length).toBe(1);
      const i = a.findIndex((line, idx) => line !== b[idx]);
      expect(a[i].trim().startsWith('--')).toBe(true);
      expect(a[i].trimEnd().endsWith(';')).toBe(true);
      expect(b[i]).toBe(`${a[i]}${a[i + 1]}`);
      expect(a.slice(i + 2)).toEqual(b.slice(i + 1));
    }
  });

  it('schema-only overrides keep the original statements verbatim and drop only data writes', () => {
    for (const o of manifest.overrides.filter((x) => x.treatment === 'schema_effects_only')) {
      const original = read(path.join(MIGRATIONS, o.migration_file));
      const body = read(path.join(INSTALL, o.override_file)).split('-- Verbatim from the original file:\n')[1];
      expect(body).toBeTruthy();
      expect(original).toContain(body.trimEnd());
      expect(body).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b/im);
      expect(o.effects_retained.length).toBeGreaterThan(0);
    }
  });

  it('data-only overrides execute nothing but a notice', () => {
    for (const o of manifest.overrides.filter((x) => x.treatment === 'environment_specific_data_not_replayed')) {
      const body = read(path.join(INSTALL, o.override_file)).replace(/^\/\*[\s\S]*?\*\/\n/, '');
      expect(body.trim()).toMatch(/^DO \$\$ BEGIN RAISE NOTICE '.*'; END \$\$;$/);
      expect(o.effects_not_replayed.length).toBeGreaterThan(0);
    }
  });

  it('the split-comment export defect occurs only in the two repaired files', () => {
    const affected = files.filter((f) => {
      const lines = read(path.join(MIGRATIONS, f)).split('\n');
      return lines.some((line, i) => i > 0 && /^\s*--.*;\s*$/.test(lines[i - 1]) && /^ [a-z]/.test(line));
    });
    expect(affected).toEqual([
      '20260802230228_ewo049_restore_canonical_numbering_policy.sql',
      '20260804050844_20260804000000_ewo047r2_fix_project_id_type_cast.sql.sql',
    ]);
  });
});

describe('clean-install: single-transaction bootstrap builder', () => {
  const COMMIT = 'abcdef1234567';
  const built = buildBootstrap({ repoRoot: ROOT, sourceCommit: COMMIT });

  it('opens one transaction and commits once, at the end', () => {
    const lines = built.sql.split('\n');
    const starts = topLevelLineStarts(built.sql);
    const tx = lines.filter((l: string, i: number) => starts[i] && /^\s*(BEGIN|COMMIT)\s*;\s*$/i.test(l));
    expect(tx).toEqual(['BEGIN;', 'COMMIT;']);
    expect(lines.filter((l: string) => l.trim()).pop()).toBe('COMMIT;');
  });

  it('records every migration in the ledger with the executed text', () => {
    expect(built.migrationCount).toBe(files.length);
    const inserts = built.sql.match(/^INSERT INTO supabase_migrations\.schema_migrations /gm) ?? [];
    expect(inserts.length).toBe(files.length);
    expect((built.sql.match(/^RESET ALL;$/gm) ?? []).length).toBe(files.length + 1);
  });

  it('applies the eight overrides and leaves every other migration verbatim', () => {
    const overridden = built.report.filter((r: { treatment: string }) => r.treatment !== 'verbatim' && r.treatment !== 'session_state_emulation');
    expect(overridden.map((r: { version: string }) => r.version).sort()).toEqual(manifest.overrides.map((o) => o.version).sort());
    expect(built.sql).toContain('clean install: 20260712095937 not replayed');
    expect(built.sql).toContain("INSERT INTO platform_ops.clean_install_runs (source_commit, manifest_sha256, migration_count, transaction_mode) VALUES ('abcdef1234567'");
  });

  it('removes only top-level BEGIN/COMMIT pairs from files that wrap themselves in a transaction', () => {
    const tx = built.report.filter((r: { removedTransactionControl: number }) => r.removedTransactionControl > 0);
    expect(tx.length).toBeGreaterThanOrEqual(8);
    for (const r of tx) expect(r.removedTransactionControl).toBe(2);
  });

  it('emulates the original per-session behaviour for exactly one file, for that file only', () => {
    const emulated = built.report.filter((r: { treatment: string }) => r.treatment === 'session_state_emulation');
    expect(emulated.map((r: { version: string }) => r.version)).toEqual(['20260725230259']);
    const at = built.sql.indexOf("\\echo '[335/");
    const block = built.sql.slice(at, built.sql.indexOf('\\echo', at + 10));
    expect(block).toContain("SELECT pg_catalog.set_config('app.bypass_lifecycle_validation', 'true', true);");
    // The setting is transaction-local and RESET ALL runs before the next file.
    expect(built.sql.slice(built.sql.indexOf('\\echo', at + 10)).split('\n')[1]).toBe('RESET ALL;');
    expect((built.sql.match(/set_config\('app\.bypass_lifecycle_validation', 'true', true\);\n\/\*/g) ?? []).length).toBe(2);
  });

  it('the only NULL-sensitive session check in the history is the lifecycle trigger that the emulation covers', () => {
    const checks = new Set<string>();
    for (const f of files) {
      for (const m of read(path.join(MIGRATIONS, f)).matchAll(/current_setting\('([a-z_.]+)', *true\)\s*(!=|<>)/g)) checks.add(m[1]);
    }
    expect([...checks]).toEqual(['app.bypass_lifecycle_validation']);
  });

  it('refuses to run against a non-empty database', () => {
    expect(built.sql).toMatch(/clean install refused: the public schema already contains tables/);
    expect(built.sql).toMatch(/clean install refused: the migration ledger is not empty/);
  });

  it('does not treat BEGIN or COMMIT inside function bodies or comments as transaction control', () => {
    const sql = "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\nCOMMIT;\nEND $$;\n/* \nCOMMIT;\n*/\n-- COMMIT;\nSELECT 'x\nBEGIN;\n';\n";
    const out = prepareForSingleTransaction(sql, 'fixture');
    expect(out.removed).toEqual([]);
    expect(out.sql).toBe(sql);
  });

  it('rejects statements that cannot run inside one transaction', () => {
    expect(() => prepareForSingleTransaction('CREATE INDEX CONCURRENTLY i ON t (c);\n', 'fixture')).toThrow(/cannot run inside a transaction block/);
    expect(() => prepareForSingleTransaction('ROLLBACK;\n', 'fixture')).toThrow(/transaction control/);
    expect(() => prepareForSingleTransaction('\\set x 1\n', 'fixture')).toThrow(/psql meta-command/);
    expect(() => topLevelLineStarts('SELECT $$ unterminated\n')).toThrow(/unterminated/);
  });

  it('refuses a historical migration that changed after its override was reviewed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-install-'));
    fs.mkdirSync(path.join(tmp, 'supabase'), { recursive: true });
    fs.cpSync(MIGRATIONS, path.join(tmp, 'supabase', 'migrations'), { recursive: true });
    fs.cpSync(INSTALL, path.join(tmp, 'supabase', 'clean-install'), { recursive: true });
    const target = path.join(tmp, 'supabase', 'migrations', manifest.overrides[0].migration_file);
    fs.appendFileSync(target, '\n-- edited\n');
    expect(() => buildBootstrap({ repoRoot: tmp, sourceCommit: COMMIT })).toThrow(/has changed since its override was reviewed/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists migrations with the Supabase CLI version/name rule', () => {
    const list = listMigrations(MIGRATIONS);
    const doubled = list.find((m: { file: string }) => m.file.endsWith('.sql.sql'));
    expect(doubled.name.endsWith('.sql')).toBe(true);
    expect(new Set(list.map((m: { version: string }) => m.version)).size).toBe(list.length);
  });
});

describe('clean-install: bootstrap wrapper safeguards', () => {
  const sh = read(path.join(ROOT, 'scripts', 'clean-install', 'bootstrap-database.sh'));
  it('refuses denied project refs, dirty migration trees and only applies with --execute', () => {
    expect(sh).toMatch(/denied_project_refs/);
    expect(sh).toMatch(/refused: the connection string targets a denied project/);
    expect(sh).toMatch(/uncommitted changes/);
    expect(sh).toMatch(/dry run only: pass --execute to apply/);
    expect(sh).not.toMatch(/echo[^\n]*\$DB_URL/);
  });
});

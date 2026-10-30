#!/usr/bin/env node
/**
 * Clean-install bootstrap builder.
 *
 * Produces ONE psql script that installs every migration in
 * supabase/migrations into an EMPTY database inside a single transaction, and
 * records each one in the Supabase CLI migration ledger
 * (supabase_migrations.schema_migrations) in the same transaction.
 *
 * Why a single transaction: historical migrations schedule pg_cron jobs and
 * define functions that call the original Supabase project. Inside one
 * transaction nothing is visible to the pg_cron scheduler or the pg_net worker
 * until COMMIT, and by then 20261031090000_clean_install_integration_defaults
 * has set every job inactive and replaced the hard-coded invokers. No job can
 * run, and no request can be queued, at any point during installation.
 *
 * Historical files are never modified. The treatments in
 * supabase/clean-install/manifest.json are applied here, and the executed
 * text is what is written to the ledger, so the ledger is a truthful record.
 *
 * Usage: node scripts/clean-install/build-bootstrap.mjs --out <file.sql> --source-commit <sha>
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATION_NAME = /^([0-9]+)_(.*)\.sql$/;
const TOP_LEVEL_TX_REMOVABLE = /^\s*(BEGIN|COMMIT)\s*;\s*$/i;
const TOP_LEVEL_TX_FORBIDDEN =
  /^\s*(ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION|BEGIN\s+(WORK|TRANSACTION|ISOLATION)|COMMIT\s+(WORK|TRANSACTION|AND|PREPARED)|END\s*;|ABORT|PREPARE\s+TRANSACTION)\b/i;
const NOT_IN_TRANSACTION =
  /\b(CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|REINDEX\s+[^;]*CONCURRENTLY|VACUUM|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+SYSTEM|CREATE\s+TABLESPACE)\b/i;

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * For each line, report whether it starts at top level (not inside a string,
 * quoted identifier, comment or dollar-quoted body). Throws if the file ends
 * inside an unterminated construct.
 */
export function topLevelLineStarts(sql) {
  const starts = [];
  let state = 'normal';
  let dollarTag = '';
  let blockDepth = 0;
  let atLineStart = true;
  for (let i = 0; i < sql.length; i += 1) {
    if (atLineStart) {
      starts.push(state === 'normal');
      atLineStart = false;
    }
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '\n') {
      if (state === 'line') state = 'normal';
      atLineStart = true;
      continue;
    }
    switch (state) {
      case 'normal':
        if (c === '-' && next === '-') { state = 'line'; i += 1; }
        else if (c === '/' && next === '*') { state = 'block'; blockDepth = 1; i += 1; }
        else if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '$') {
          const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
          // A tag must not be glued to an identifier (e.g. foo$1$ is not a quote).
          const prev = sql[i - 1] ?? '';
          if (m && !/[A-Za-z0-9_]/.test(prev)) {
            state = 'dollar';
            dollarTag = m[0];
            i += m[0].length - 1;
          }
        }
        break;
      case 'line':
        break;
      case 'block':
        if (c === '/' && next === '*') { blockDepth += 1; i += 1; }
        else if (c === '*' && next === '/') { blockDepth -= 1; i += 1; if (blockDepth === 0) state = 'normal'; }
        break;
      case 'single':
        if (c === "'") { if (next === "'") i += 1; else state = 'normal'; }
        break;
      case 'double':
        if (c === '"') { if (next === '"') i += 1; else state = 'normal'; }
        break;
      case 'dollar':
        if (sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; state = 'normal'; dollarTag = ''; }
        break;
      default:
        throw new Error(`lexer state ${state}`);
    }
  }
  if (atLineStart) starts.push(state === 'normal');
  if (state !== 'normal' && state !== 'line') {
    throw new Error(`file ends inside an unterminated ${state === 'dollar' ? `dollar-quoted body (${dollarTag})` : state}`);
  }
  return starts;
}

/** Remove top-level BEGIN;/COMMIT; lines and reject anything that cannot run in one transaction. */
export function prepareForSingleTransaction(sql, label) {
  const lines = sql.split('\n');
  const starts = topLevelLineStarts(sql);
  const removed = [];
  const kept = [];
  lines.forEach((line, idx) => {
    const top = starts[idx];
    if (top && /^\s*\\/.test(line)) {
      throw new Error(`${label}: line ${idx + 1} is a psql meta-command, which migrations must not contain`);
    }
    if (top && TOP_LEVEL_TX_REMOVABLE.test(line)) {
      removed.push({ line: idx + 1, text: line.trim() });
      kept.push(`-- [clean-install] removed top-level ${line.trim()} (single-transaction install)`);
      return;
    }
    if (top && TOP_LEVEL_TX_FORBIDDEN.test(line)) {
      throw new Error(`${label}: line ${idx + 1} has transaction control "${line.trim()}" that a single-transaction install cannot honour`);
    }
    if (top && NOT_IN_TRANSACTION.test(line)) {
      throw new Error(`${label}: line ${idx + 1} contains a statement that cannot run inside a transaction block`);
    }
    kept.push(line);
  });
  return { sql: kept.join('\n'), removed };
}

export function listMigrations(migrationsDir) {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Map();
  return files.map((file) => {
    const m = MIGRATION_NAME.exec(file);
    if (!m) throw new Error(`migration file name does not match <version>_<name>.sql: ${file}`);
    const [, version, name] = m;
    if (seen.has(version)) throw new Error(`duplicate migration version ${version}: ${seen.get(version)} and ${file}`);
    seen.set(version, file);
    return { file, version, name };
  });
}

function dollarTagFor(text) {
  for (;;) {
    const tag = `$clean_install_${randomBytes(6).toString('hex')}$`;
    if (!text.includes(tag)) return tag;
  }
}

function literal(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

export function buildBootstrap({ repoRoot, sourceCommit }) {
  if (!/^[0-9a-f]{7,40}$/.test(sourceCommit ?? '')) {
    throw new Error('sourceCommit must be a git commit SHA');
  }
  const migrationsDir = join(repoRoot, 'supabase', 'migrations');
  const installDir = join(repoRoot, 'supabase', 'clean-install');
  const manifestText = readFileSync(join(installDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const migrations = listMigrations(migrationsDir);
  const byVersion = new Map(migrations.map((m) => [m.version, m]));

  const overrides = new Map();
  for (const o of manifest.overrides) {
    const mig = byVersion.get(o.version);
    if (!mig || mig.file !== o.migration_file) {
      throw new Error(`manifest override ${o.version} does not match a migration file (${o.migration_file})`);
    }
    const original = readFileSync(join(migrationsDir, mig.file), 'utf8');
    if (sha256(original) !== o.original_sha256) {
      throw new Error(`historical migration ${mig.file} has changed since its override was reviewed (SHA-256 mismatch)`);
    }
    const override = readFileSync(join(installDir, o.override_file), 'utf8');
    if (sha256(override) !== o.override_sha256) {
      throw new Error(`override ${o.override_file} does not match its reviewed SHA-256`);
    }
    overrides.set(o.version, { ...o, text: override });
  }

  const out = [];
  const report = [];
  out.push('-- Generated by scripts/clean-install/build-bootstrap.mjs. Do not edit by hand.');
  out.push(`-- Source commit: ${sourceCommit}`);
  out.push(`-- Manifest SHA-256: ${sha256(manifestText)}`);
  out.push(`-- Migrations: ${migrations.length}`);
  out.push('\\set ON_ERROR_STOP on');
  out.push('BEGIN;');
  out.push(`DO $clean_install_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'public') THEN
    RAISE EXCEPTION 'clean install refused: the public schema already contains tables';
  END IF;
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations) THEN
      RAISE EXCEPTION 'clean install refused: the migration ledger is not empty';
    END IF;
  END IF;
END
$clean_install_preflight$;`);
  out.push('CREATE SCHEMA IF NOT EXISTS supabase_migrations;');
  out.push('CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);');
  out.push('ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];');
  out.push('ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;');

  migrations.forEach((mig, index) => {
    const override = overrides.get(mig.version);
    const source = override ? override.text : readFileSync(join(migrationsDir, mig.file), 'utf8');
    const { sql, removed } = prepareForSingleTransaction(source, mig.file);
    const tag = dollarTagFor(sql);
    out.push('');
    out.push(`\\echo '[${index + 1}/${migrations.length}] ${mig.version} ${override ? `(override: ${override.treatment})` : ''}'`);
    // Mirror the per-file transaction boundary of the Supabase CLI: settings made
    // with SET LOCAL / set_config(..., true) in one file must not leak into the next.
    out.push('RESET ALL;');
    out.push(sql);
    out.push(';');
    out.push(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES (${literal(mig.version)}, ${literal(mig.name)}, ARRAY[${tag}${sql}${tag}]);`);
    report.push({
      version: mig.version,
      file: mig.file,
      treatment: override ? override.treatment : 'verbatim',
      removedTransactionControl: removed.length,
      executedSha256: sha256(sql),
    });
  });

  out.push('');
  out.push('RESET ALL;');
  for (const r of report.filter((x) => x.treatment !== 'verbatim')) {
    const o = overrides.get(r.version);
    out.push(`INSERT INTO platform_ops.clean_install_overrides (version, migration_name, treatment, original_sha256, executed_sha256, reason) VALUES (${literal(o.version)}, ${literal(o.migration_file)}, ${literal(o.treatment)}, ${literal(o.original_sha256)}, ${literal(r.executedSha256)}, ${literal(o.fresh_install_failure)});`);
  }
  out.push(`INSERT INTO platform_ops.clean_install_runs (source_commit, manifest_sha256, migration_count, transaction_mode) VALUES (${literal(sourceCommit)}, ${literal(sha256(manifestText))}, ${migrations.length}, 'single_transaction');`);
  out.push('COMMIT;');
  out.push('');
  return { sql: out.join('\n'), report, manifest, migrationCount: migrations.length };
}

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
  const outPath = args.get('--out');
  const sourceCommit = args.get('--source-commit');
  if (!outPath || !sourceCommit) {
    console.error('usage: build-bootstrap.mjs --out <file.sql> --source-commit <sha>');
    process.exit(2);
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { sql, report, migrationCount } = buildBootstrap({ repoRoot, sourceCommit });
  writeFileSync(outPath, sql, 'utf8');
  const overridden = report.filter((r) => r.treatment !== 'verbatim');
  const txFiles = report.filter((r) => r.removedTransactionControl > 0);
  console.log(`migrations=${migrationCount} overrides=${overridden.length} files_with_removed_begin_commit=${txFiles.length}`);
  for (const r of overridden) console.log(`override ${r.version} ${r.treatment}`);
  for (const r of txFiles) console.log(`single-transaction ${r.version} removed=${r.removedTransactionControl}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

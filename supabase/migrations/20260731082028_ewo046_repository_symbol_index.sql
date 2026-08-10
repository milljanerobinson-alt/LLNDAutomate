/*
# EWO-046: Repository Symbol & Content Index

## Purpose
Creates a governed repository content index that stores extracted symbols
(functions, classes, interfaces, types, enums, constants, imports, exports)
and file content metadata for the EIOS repository intelligence system.
This enables symbol-level search without depending on GitHub Code Search.

## New Tables

### eios_repo_index_snapshots
Tracks each indexing run: which repository, branch, commit SHA, when it ran,
how many files were indexed, and how many symbols were extracted.
Used to determine index freshness and trigger incremental refreshes.

### eios_repo_indexed_files
One row per indexed file. Stores the file path, language, size, content hash
(for incremental change detection), and a snapshot of the symbol count.
Used to detect which files changed between indexing runs.

### eios_repo_symbol_index
One row per extracted symbol. Stores the symbol name, kind (function, class,
interface, type, enum, constant, import, export, hook, component, rpc, route),
the file path where it was found, the line number, and an optional export name
and signature. This is the primary search target for symbol queries.

## Security
- RLS enabled on all three tables.
- Policies allow anon + authenticated to read (search) the index.
- Policies allow authenticated users to insert/update/delete (build the index).
- No user_id ownership — the index is shared repository intelligence.

## Important Notes
1. The index is rebuilt by reading files from the repository tree and extracting
   symbols client-side. No server-side indexing is performed.
2. Incremental indexing uses content_hash to detect changed files.
3. The search pipeline checks index freshness via snapshot timestamps.
*/

-- Index Snapshots
CREATE TABLE IF NOT EXISTS eios_repo_index_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  branch text NOT NULL,
  commit_sha text,
  status text NOT NULL DEFAULT 'running',
  files_indexed integer NOT NULL DEFAULT 0,
  symbols_extracted integer NOT NULL DEFAULT 0,
  duration_ms integer,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);


ALTER TABLE eios_repo_index_snapshots ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS "anon_select_index_snapshots" ON eios_repo_index_snapshots;

CREATE POLICY "anon_select_index_snapshots" ON eios_repo_index_snapshots
  FOR SELECT TO anon, authenticated USING (true);


DROP POLICY IF EXISTS "auth_insert_index_snapshots" ON eios_repo_index_snapshots;

CREATE POLICY "auth_insert_index_snapshots" ON eios_repo_index_snapshots
  FOR INSERT TO authenticated WITH CHECK (true);


DROP POLICY IF EXISTS "auth_update_index_snapshots" ON eios_repo_index_snapshots;

CREATE POLICY "auth_update_index_snapshots" ON eios_repo_index_snapshots
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


-- Indexed Files
CREATE TABLE IF NOT EXISTS eios_repo_indexed_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid REFERENCES eios_repo_index_snapshots(id) ON DELETE CASCADE,
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  file_path text NOT NULL,
  language text NOT NULL,
  file_size integer NOT NULL DEFAULT 0,
  content_hash text,
  symbol_count integer NOT NULL DEFAULT 0,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_owner, repository_name, file_path)
);


ALTER TABLE eios_repo_indexed_files ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS "anon_select_indexed_files" ON eios_repo_indexed_files;

CREATE POLICY "anon_select_indexed_files" ON eios_repo_indexed_files
  FOR SELECT TO anon, authenticated USING (true);


DROP POLICY IF EXISTS "auth_insert_indexed_files" ON eios_repo_indexed_files;

CREATE POLICY "auth_insert_indexed_files" ON eios_repo_indexed_files
  FOR INSERT TO authenticated WITH CHECK (true);


DROP POLICY IF EXISTS "auth_update_indexed_files" ON eios_repo_indexed_files;

CREATE POLICY "auth_update_indexed_files" ON eios_repo_indexed_files
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


DROP POLICY IF EXISTS "auth_delete_indexed_files" ON eios_repo_indexed_files;

CREATE POLICY "auth_delete_indexed_files" ON eios_repo_indexed_files
  FOR DELETE TO authenticated USING (true);


-- Symbol Index
CREATE TABLE IF NOT EXISTS eios_repo_symbol_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  file_path text NOT NULL,
  symbol_name text NOT NULL,
  symbol_kind text NOT NULL,
  line_number integer,
  export_name text,
  signature text,
  imported_from text,
  indexed_at timestamptz NOT NULL DEFAULT now()
);


ALTER TABLE eios_repo_symbol_index ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS "anon_select_symbol_index" ON eios_repo_symbol_index;

CREATE POLICY "anon_select_symbol_index" ON eios_repo_symbol_index
  FOR SELECT TO anon, authenticated USING (true);


DROP POLICY IF EXISTS "auth_insert_symbol_index" ON eios_repo_symbol_index;

CREATE POLICY "auth_insert_symbol_index" ON eios_repo_symbol_index
  FOR INSERT TO authenticated WITH CHECK (true);


DROP POLICY IF EXISTS "auth_delete_symbol_index" ON eios_repo_symbol_index;

CREATE POLICY "auth_delete_symbol_index" ON eios_repo_symbol_index
  FOR DELETE TO authenticated USING (true);


-- Indexes for search performance
CREATE INDEX IF NOT EXISTS idx_symbol_index_name ON eios_repo_symbol_index (symbol_name);

CREATE INDEX IF NOT EXISTS idx_symbol_index_kind ON eios_repo_symbol_index (symbol_kind);

CREATE INDEX IF NOT EXISTS idx_symbol_index_repo ON eios_repo_symbol_index (repository_owner, repository_name);

CREATE INDEX IF NOT EXISTS idx_symbol_index_file ON eios_repo_symbol_index (file_path);

CREATE INDEX IF NOT EXISTS idx_indexed_files_repo ON eios_repo_indexed_files (repository_owner, repository_name);

CREATE INDEX IF NOT EXISTS idx_snapshots_repo ON eios_repo_index_snapshots (repository_owner, repository_name, created_at DESC);
;

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { resolve } from "path";
import { mkdirSync } from "fs";

const dataDir = resolve(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

const DB_PATH = resolve(dataDir, "prompt-optimizer.db");

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Auto-migrate on import
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    content TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT, strategy TEXT, score REAL,
    is_elite INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS test_cases (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    input TEXT NOT NULL, expected_output TEXT NOT NULL, scoring_criteria TEXT NOT NULL,
    difficulty TEXT NOT NULL DEFAULT 'medium', is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL REFERENCES prompts(id),
    test_case_id TEXT NOT NULL REFERENCES test_cases(id),
    output TEXT NOT NULL, score REAL NOT NULL, dimension_scores TEXT,
    run_number INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL REFERENCES prompts(id),
    tags TEXT NOT NULL, note TEXT, test_case_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS evolution_logs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    generation INTEGER NOT NULL, event_type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id);
  CREATE INDEX IF NOT EXISTS idx_prompts_active ON prompts(project_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_evaluations_prompt ON evaluations(prompt_id);
  CREATE INDEX IF NOT EXISTS idx_annotations_prompt ON annotations(prompt_id);
  CREATE INDEX IF NOT EXISTS idx_evolution_logs_project ON evolution_logs(project_id, generation);
`);

export const db = drizzle(sqlite, { schema });
export { schema };

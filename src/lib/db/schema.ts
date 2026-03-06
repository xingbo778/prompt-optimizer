import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  config: text("config", { mode: "json" }).$type<{
    populationSize: number;
    mutationsPerRound: number;
    topNThreshold: number;
    evaluationRuns: number;
  }>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const prompts = sqliteTable("prompts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  content: text("content").notNull(),
  generation: integer("generation").notNull().default(0),
  parentId: text("parent_id"),
  strategy: text("strategy"),
  score: real("score"),
  isElite: integer("is_elite", { mode: "boolean" }).notNull().default(false),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const testCases = sqliteTable("test_cases", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  input: text("input").notNull(),
  expectedOutput: text("expected_output").notNull(),
  scoringCriteria: text("scoring_criteria").notNull(),
  difficulty: text("difficulty").notNull().default("medium"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export const evaluations = sqliteTable("evaluations", {
  id: text("id").primaryKey(),
  promptId: text("prompt_id").notNull().references(() => prompts.id),
  testCaseId: text("test_case_id").notNull().references(() => testCases.id),
  output: text("output").notNull(),
  score: real("score").notNull(),
  dimensionScores: text("dimension_scores", { mode: "json" }).$type<{
    accuracy: number;
    format: number;
    consistency: number;
    edgeCases: number;
  }>(),
  runNumber: integer("run_number").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const annotations = sqliteTable("annotations", {
  id: text("id").primaryKey(),
  promptId: text("prompt_id").notNull().references(() => prompts.id),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
  note: text("note"),
  testCaseId: text("test_case_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const evolutionLogs = sqliteTable("evolution_logs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  generation: integer("generation").notNull(),
  eventType: text("event_type").notNull(),
  detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

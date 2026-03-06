import { db, schema } from "../db/index.js";
import { eq, and, desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { EvaluationResult } from "./evaluator.js";

export interface PromptEntry {
  id: string;
  content: string;
  generation: number;
  parentId: string | null;
  strategy: string | null;
  score: number | null;
  isElite: boolean;
  isActive: boolean;
}

export function getActivePopulation(projectId: string): PromptEntry[] {
  const rows = db
    .select()
    .from(schema.prompts)
    .where(and(eq(schema.prompts.projectId, projectId), eq(schema.prompts.isActive, true)))
    .orderBy(desc(schema.prompts.score))
    .all();
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    generation: r.generation,
    parentId: r.parentId,
    strategy: r.strategy,
    score: r.score,
    isElite: r.isElite,
    isActive: r.isActive,
  }));
}

export function addPrompt(
  projectId: string,
  content: string,
  generation: number,
  parentId: string | null,
  strategy: string | null
): string {
  const id = uuid();
  db.insert(schema.prompts)
    .values({
      id,
      projectId,
      content,
      generation,
      parentId,
      strategy,
      score: null,
      isElite: false,
      isActive: true,
      createdAt: new Date(),
    })
    .run();
  return id;
}

export function updateScore(promptId: string, score: number): void {
  db.update(schema.prompts).set({ score }).where(eq(schema.prompts.id, promptId)).run();
}

export function saveEvaluations(promptId: string, results: EvaluationResult[]): void {
  for (const r of results) {
    db.insert(schema.evaluations)
      .values({
        id: uuid(),
        promptId,
        testCaseId: r.testCaseId,
        output: r.output,
        score: r.score,
        dimensionScores: r.dimensionScores,
        runNumber: 1,
        createdAt: new Date(),
      })
      .run();
  }
}

export function enforcePopulationLimit(projectId: string, maxSize: number): string[] {
  const population = getActivePopulation(projectId);
  const eliminated: string[] = [];

  // Never eliminate elites
  const elites = population.filter((p) => p.isElite);
  const nonElites = population.filter((p) => !p.isElite);

  // If population exceeds limit, deactivate lowest-scoring non-elites
  const excess = population.length - maxSize;
  if (excess > 0) {
    // nonElites are already sorted by score desc from getActivePopulation
    const toRemove = nonElites.slice(-excess);
    for (const p of toRemove) {
      db.update(schema.prompts)
        .set({ isActive: false })
        .where(eq(schema.prompts.id, p.id))
        .run();
      eliminated.push(p.id);
    }
  }

  return eliminated;
}

export function markElite(promptId: string): void {
  db.update(schema.prompts).set({ isElite: true }).where(eq(schema.prompts.id, promptId)).run();
}

export function canJoinPopulation(
  projectId: string,
  candidateScore: number,
  topN: number
): boolean {
  const population = getActivePopulation(projectId);
  if (population.length < topN) return true;

  const topScores = population
    .filter((p) => p.score !== null)
    .map((p) => p.score!)
    .slice(0, topN);

  if (topScores.length < topN) return true;
  return candidateScore >= topScores[topScores.length - 1];
}

export function logEvolution(
  projectId: string,
  generation: number,
  eventType: string,
  detail: Record<string, unknown>
): void {
  db.insert(schema.evolutionLogs)
    .values({
      id: uuid(),
      projectId,
      generation,
      eventType,
      detail,
      createdAt: new Date(),
    })
    .run();
}

export function getEvolutionStats(projectId: string) {
  const population = getActivePopulation(projectId);
  const scores = population.filter((p) => p.score !== null).map((p) => p.score!);

  return {
    populationSize: population.length,
    eliteCount: population.filter((p) => p.isElite).length,
    topScore: scores.length > 0 ? Math.max(...scores) : null,
    avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    minScore: scores.length > 0 ? Math.min(...scores) : null,
  };
}

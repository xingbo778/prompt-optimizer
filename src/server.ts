import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { db, schema } from "./lib/db/index.js";
import { eq, desc } from "drizzle-orm";
import { mutate, getInitialStrategies } from "./lib/engine/mutator.js";
import { evaluate, type TestCase } from "./lib/engine/evaluator.js";
import { tagsToInstructions, getAllTags } from "./lib/engine/feedback.js";
import {
  addPrompt,
  updateScore,
  saveEvaluations,
  getActivePopulation,
  enforcePopulationLimit,
  canJoinPopulation,
  markElite,
  logEvolution,
  getEvolutionStats,
} from "./lib/engine/population.js";

const app = new Hono();

// Health check
app.get("/", (c) => c.json({ status: "ok", service: "prompt-evolution-system" }));

// ========== Projects ==========

app.post("/api/projects", async (c) => {
  const body = await c.req.json();
  const id = uuid();
  const config = {
    populationSize: body.populationSize ?? 6,
    mutationsPerRound: body.mutationsPerRound ?? 3,
    topNThreshold: body.topNThreshold ?? 3,
    evaluationRuns: body.evaluationRuns ?? 1,
  };
  db.insert(schema.projects)
    .values({ id, name: body.name, config, createdAt: new Date() })
    .run();
  return c.json({ id, name: body.name, config });
});

app.get("/api/projects", (c) => {
  const projects = db.select().from(schema.projects).all();
  return c.json(
    projects.map((p) => ({
      ...p,
      stats: getEvolutionStats(p.id),
    }))
  );
});

app.get("/api/projects/:id", (c) => {
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, c.req.param("id")))
    .get();
  if (!project) return c.json({ error: "Not found" }, 404);
  return c.json({ ...project, stats: getEvolutionStats(project.id) });
});

// ========== Test Cases ==========

app.post("/api/projects/:id/test-cases", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json();

  // Support single or batch
  const cases = Array.isArray(body) ? body : [body];
  const ids: string[] = [];

  for (const tc of cases) {
    const id = uuid();
    db.insert(schema.testCases)
      .values({
        id,
        projectId,
        input: tc.input,
        expectedOutput: tc.expectedOutput,
        scoringCriteria: tc.scoringCriteria,
        difficulty: tc.difficulty ?? "medium",
        isActive: true,
      })
      .run();
    ids.push(id);
  }

  return c.json({ created: ids.length, ids });
});

app.get("/api/projects/:id/test-cases", (c) => {
  const cases = db
    .select()
    .from(schema.testCases)
    .where(eq(schema.testCases.projectId, c.req.param("id")))
    .all();
  return c.json(cases);
});

// ========== Initialize (Round 0) ==========

app.post("/api/projects/:id/initialize", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json();
  const originalPrompt: string = body.prompt;

  if (!originalPrompt) return c.json({ error: "prompt is required" }, 400);

  const tcs = getTestCases(projectId);
  if (tcs.length === 0) return c.json({ error: "Add test cases first" }, 400);

  // Add original
  const originalId = addPrompt(projectId, originalPrompt, 0, null, "original");

  // Generate variants
  const strategies = getInitialStrategies();
  const variants: { id: string; strategy: string }[] = [];

  for (const strategy of strategies) {
    const content = await mutate({
      originalPrompt,
      strategy,
      existingVariants: [],
    });
    const id = addPrompt(projectId, content, 0, originalId, strategy);
    variants.push({ id, strategy });
  }

  // Evaluate all
  const allIds = [originalId, ...variants.map((v) => v.id)];
  const results: { id: string; score: number }[] = [];

  for (const pid of allIds) {
    const prompt = db.select().from(schema.prompts).where(eq(schema.prompts.id, pid)).get()!;
    const evalResults = await evaluate(prompt.content, tcs);
    const avgScore = Math.round((evalResults.reduce((s, r) => s + r.score, 0) / evalResults.length) * 100) / 100;
    updateScore(pid, avgScore);
    saveEvaluations(pid, evalResults);
    results.push({ id: pid, score: avgScore });
  }

  // Mark top as elite
  const population = getActivePopulation(projectId);
  if (population.length > 0) markElite(population[0].id);

  logEvolution(projectId, 0, "initialization", {
    promptCount: allIds.length,
    testCaseCount: tcs.length,
  });

  return c.json({
    generation: 0,
    prompts: results,
    leaderboard: getLeaderboard(projectId),
  });
});

// ========== Leaderboard ==========

app.get("/api/projects/:id/leaderboard", (c) => {
  return c.json(getLeaderboard(c.req.param("id")));
});

// ========== Prompt Detail ==========

app.get("/api/prompts/:id", (c) => {
  const promptId = c.req.param("id");
  const prompt = db.select().from(schema.prompts).where(eq(schema.prompts.id, promptId)).get();
  if (!prompt) return c.json({ error: "Not found" }, 404);

  const evals = db
    .select()
    .from(schema.evaluations)
    .where(eq(schema.evaluations.promptId, promptId))
    .all();

  return c.json({ ...prompt, evaluations: evals });
});

// ========== Annotate & Evolve ==========

app.get("/api/tags", (c) => c.json(getAllTags()));

app.post("/api/projects/:id/evolve", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json();

  // Annotation
  const annotation = {
    tags: body.tags as string[],
    note: body.note as string | undefined,
    promptId: body.promptId as string | undefined,
  };

  if (!annotation.tags || annotation.tags.length === 0) {
    return c.json({ error: "tags are required" }, 400);
  }

  // Save annotation
  const targetPromptId = annotation.promptId || getActivePopulation(projectId)[0]?.id;
  if (!targetPromptId) return c.json({ error: "No prompts in population" }, 400);

  db.insert(schema.annotations)
    .values({
      id: uuid(),
      promptId: targetPromptId,
      tags: annotation.tags,
      note: annotation.note ?? null,
      testCaseId: null,
      createdAt: new Date(),
    })
    .run();

  const instructions = tagsToInstructions(annotation);

  // Get config
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
  const config = project.config as any;
  const tcs = getTestCases(projectId);

  // Determine generation
  const logs = db
    .select()
    .from(schema.evolutionLogs)
    .where(eq(schema.evolutionLogs.projectId, projectId))
    .all();
  const generation = logs.length > 0 ? Math.max(...logs.map((l) => l.generation)) + 1 : 1;

  // Mutate from top prompt
  const population = getActivePopulation(projectId);
  const basePrompt = population[0];
  const mutationCount = config.mutationsPerRound || 3;

  const newVariants: { id: string; content: string; score: number }[] = [];

  for (let i = 0; i < mutationCount; i++) {
    const content = await mutate({
      originalPrompt: basePrompt.content,
      optimizationInstructions: instructions,
      strategy: "targeted",
      existingVariants: newVariants.map((v) => v.content),
    });
    const id = addPrompt(projectId, content, generation, basePrompt.id, "targeted");

    // Evaluate
    const evalResults = await evaluate(content, tcs);
    const avgScore = Math.round((evalResults.reduce((s, r) => s + r.score, 0) / evalResults.length) * 100) / 100;
    updateScore(id, avgScore);
    saveEvaluations(id, evalResults);

    // Check qualification
    if (!canJoinPopulation(projectId, avgScore, config.topNThreshold || 3)) {
      db.update(schema.prompts).set({ isActive: false }).where(eq(schema.prompts.id, id)).run();
      newVariants.push({ id, content, score: avgScore });
    } else {
      newVariants.push({ id, content, score: avgScore });
    }
  }

  // Enforce limit
  const eliminated = enforcePopulationLimit(projectId, config.populationSize || 6);

  // Update elite
  const updatedPop = getActivePopulation(projectId);
  if (updatedPop.length > 0) markElite(updatedPop[0].id);

  logEvolution(projectId, generation, "evolution", {
    annotationTags: annotation.tags,
    newVariants: newVariants.length,
    eliminated: eliminated.length,
  });

  return c.json({
    generation,
    instructions,
    newVariants: newVariants.map((v) => ({ id: v.id, score: v.score })),
    eliminated: eliminated.length,
    leaderboard: getLeaderboard(projectId),
  });
});

// ========== Evolution History ==========

app.get("/api/projects/:id/history", (c) => {
  const logs = db
    .select()
    .from(schema.evolutionLogs)
    .where(eq(schema.evolutionLogs.projectId, c.req.param("id")))
    .orderBy(desc(schema.evolutionLogs.generation))
    .all();
  return c.json(logs);
});

// ========== Export Best ==========

app.get("/api/projects/:id/best", (c) => {
  const population = getActivePopulation(c.req.param("id"));
  if (population.length === 0) return c.json({ error: "No prompts" }, 404);
  const best = population[0];
  return c.json({ id: best.id, content: best.content, score: best.score, generation: best.generation });
});

// ========== Helpers ==========

function getTestCases(projectId: string): TestCase[] {
  return db
    .select()
    .from(schema.testCases)
    .where(eq(schema.testCases.projectId, projectId))
    .all()
    .map((tc) => ({
      id: tc.id,
      input: tc.input,
      expectedOutput: tc.expectedOutput,
      scoringCriteria: tc.scoringCriteria,
    }));
}

function getLeaderboard(projectId: string) {
  const population = getActivePopulation(projectId);
  const stats = getEvolutionStats(projectId);
  return {
    stats,
    prompts: population.map((p, i) => ({
      rank: i + 1,
      id: p.id,
      score: p.score,
      generation: p.generation,
      strategy: p.strategy,
      isElite: p.isElite,
      preview: p.content.slice(0, 200),
    })),
  };
}

// ========== Start ==========

const port = parseInt(process.env.PORT || "3000");
console.log(`Starting server on port ${port}...`);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
});

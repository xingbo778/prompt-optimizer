import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
import { db, schema } from "./lib/db/index.js";
import { eq, desc, and } from "drizzle-orm";
import { chat } from "./lib/ai/client.js";
import { mutate, getInitialStrategies } from "./lib/engine/mutator.js";
import { evaluate, evaluateBatch, computeWeightedAvgScore, type TestCase } from "./lib/engine/evaluator.js";
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

// UI
app.get("/", (c) => {
  const html = readFileSync(resolve(__dirname, "ui.html"), "utf-8");
  return c.html(html);
});

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "prompt-evolution-system" }));

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

  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  const config = project.config as { evaluationRuns?: number };

  try {
    // Add original
    const originalId = addPrompt(projectId, originalPrompt, 0, null, "original");

    // Generate variants (parallel)
    const strategies = getInitialStrategies();
    const variantContents = await Promise.all(
      strategies.map((strategy) =>
        mutate({ originalPrompt, strategy, existingVariants: [] }).then((content) => ({ content, strategy }))
      )
    );
    const variants = variantContents.map(({ content, strategy }) => {
      const id = addPrompt(projectId, content, 0, originalId, strategy);
      return { id, content, strategy };
    });

    // Evaluate all prompts in parallel
    const allPrompts = [
      { id: originalId, content: originalPrompt },
      ...variants.map((v) => ({ id: v.id, content: v.content })),
    ];
    const evalMap = await evaluateBatch(allPrompts, tcs, config.evaluationRuns ?? 1);
    const results: { id: string; score: number }[] = [];

    for (const [pid, { results: evalResults, avgScore }] of evalMap) {
      updateScore(pid, avgScore);
      saveEvaluations(pid, evalResults);
      results.push({ id: pid, score: avgScore });
    }

    // Mark top as elite
    const population = getActivePopulation(projectId);
    if (population.length > 0) markElite(population[0].id);

    logEvolution(projectId, 0, "initialization", {
      promptCount: allPrompts.length,
      testCaseCount: tcs.length,
    });

    return c.json({
      generation: 0,
      prompts: results,
      leaderboard: getLeaderboard(projectId),
    });
  } catch (err: any) {
    console.error("Initialize error:", err);
    return c.json({ error: err.message || "Internal error" }, 500);
  }
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

// ========== Generate Test Cases ==========

app.post("/api/projects/:id/generate-test-cases", async (c) => {
  const body = await c.req.json();
  const prompt: string = body.prompt;
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  try {
    const systemPrompt = `You are an expert at creating comprehensive test cases for AI prompts.

Given an AI system prompt, generate exactly 10 diverse test cases that thoroughly evaluate it.

Requirements:
- Cover typical use cases, edge cases, and adversarial inputs
- Vary difficulty: include easy, medium, and hard cases
- Each expectedOutput should be concrete and specific (not vague)
- scoringCriteria should be measurable and specific to that test case

Respond ONLY with a valid JSON array of exactly 10 objects (no markdown, no explanation):
[{"input":"...","expectedOutput":"...","scoringCriteria":"...","difficulty":"easy|medium|hard"}, ...]`;

    const raw = await chat(systemPrompt, `System prompt to test:\n\n${prompt}`, {
      temperature: 0.8,
      role: "testgen",
      maxTokens: 8192,
    });

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found in response");
    const testCases = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(testCases)) throw new Error("Response is not an array");

    return c.json({ testCases });
  } catch (err: any) {
    console.error("Generate test cases error:", err);
    return c.json({ error: err.message || "Failed to generate test cases" }, 500);
  }
});

app.post("/api/projects/:id/evolve", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json();

  const annotation = {
    tags: body.tags as string[],
    note: body.note as string | undefined,
    promptId: body.promptId as string | undefined,
  };

  if (!annotation.tags || annotation.tags.length === 0) {
    return c.json({ error: "tags are required" }, 400);
  }

  const targetPromptId = annotation.promptId || getActivePopulation(projectId)[0]?.id;
  if (!targetPromptId) return c.json({ error: "No prompts in population" }, 400);

  try {
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
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    const config = project.config as any;
    const tcs = getTestCases(projectId);

    const logs = db
      .select()
      .from(schema.evolutionLogs)
      .where(eq(schema.evolutionLogs.projectId, projectId))
      .all();
    const generation = logs.length > 0 ? Math.max(...logs.map((l) => l.generation)) + 1 : 1;

    const mutationCount = config.mutationsPerRound || 3;
    const runs = config.evaluationRuns ?? 1;

    // Use the annotated prompt as mutation base (not necessarily the top-ranked one)
    const targetPrompt = db.select().from(schema.prompts)
      .where(eq(schema.prompts.id, targetPromptId)).get()!;

    // Generate mutations sequentially (each sees previous variants to stay diverse).
    // Insert as inactive until they pass the qualification check.
    const mutatedContents: { id: string; content: string }[] = [];
    for (let i = 0; i < mutationCount; i++) {
      const content = await mutate({
        originalPrompt: targetPrompt.content,
        optimizationInstructions: instructions,
        strategy: "targeted",
        existingVariants: mutatedContents.map((v) => v.content),
      });
      const id = addPrompt(projectId, content, generation, targetPrompt.id, "targeted", false);
      mutatedContents.push({ id, content });
    }

    // Evaluate all new variants in parallel
    const evalMap = await evaluateBatch(mutatedContents, tcs, runs);
    const newVariants: { id: string; content: string; score: number }[] = [];

    for (const { id, content } of mutatedContents) {
      const { results: evalResults, avgScore } = evalMap.get(id)!;
      updateScore(id, avgScore);
      saveEvaluations(id, evalResults);

      // Qualify against the existing population (new variants are still inactive here)
      if (canJoinPopulation(projectId, avgScore, config.topNThreshold || 3)) {
        db.update(schema.prompts).set({ isActive: true }).where(eq(schema.prompts.id, id)).run();
      }
      newVariants.push({ id, content, score: avgScore });
    }

    const eliminated = enforcePopulationLimit(projectId, config.populationSize || 6);
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
  } catch (err: any) {
    console.error("Evolve error:", err);
    return c.json({ error: err.message || "Internal error" }, 500);
  }
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
    .where(and(eq(schema.testCases.projectId, projectId), eq(schema.testCases.isActive, true)))
    .all()
    .map((tc) => ({
      id: tc.id,
      input: tc.input,
      expectedOutput: tc.expectedOutput,
      scoringCriteria: tc.scoringCriteria,
      difficulty: tc.difficulty,
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

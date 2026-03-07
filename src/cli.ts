import { createInterface } from "readline";
import { v4 as uuid } from "uuid";
import { db, schema } from "./lib/db/index.js";
import { eq, and } from "drizzle-orm";
import { mutate, getInitialStrategies } from "./lib/engine/mutator.js";
import { evaluate, computeWeightedAvgScore, type TestCase } from "./lib/engine/evaluator.js";
import { tagsToInstructions, getAllTags, type AnnotationData } from "./lib/engine/feedback.js";
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

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((r) => rl.question(q, (a) => r(a.trim())));

const askMultiline = async (prompt: string): Promise<string> => {
  console.log(prompt);
  console.log('(Enter content, then type "END" on a new line to finish)');
  const lines: string[] = [];
  while (true) {
    const line = await ask("");
    if (line === "END") break;
    lines.push(line);
  }
  return lines.join("\n");
};

function printSeparator(title?: string) {
  if (title) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${title}`);
    console.log(`${"=".repeat(60)}`);
  } else {
    console.log("-".repeat(60));
  }
}

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

async function createProject(): Promise<string> {
  printSeparator("Create New Project");
  const name = await ask("Project name: ");

  const config = {
    populationSize: 6,
    mutationsPerRound: 3,
    topNThreshold: 3,
    evaluationRuns: 1,
  };

  const sizeStr = await ask(`Population size [${config.populationSize}]: `);
  if (sizeStr) config.populationSize = parseInt(sizeStr) || config.populationSize;

  const mutStr = await ask(`Mutations per round [${config.mutationsPerRound}]: `);
  if (mutStr) config.mutationsPerRound = parseInt(mutStr) || config.mutationsPerRound;

  const id = uuid();
  db.insert(schema.projects)
    .values({ id, name, config, createdAt: new Date() })
    .run();

  console.log(`\nProject created: ${name} (${id})`);
  return id;
}

async function addTestCases(projectId: string): Promise<void> {
  printSeparator("Add Test Cases");
  console.log("Add test cases for evaluation. Enter empty input to stop.\n");

  let count = 0;
  while (true) {
    const input = await askMultiline(`\nTest case ${count + 1} - Input:`);
    if (!input) break;

    const expectedOutput = await askMultiline("Expected output:");
    const scoringCriteria = await askMultiline("Scoring criteria:");

    db.insert(schema.testCases)
      .values({
        id: uuid(),
        projectId,
        input,
        expectedOutput,
        scoringCriteria,
        difficulty: "medium",
        isActive: true,
      })
      .run();
    count++;
    console.log(`  Test case ${count} added.`);
  }

  console.log(`\nTotal test cases: ${count}`);
}

async function initialize(projectId: string): Promise<void> {
  printSeparator("Round 0: Initialization");

  const originalPrompt = await askMultiline("\nEnter the original prompt:");

  // Add original to population
  const originalId = addPrompt(projectId, originalPrompt, 0, null, "original");
  console.log("\nOriginal prompt added to population.");

  // Add test cases
  await addTestCases(projectId);

  const tcs = getTestCases(projectId);
  if (tcs.length === 0) {
    console.log("No test cases added. Cannot proceed with evaluation.");
    return;
  }

  // Generate initial mutations
  const strategies = getInitialStrategies();
  const variants: { id: string; content: string; strategy: string }[] = [];

  console.log("\nGenerating initial variants...");
  for (const strategy of strategies) {
    process.stdout.write(`  Mutating (${strategy})...`);
    const content = await mutate({
      originalPrompt,
      strategy,
      existingVariants: variants.map((v) => v.content),
    });
    const id = addPrompt(projectId, content, 0, originalId, strategy);
    variants.push({ id, content, strategy });
    console.log(" done");
  }

  // Evaluate all prompts
  const allPrompts = [
    { id: originalId, content: originalPrompt, label: "Original" },
    ...variants.map((v) => ({ id: v.id, content: v.content, label: v.strategy })),
  ];

  console.log("\nEvaluating all prompts...");
  for (const p of allPrompts) {
    process.stdout.write(`  Evaluating ${p.label}...`);
    const results = await evaluate(p.content, tcs);
    const avgScore = computeWeightedAvgScore(results, tcs);
    updateScore(p.id, avgScore);
    saveEvaluations(p.id, results);
    console.log(` score: ${avgScore.toFixed(2)}`);
  }

  // Mark top scorer as elite
  const population = getActivePopulation(projectId);
  if (population.length > 0 && population[0].score !== null) {
    markElite(population[0].id);
  }

  logEvolution(projectId, 0, "initialization", {
    promptCount: allPrompts.length,
    testCaseCount: tcs.length,
  });

  showLeaderboard(projectId);
}

function showLeaderboard(projectId: string) {
  const population = getActivePopulation(projectId);
  const stats = getEvolutionStats(projectId);

  printSeparator("Leaderboard");
  console.log(
    `Population: ${stats.populationSize} | Elites: ${stats.eliteCount} | Top: ${stats.topScore?.toFixed(2) ?? "N/A"} | Avg: ${stats.avgScore?.toFixed(2) ?? "N/A"}\n`
  );

  for (let i = 0; i < population.length; i++) {
    const p = population[i];
    const elite = p.isElite ? " [ELITE]" : "";
    const scoreStr = p.score !== null ? p.score.toFixed(2) : "N/A";
    console.log(`  #${i + 1} | Score: ${scoreStr} | Gen ${p.generation} | ${p.strategy ?? "original"}${elite}`);
    console.log(`       ${p.content.slice(0, 100).replace(/\n/g, " ")}...`);
    console.log();
  }
}

function showPromptDetail(projectId: string, rank: number) {
  const population = getActivePopulation(projectId);
  if (rank < 1 || rank > population.length) {
    console.log("Invalid rank.");
    return;
  }
  const p = population[rank - 1];
  printSeparator(`Prompt #${rank} Detail`);
  console.log(`ID: ${p.id}`);
  console.log(`Strategy: ${p.strategy ?? "original"}`);
  console.log(`Generation: ${p.generation}`);
  console.log(`Score: ${p.score?.toFixed(2) ?? "N/A"}`);
  console.log(`Elite: ${p.isElite}`);
  console.log(`\n--- Content ---\n${p.content}\n`);

  // Show evaluations
  const evals = db
    .select()
    .from(schema.evaluations)
    .where(eq(schema.evaluations.promptId, p.id))
    .all();

  if (evals.length > 0) {
    console.log("--- Evaluation Results ---");
    for (const e of evals) {
      const ds = e.dimensionScores as any;
      console.log(`  Case ${e.testCaseId.slice(0, 8)}: score=${e.score.toFixed(2)} acc=${ds?.accuracy} fmt=${ds?.format} con=${ds?.consistency} edge=${ds?.edgeCases}`);
      console.log(`  Output: ${e.output.slice(0, 150).replace(/\n/g, " ")}...`);
      console.log();
    }
  }
}

async function annotatePrompt(projectId: string): Promise<AnnotationData | null> {
  const population = getActivePopulation(projectId);
  if (population.length === 0) {
    console.log("No prompts in population.");
    return null;
  }

  showLeaderboard(projectId);

  const rankStr = await ask("\nWhich prompt to annotate? (rank number, or 'd N' to view detail): ");
  if (rankStr.startsWith("d ")) {
    showPromptDetail(projectId, parseInt(rankStr.slice(2)));
    return annotatePrompt(projectId);
  }

  const rank = parseInt(rankStr);
  if (isNaN(rank) || rank < 1 || rank > population.length) {
    console.log("Invalid rank.");
    return null;
  }

  const prompt = population[rank - 1];
  showPromptDetail(projectId, rank);

  // Show tag categories
  const categories = getAllTags();
  console.log("\n--- Select Problem Tags ---");
  const allTags: string[] = [];
  for (const cat of categories) {
    console.log(`\n[${cat.category}]`);
    for (const tag of cat.tags) {
      allTags.push(tag);
      console.log(`  ${allTags.length}. ${tag}`);
    }
  }

  const tagInput = await ask("\nSelect tags (comma-separated numbers): ");
  const selectedIndices = tagInput
    .split(",")
    .map((s) => parseInt(s.trim()))
    .filter((n) => !isNaN(n) && n >= 1 && n <= allTags.length);
  const selectedTags = selectedIndices.map((i) => allTags[i - 1]);

  if (selectedTags.length === 0) {
    console.log("No tags selected.");
    return null;
  }

  const note = await ask("Optional note (press Enter to skip): ");

  const annotation: AnnotationData = {
    tags: selectedTags,
    note: note || undefined,
  };

  // Save to DB
  db.insert(schema.annotations)
    .values({
      id: uuid(),
      promptId: prompt.id,
      tags: selectedTags,
      note: note || null,
      testCaseId: null,
      createdAt: new Date(),
    })
    .run();

  console.log(`\nAnnotation saved: [${selectedTags.join(", ")}]`);
  return annotation;
}

async function evolve(projectId: string, generation: number): Promise<void> {
  printSeparator(`Round ${generation}: Evolution`);

  // Get annotation from human
  const annotation = await annotatePrompt(projectId);
  if (!annotation) {
    console.log("No annotation provided. Skipping evolution round.");
    return;
  }

  const instructions = tagsToInstructions(annotation);
  console.log("\nOptimization instructions:");
  console.log(instructions);

  const population = getActivePopulation(projectId);
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  const config = project!.config as any;
  const tcs = getTestCases(projectId);

  // Use top prompt as base for mutation
  const basePrompt = population[0];
  const mutationCount = config.mutationsPerRound || 3;

  console.log(`\nGenerating ${mutationCount} new variants from top prompt...`);
  const newVariants: { id: string; content: string }[] = [];

  for (let i = 0; i < mutationCount; i++) {
    process.stdout.write(`  Variant ${i + 1}/${mutationCount}...`);
    const content = await mutate({
      originalPrompt: basePrompt.content,
      optimizationInstructions: instructions,
      strategy: "targeted",
      existingVariants: newVariants.map((v) => v.content),
    });
    const id = addPrompt(projectId, content, generation, basePrompt.id, "targeted");
    newVariants.push({ id, content });
    console.log(" done");
  }

  // Evaluate new variants
  console.log("\nEvaluating new variants...");
  let joinedCount = 0;
  for (const v of newVariants) {
    process.stdout.write(`  Evaluating...`);
    const results = await evaluate(v.content, tcs);
    const score = computeWeightedAvgScore(results, tcs);
    updateScore(v.id, score);
    saveEvaluations(v.id, results);
    console.log(` score: ${score.toFixed(2)}`);

    // Check if it qualifies
    if (!canJoinPopulation(projectId, score, config.topNThreshold || 3)) {
      console.log(`    -> Below Top-${config.topNThreshold || 3} threshold. Deactivated.`);
      db.update(schema.prompts).set({ isActive: false }).where(eq(schema.prompts.id, v.id)).run();
    } else {
      joinedCount++;
      console.log(`    -> Qualified for population!`);
    }
  }

  // Enforce population limit
  const eliminated = enforcePopulationLimit(projectId, config.populationSize || 6);
  if (eliminated.length > 0) {
    console.log(`\n${eliminated.length} prompt(s) eliminated from population.`);
  }

  // Update elite
  const updatedPop = getActivePopulation(projectId);
  if (updatedPop.length > 0 && updatedPop[0].score !== null) {
    markElite(updatedPop[0].id);
  }

  logEvolution(projectId, generation, "evolution", {
    annotationTags: annotation.tags,
    newVariants: newVariants.length,
    joined: joinedCount,
    eliminated: eliminated.length,
  });

  // Check stop conditions
  checkStopConditions(projectId, generation);

  showLeaderboard(projectId);
}

function checkStopConditions(projectId: string, currentGen: number) {
  const logs = db
    .select()
    .from(schema.evolutionLogs)
    .where(eq(schema.evolutionLogs.projectId, projectId))
    .all()
    .filter((l) => l.eventType === "evolution")
    .sort((a, b) => b.generation - a.generation);

  // Check: 3 consecutive rounds with no new qualifiers
  if (logs.length >= 3) {
    const recent3 = logs.slice(0, 3);
    const noProgress = recent3.every((l) => {
      const detail = l.detail as any;
      return detail?.joined === 0;
    });
    if (noProgress) {
      console.log("\n*** STOP SIGNAL: 3 consecutive rounds with no new qualifiers. Consider stopping. ***");
    }
  }

  // Check: score plateau
  if (logs.length >= 5) {
    const recent5 = logs.slice(0, 5);
    const gens = recent5.map((l) => l.generation);
    const populations = gens.map((g) => {
      const pop = getActivePopulation(projectId);
      return pop.length > 0 ? pop[0].score ?? 0 : 0;
    });
    const maxDiff = Math.max(...populations) - Math.min(...populations);
    if (maxDiff < 2) {
      console.log("\n*** STOP SIGNAL: Score plateau detected (< 2% variation in last 5 rounds). ***");
    }
  }
}

function showEvolutionHistory(projectId: string) {
  printSeparator("Evolution History");
  const logs = db
    .select()
    .from(schema.evolutionLogs)
    .where(eq(schema.evolutionLogs.projectId, projectId))
    .all()
    .sort((a, b) => a.generation - b.generation);

  if (logs.length === 0) {
    console.log("No evolution history yet.");
    return;
  }

  for (const log of logs) {
    const detail = log.detail as any;
    const time = new Date(log.createdAt).toLocaleTimeString();
    console.log(`  Gen ${log.generation} | ${log.eventType} | ${time}`);
    if (detail) {
      console.log(`    ${JSON.stringify(detail)}`);
    }
  }
}

function exportBestPrompt(projectId: string) {
  const population = getActivePopulation(projectId);
  if (population.length === 0) {
    console.log("No prompts available.");
    return;
  }
  printSeparator("Best Prompt");
  console.log(population[0].content);
  printSeparator();
  console.log(`Score: ${population[0].score?.toFixed(2)} | Strategy: ${population[0].strategy} | Gen: ${population[0].generation}`);
}

async function main() {
  printSeparator("Prompt Evolution System");
  console.log("Commands:");
  console.log("  1. new     - Create new project and initialize");
  console.log("  2. evolve  - Run evolution round");
  console.log("  3. board   - Show leaderboard");
  console.log("  4. detail  - Show prompt detail");
  console.log("  5. history - Show evolution history");
  console.log("  6. export  - Export best prompt");
  console.log("  7. quit    - Exit");

  // List existing projects
  const existingProjects = db.select().from(schema.projects).all();
  let projectId: string | null = null;

  if (existingProjects.length > 0) {
    console.log("\nExisting projects:");
    for (let i = 0; i < existingProjects.length; i++) {
      const p = existingProjects[i];
      const stats = getEvolutionStats(p.id);
      console.log(
        `  ${i + 1}. ${p.name} | Top: ${stats.topScore?.toFixed(2) ?? "N/A"} | Pop: ${stats.populationSize}`
      );
    }
    const choice = await ask("\nSelect project number (or 'new'): ");
    if (choice !== "new") {
      const idx = parseInt(choice) - 1;
      if (idx >= 0 && idx < existingProjects.length) {
        projectId = existingProjects[idx].id;
        console.log(`\nLoaded project: ${existingProjects[idx].name}`);
      }
    }
  }

  if (!projectId) {
    projectId = await createProject();
    await initialize(projectId);
  }

  // Get current generation
  const logs = db
    .select()
    .from(schema.evolutionLogs)
    .where(eq(schema.evolutionLogs.projectId, projectId))
    .all();
  let generation = logs.length > 0 ? Math.max(...logs.map((l) => l.generation)) + 1 : 1;

  // Main loop
  while (true) {
    const cmd = await ask("\n> ");
    switch (cmd.toLowerCase()) {
      case "evolve":
      case "2":
        await evolve(projectId, generation);
        generation++;
        break;
      case "board":
      case "3":
        showLeaderboard(projectId);
        break;
      case "detail":
      case "4": {
        const rank = parseInt(await ask("Rank number: "));
        showPromptDetail(projectId, rank);
        break;
      }
      case "history":
      case "5":
        showEvolutionHistory(projectId);
        break;
      case "export":
      case "6":
        exportBestPrompt(projectId);
        break;
      case "quit":
      case "7":
      case "q":
        console.log("Goodbye.");
        rl.close();
        process.exit(0);
      default:
        console.log("Unknown command. Type: evolve, board, detail, history, export, quit");
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

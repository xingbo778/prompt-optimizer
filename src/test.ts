/**
 * Non-interactive test: verifies DB operations, population management, and feedback processing.
 * Does NOT require ANTHROPIC_API_KEY (skips AI calls).
 */
import { db, schema } from "./lib/db/index.js";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  addPrompt,
  updateScore,
  getActivePopulation,
  enforcePopulationLimit,
  canJoinPopulation,
  markElite,
  logEvolution,
  getEvolutionStats,
  saveEvaluations,
} from "./lib/engine/population.js";
import { tagsToInstructions, getAllTags } from "./lib/engine/feedback.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

// Clean up test data first
const TEST_PROJECT_ID = "test-" + uuid().slice(0, 8);

console.log("=== Test Suite: Prompt Evolution System ===\n");

// --- Test 1: Project creation ---
console.log("--- Test: Project CRUD ---");
db.insert(schema.projects).values({
  id: TEST_PROJECT_ID,
  name: "Test Project",
  config: { populationSize: 4, mutationsPerRound: 2, topNThreshold: 3, evaluationRuns: 1 },
  createdAt: new Date(),
}).run();

const project = db.select().from(schema.projects).where(eq(schema.projects.id, TEST_PROJECT_ID)).get();
assert(project !== undefined, "Project created");
assert(project!.name === "Test Project", "Project name correct");
const config = project!.config as any;
assert(config.populationSize === 4, "Config stored correctly");

// --- Test 2: Add prompts ---
console.log("\n--- Test: Prompt Management ---");
const p1 = addPrompt(TEST_PROJECT_ID, "You are a helpful assistant.", 0, null, "original");
const p2 = addPrompt(TEST_PROJECT_ID, "You are a concise assistant. Be direct.", 0, p1, "simplify");
const p3 = addPrompt(TEST_PROJECT_ID, "You are a helpful assistant.\n\nExample:\nQ: Hello\nA: Hi!", 0, p1, "add_examples");
const p4 = addPrompt(TEST_PROJECT_ID, "# Role\nYou are an expert assistant.\n\n# Output Format\nUse bullet points.", 0, p1, "restructure");

const pop = getActivePopulation(TEST_PROJECT_ID);
assert(pop.length === 4, `Population has 4 prompts (got ${pop.length})`);

// --- Test 3: Scoring ---
console.log("\n--- Test: Scoring & Ranking ---");
updateScore(p1, 65.5);
updateScore(p2, 78.3);
updateScore(p3, 72.1);
updateScore(p4, 81.0);

const ranked = getActivePopulation(TEST_PROJECT_ID);
assert(ranked[0].id === p4, "Highest score ranks first");
assert(ranked[0].score === 81.0, "Score is correct (81.0)");
assert(ranked[ranked.length - 1].id === p1, "Lowest score ranks last");

// --- Test 4: Elite marking ---
console.log("\n--- Test: Elite System ---");
markElite(p4);
const elitePrompt = getActivePopulation(TEST_PROJECT_ID).find(p => p.id === p4);
assert(elitePrompt!.isElite === true, "Prompt marked as elite");

// --- Test 5: Population threshold ---
console.log("\n--- Test: Population Threshold ---");
assert(canJoinPopulation(TEST_PROJECT_ID, 85.0, 3) === true, "Score 85 can join Top-3 (above 72.1)");
assert(canJoinPopulation(TEST_PROJECT_ID, 70.0, 3) === false, "Score 70 cannot join Top-3 (below 72.1)");
assert(canJoinPopulation(TEST_PROJECT_ID, 72.1, 3) === true, "Score 72.1 can join Top-3 (equal to threshold)");

// --- Test 6: Population limit enforcement ---
console.log("\n--- Test: Population Limit ---");
const p5 = addPrompt(TEST_PROJECT_ID, "Extra prompt 1", 1, p4, "targeted");
updateScore(p5, 83.0);
const p6 = addPrompt(TEST_PROJECT_ID, "Extra prompt 2", 1, p4, "targeted");
updateScore(p6, 60.0);

// Now we have 6 prompts, limit is 4
const eliminated = enforcePopulationLimit(TEST_PROJECT_ID, 4);
assert(eliminated.length === 2, `2 prompts eliminated (got ${eliminated.length})`);

const popAfter = getActivePopulation(TEST_PROJECT_ID);
assert(popAfter.length === 4, `Population reduced to 4 (got ${popAfter.length})`);
assert(popAfter.every(p => p.score! >= 72.1), "All remaining have score >= 72.1");

// Verify elite survived
assert(popAfter.some(p => p.id === p4 && p.isElite), "Elite prompt survived culling");

// --- Test 7: Evaluation storage ---
console.log("\n--- Test: Evaluation Storage ---");
const testCaseId = uuid();
db.insert(schema.testCases).values({
  id: testCaseId,
  projectId: TEST_PROJECT_ID,
  input: "Tell me a joke",
  expectedOutput: "A funny joke",
  scoringCriteria: "Must be funny and appropriate",
}).run();

saveEvaluations(p5, [{
  testCaseId,
  output: "Why did the chicken cross the road?",
  score: 75.0,
  dimensionScores: { accuracy: 70, format: 80, consistency: 75, edgeCases: 75 },
}]);

const evals = db.select().from(schema.evaluations).where(eq(schema.evaluations.promptId, p5)).all();
assert(evals.length === 1, "Evaluation saved");
assert(evals[0].score === 75.0, "Evaluation score correct");

// --- Test 8: Feedback processing ---
console.log("\n--- Test: Feedback Processing ---");
const instructions = tagsToInstructions({
  tags: ["指令模糊", "废话太多"],
  note: "Outputs are too wordy for API use",
});
assert(instructions.includes("指令模糊"), "Tag '指令模糊' mapped to instruction");
assert(instructions.includes("废话太多"), "Tag '废话太多' mapped to instruction");
assert(instructions.includes("Outputs are too wordy"), "Human note included");

const allTags = getAllTags();
assert(allTags.length === 4, "4 tag categories");
const totalTags = allTags.reduce((s, c) => s + c.tags.length, 0);
assert(totalTags === 13, `13 total tags (got ${totalTags})`);

// --- Test 9: Evolution logging ---
console.log("\n--- Test: Evolution Logging ---");
logEvolution(TEST_PROJECT_ID, 0, "initialization", { promptCount: 4, testCaseCount: 1 });
logEvolution(TEST_PROJECT_ID, 1, "evolution", { joined: 1, eliminated: 2 });

const logs = db.select().from(schema.evolutionLogs).where(eq(schema.evolutionLogs.projectId, TEST_PROJECT_ID)).all();
assert(logs.length === 2, "2 evolution logs recorded");

// --- Test 10: Stats ---
console.log("\n--- Test: Evolution Stats ---");
const stats = getEvolutionStats(TEST_PROJECT_ID);
assert(stats.populationSize === 4, `Population size: 4 (got ${stats.populationSize})`);
assert(stats.eliteCount === 1, `Elite count: 1 (got ${stats.eliteCount})`);
assert(stats.topScore === 83.0, `Top score: 83.0 (got ${stats.topScore})`);
assert(stats.minScore !== null && stats.minScore >= 72, `Min score >= 72 (got ${stats.minScore})`);

// --- Cleanup ---
console.log("\n--- Cleanup ---");
db.delete(schema.evaluations).run();
db.delete(schema.annotations).run();
db.delete(schema.evolutionLogs).run();
db.delete(schema.prompts).where(eq(schema.prompts.projectId, TEST_PROJECT_ID)).run();
db.delete(schema.testCases).where(eq(schema.testCases.projectId, TEST_PROJECT_ID)).run();
db.delete(schema.projects).where(eq(schema.projects.id, TEST_PROJECT_ID)).run();
console.log("  Test data cleaned up.");

// --- Summary ---
console.log(`\n${"=".repeat(40)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}`);
process.exit(failed > 0 ? 1 : 0);

import { chat } from "../ai/client.js";

export interface TestCase {
  id: string;
  input: string;
  expectedOutput: string;
  scoringCriteria: string;
  difficulty?: string;
}

const DIFFICULTY_WEIGHTS: Record<string, number> = {
  easy: 0.5,
  medium: 1.0,
  hard: 1.5,
};

export function computeWeightedAvgScore(results: EvaluationResult[], testCases: TestCase[]): number {
  const tcMap = new Map(testCases.map((tc) => [tc.id, tc]));
  let weightedSum = 0;
  let totalWeight = 0;
  for (const r of results) {
    const weight = DIFFICULTY_WEIGHTS[tcMap.get(r.testCaseId)?.difficulty ?? "medium"] ?? 1.0;
    weightedSum += r.score * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : Math.round((weightedSum / totalWeight) * 100) / 100;
}

export interface EvaluationResult {
  testCaseId: string;
  output: string;
  score: number;
  dimensionScores: {
    accuracy: number;
    format: number;
    consistency: number;
    edgeCases: number;
  };
}

// Concurrency limiter
async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  const executing = new Set<Promise<void>>();

  for (const task of tasks) {
    const p = task().then((r) => { results.push(r); }).catch((e) => { throw e; });
    const tracked = p.finally(() => executing.delete(tracked));
    executing.add(tracked);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
}

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "4");

export async function runPrompt(prompt: string, input: string): Promise<string> {
  const result = await chat(prompt, input, { temperature: 0.3, role: "generate" });
  return result;
}

export async function judgeOutput(
  testCase: TestCase,
  actualOutput: string
): Promise<{ score: number; dimensionScores: EvaluationResult["dimensionScores"] }> {
  const systemPrompt = `You are a strict, adversarial judge evaluating AI-generated outputs. Your job is to find flaws, not to be generous.

Score on a 0-100 scale across these dimensions. Use the FULL range — a score of 90+ means near-perfect with no meaningful issues.

Scoring guidelines:
- 90-100: Exceptional. Fully meets all criteria with no issues.
- 70-89: Good but has noticeable gaps, minor errors, or missing details.
- 50-69: Mediocre. Partially meets criteria but has significant issues.
- 30-49: Poor. Major problems, misses key requirements.
- 0-29: Failing. Fundamentally wrong or off-topic.

Dimensions:
1. accuracy: Does the output match the expected output in substance and intent? Penalize missing information, wrong details, hallucinated content.
2. format: Does it follow the EXACT required format? Penalize wrong structure, missing sections, inconsistent formatting.
3. consistency: Is it internally consistent? Penalize contradictions, repeated content, logical gaps.
4. edgeCases: Does it handle edge cases, ambiguity, and tricky aspects? Penalize ignoring stated constraints.

Be specific in your reasoning. Then respond with ONLY this JSON (no markdown):
{"accuracy": <0-100>, "format": <0-100>, "consistency": <0-100>, "edgeCases": <0-100>}`;

  const userMessage = `## Scoring Criteria
${testCase.scoringCriteria}

## Input
${testCase.input}

## Expected Output
${testCase.expectedOutput}

## Actual Output
${actualOutput}`;

  const response = await chat(systemPrompt, userMessage, { temperature: 0.1, role: "judge" });

  try {
    const jsonMatch = response.match(/\{[^{}]*"accuracy"\s*:\s*\d+[^{}]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : response.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    const scores = JSON.parse(jsonStr);
    const dimensionScores = {
      accuracy: clamp(scores.accuracy),
      format: clamp(scores.format),
      consistency: clamp(scores.consistency),
      edgeCases: clamp(scores.edgeCases),
    };
    const overall =
      dimensionScores.accuracy * 0.4 +
      dimensionScores.format * 0.2 +
      dimensionScores.consistency * 0.2 +
      dimensionScores.edgeCases * 0.2;
    return { score: Math.round(overall * 100) / 100, dimensionScores };
  } catch {
    console.error("Failed to parse judge response:", response);
    return {
      score: 50,
      dimensionScores: { accuracy: 50, format: 50, consistency: 50, edgeCases: 50 },
    };
  }
}

// Evaluate a single prompt against one test case
async function evaluateOne(prompt: string, tc: TestCase): Promise<EvaluationResult> {
  const output = await runPrompt(prompt, tc.input);
  const { score, dimensionScores } = await judgeOutput(tc, output);
  return { testCaseId: tc.id, output, score, dimensionScores };
}

// Evaluate a single prompt against all test cases (parallel with concurrency limit)
export async function evaluate(
  prompt: string,
  testCases: TestCase[]
): Promise<EvaluationResult[]> {
  const tasks = testCases.map((tc) => () => evaluateOne(prompt, tc));
  return withConcurrency(tasks, MAX_CONCURRENT);
}

// Evaluate multiple prompts sequentially (to avoid rate limits), test cases parallel within each.
// runs > 1: each prompt is evaluated N times and scores are averaged to reduce LLM variance.
export async function evaluateBatch(
  prompts: { id: string; content: string }[],
  testCases: TestCase[],
  runs = 1
): Promise<Map<string, { results: EvaluationResult[]; avgScore: number }>> {
  const map = new Map<string, { results: EvaluationResult[]; avgScore: number }>();

  for (const p of prompts) {
    let results: EvaluationResult[];

    if (runs <= 1) {
      results = await evaluate(p.content, testCases);
    } else {
      // Run N times sequentially, average scores per test case
      const allRuns: EvaluationResult[][] = [];
      for (let i = 0; i < runs; i++) {
        allRuns.push(await evaluate(p.content, testCases));
      }
      results = testCases.map((tc, i) => {
        const tcRuns = allRuns.map((run) => run[i]);
        const avgScore = Math.round((tcRuns.reduce((s, r) => s + r.score, 0) / runs) * 100) / 100;
        const avgDim = (key: keyof EvaluationResult["dimensionScores"]) =>
          Math.round((tcRuns.reduce((s, r) => s + r.dimensionScores[key], 0) / runs) * 100) / 100;
        return {
          testCaseId: tc.id,
          output: tcRuns[0].output,
          score: avgScore,
          dimensionScores: {
            accuracy: avgDim("accuracy"),
            format: avgDim("format"),
            consistency: avgDim("consistency"),
            edgeCases: avgDim("edgeCases"),
          },
        };
      });
    }

    const avgScore = computeWeightedAvgScore(results, testCases);
    map.set(p.id, { results, avgScore });
    console.log(`  Evaluated ${p.id.slice(0, 8)}: ${avgScore}`);
  }

  return map;
}

function clamp(v: unknown): number {
  const n = Number(v);
  if (isNaN(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

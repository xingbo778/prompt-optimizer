import { chat } from "../ai/client.js";

export interface TestCase {
  id: string;
  input: string;
  expectedOutput: string;
  scoringCriteria: string;
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

export async function runPrompt(prompt: string, input: string): Promise<string> {
  const result = await chat(prompt, input, { temperature: 0.3 });
  return result;
}

export async function judgeOutput(
  testCase: TestCase,
  actualOutput: string
): Promise<{ score: number; dimensionScores: EvaluationResult["dimensionScores"] }> {
  const systemPrompt = `You are an impartial judge evaluating AI-generated outputs. Score the output on a 0-100 scale across these dimensions:

1. accuracy: How well does the output match the expected output and intent?
2. format: Does the output follow the required format?
3. consistency: Is the output internally consistent and well-structured?
4. edgeCases: Does it handle edge cases or tricky aspects of the input well?

Respond ONLY in this exact JSON format (no markdown):
{"accuracy": <0-100>, "format": <0-100>, "consistency": <0-100>, "edgeCases": <0-100>}`;

  const userMessage = `## Scoring Criteria
${testCase.scoringCriteria}

## Input
${testCase.input}

## Expected Output
${testCase.expectedOutput}

## Actual Output
${actualOutput}`;

  const response = await chat(systemPrompt, userMessage, { temperature: 0.1 });

  try {
    const cleaned = response.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    const scores = JSON.parse(cleaned);
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

export async function evaluate(
  prompt: string,
  testCases: TestCase[]
): Promise<EvaluationResult[]> {
  const results: EvaluationResult[] = [];

  for (const tc of testCases) {
    const output = await runPrompt(prompt, tc.input);
    const { score, dimensionScores } = await judgeOutput(tc, output);
    results.push({
      testCaseId: tc.id,
      output,
      score,
      dimensionScores,
    });
  }

  return results;
}

function clamp(v: unknown): number {
  const n = Number(v);
  if (isNaN(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

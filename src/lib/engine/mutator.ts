import { chat } from "../ai/client.js";

export interface MutationInput {
  originalPrompt: string;
  optimizationInstructions?: string;
  strategy: string;
  existingVariants?: string[];
}

const MUTATION_STRATEGIES: Record<string, string> = {
  simplify: "Simplify and clarify the prompt. Remove ambiguity, reduce verbosity, make instructions crisp and direct.",
  add_examples: "Add 2-3 high-quality few-shot examples that demonstrate the desired input-output pattern.",
  restructure: "Restructure the prompt: improve role definition, add output format constraints, reorganize instruction flow.",
  targeted: "Apply specific targeted improvements based on the feedback provided.",
};

export async function mutate(input: MutationInput): Promise<string> {
  const strategyDesc = MUTATION_STRATEGIES[input.strategy] || MUTATION_STRATEGIES.targeted;

  const existingNote = input.existingVariants?.length
    ? `\n\nExisting variants (generate something DIFFERENT from these):\n${input.existingVariants.map((v, i) => `--- Variant ${i + 1} ---\n${v}`).join("\n\n")}`
    : "";

  const feedbackNote = input.optimizationInstructions
    ? `\n\nHuman feedback to address:\n${input.optimizationInstructions}`
    : "";

  const systemPrompt = `You are a prompt engineering expert. Your job is to create an improved version of a given prompt.

Strategy for this mutation: ${strategyDesc}
${feedbackNote}
${existingNote}

Rules:
- Output ONLY the improved prompt, nothing else
- Do not wrap in markdown code blocks
- Do not add meta-commentary
- The improved prompt must serve the same purpose as the original
- Make meaningful changes, not cosmetic ones`;

  const result = await chat(systemPrompt, `Original prompt:\n\n${input.originalPrompt}`, {
    temperature: 0.8,
  });

  return result.trim();
}

export function getInitialStrategies(): string[] {
  return ["simplify", "add_examples", "restructure"];
}

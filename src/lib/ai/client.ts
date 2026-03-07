import OpenAI from "openai";

const DEFAULT_MODEL = "gemini-2.5-flash-preview-05-20";

let client: OpenAI | null = null;

export function getClient(): OpenAI {
  if (!client) {
    const baseURL = process.env.LLM_BASE_URL;
    const apiKey = process.env.LLM_API_KEY;
    if (!baseURL || !apiKey) {
      throw new Error("LLM_BASE_URL and LLM_API_KEY must be set");
    }
    client = new OpenAI({ baseURL, apiKey });
  }
  return client;
}

export async function chat(
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; temperature?: number; role?: "generate" | "judge" }
): Promise<string> {
  const model = options?.role === "judge"
    ? (process.env.JUDGE_MODEL || process.env.LLM_MODEL || DEFAULT_MODEL)
    : (process.env.LLM_MODEL || DEFAULT_MODEL);
  const response = await getClient().chat.completions.create({
    model,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.7,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from LLM");
  return content;
}

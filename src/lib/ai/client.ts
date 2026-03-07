const DEFAULT_MODEL = "gemini-2.5-flash-preview-05-20";

function resolveModel(role?: string): string {
  if (role === "judge") return process.env.JUDGE_MODEL || process.env.LLM_MODEL || DEFAULT_MODEL;
  if (role === "mutate") return process.env.MUTATE_MODEL || process.env.LLM_MODEL || DEFAULT_MODEL;
  if (role === "testgen") return process.env.TESTGEN_MODEL || process.env.LLM_MODEL || DEFAULT_MODEL;
  return process.env.LLM_MODEL || DEFAULT_MODEL;
}

export async function chat(
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; temperature?: number; role?: "generate" | "judge" | "mutate" | "testgen" }
): Promise<string> {
  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  if (!baseURL || !apiKey) throw new Error("LLM_BASE_URL and LLM_API_KEY must be set");

  const model = resolveModel(options?.role);

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err?.error?.message || err?.message || `HTTP ${res.status}`);
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from LLM");
  return content;
}

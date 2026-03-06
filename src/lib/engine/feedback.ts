const TAG_TO_INSTRUCTION: Record<string, string> = {
  // Instruction issues
  "指令模糊": "Make instructions more specific and unambiguous. Replace vague terms with precise definitions.",
  "指令矛盾": "Identify and resolve contradictory instructions. Ensure all rules are consistent.",
  "过于复杂": "Simplify the prompt structure. Break complex instructions into clear, sequential steps.",
  "边界条件缺失": "Add explicit handling for edge cases and boundary conditions.",

  // Output issues
  "格式不稳定": "Add stricter output format constraints with explicit templates or schemas.",
  "废话太多": "Add instructions to be concise. Specify maximum length or 'no preamble' rules.",
  "遗漏关键信息": "List required output fields explicitly. Add a checklist the model must follow.",
  "幻觉风险": "Add instructions to only use provided information. Include 'if unsure, say so' guardrails.",

  // Style issues
  "语气不对": "Adjust the tone/persona description. Be more specific about the desired communication style.",
  "角色设定太弱": "Strengthen the role definition with more detailed expertise, background, and behavioral constraints.",
  "示例质量差": "Improve few-shot examples to better demonstrate the desired input-output pattern.",

  // Coverage issues
  "未覆盖某类case": "Broaden the instruction scope to handle more input categories. Add rules for uncovered scenarios.",
  "对异常输入不鲁棒": "Add explicit error handling instructions for malformed, empty, or adversarial inputs.",
};

export interface AnnotationData {
  tags: string[];
  note?: string;
  failedTestCaseId?: string;
}

export function tagsToInstructions(annotation: AnnotationData): string {
  const instructions: string[] = [];

  for (const tag of annotation.tags) {
    const instruction = TAG_TO_INSTRUCTION[tag];
    if (instruction) {
      instructions.push(`- [${tag}] ${instruction}`);
    }
  }

  if (annotation.note) {
    instructions.push(`- [Human note] ${annotation.note}`);
  }

  return instructions.join("\n");
}

export function getAllTags(): { category: string; tags: string[] }[] {
  return [
    { category: "指令问题", tags: ["指令模糊", "指令矛盾", "过于复杂", "边界条件缺失"] },
    { category: "输出问题", tags: ["格式不稳定", "废话太多", "遗漏关键信息", "幻觉风险"] },
    { category: "风格问题", tags: ["语气不对", "角色设定太弱", "示例质量差"] },
    { category: "覆盖问题", tags: ["未覆盖某类case", "对异常输入不鲁棒"] },
  ];
}

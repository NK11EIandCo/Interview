export type InterviewerPersonality =
  | "balanced"
  | "meticulous"
  | "rough"
  | "curious";

export type InterviewerLiteracy = "low" | "medium" | "high";

export type InterviewerDialect = "standard" | "kansai";

export type InterviewDifficulty = "easy" | "hard";

export interface InterviewerSettings {
  personality: InterviewerPersonality;
  literacy: InterviewerLiteracy;
  dialect: InterviewerDialect;
  difficulty: InterviewDifficulty;
  note: string;
}

export const DEFAULT_INTERVIEWER_SETTINGS: InterviewerSettings = {
  personality: "balanced",
  literacy: "medium",
  dialect: "standard",
  difficulty: "easy",
  note: ""
};

const PERSONALITY_INSTRUCTIONS: Record<InterviewerPersonality, string> = {
  balanced:
    "Keep your tone balanced and professional. Do not overplay quirks.",
  meticulous:
    "Be detail-oriented. You often ask for specifics, conditions, and practical examples.",
  rough:
    "Sound a little blunt and rough around the edges, but never rude or insulting.",
  curious:
    "Ask more questions than usual and show active curiosity about details."
};

const LITERACY_INSTRUCTIONS: Record<InterviewerLiteracy, string> = {
  low:
    "Your understanding of foreign hiring is limited. You may need plain explanations and may ask basic or naïve questions about visas, support, or communication.",
  medium:
    "You have ordinary practical understanding of foreign hiring. Stay realistic and businesslike.",
  high:
    "You understand foreign hiring well. Ask sharper and more precise questions when needed, especially about fit, communication, growth, and operational expectations."
};

const DIALECT_INSTRUCTIONS: Record<InterviewerDialect, string> = {
  standard:
    "Speak standard Japanese. Do not use dialectal phrasing.",
  kansai:
    "Use light natural Kansai-flavored Japanese occasionally. Keep it understandable and not exaggerated."
};

const DIFFICULTY_INSTRUCTIONS: Record<InterviewDifficulty, string> = {
  easy:
    "Prioritize a smooth practice flow. Do not ask deep follow-up questions. Avoid off-script questions. If the answer is broadly understandable, move on.",
  hard:
    "Prioritize realism and pressure. When an answer is vague or only partial, press for specifics. Use deeper and more off-script but interview-relevant follow-ups, and do not let ambiguous answers pass too easily."
};

export const sanitizeInterviewerSettings = (
  input?: Partial<InterviewerSettings> | null
): InterviewerSettings => ({
  personality:
    input?.personality === "meticulous" ||
    input?.personality === "rough" ||
    input?.personality === "curious" ||
    input?.personality === "balanced"
      ? input.personality
      : DEFAULT_INTERVIEWER_SETTINGS.personality,
  literacy:
    input?.literacy === "low" ||
    input?.literacy === "medium" ||
    input?.literacy === "high"
      ? input.literacy
      : DEFAULT_INTERVIEWER_SETTINGS.literacy,
  dialect:
    input?.dialect === "standard" || input?.dialect === "kansai"
      ? input.dialect
      : DEFAULT_INTERVIEWER_SETTINGS.dialect,
  difficulty:
    input?.difficulty === "easy" || input?.difficulty === "hard"
      ? input.difficulty
      : input?.difficulty === ("beginner" as InterviewDifficulty | "beginner")
        ? "easy"
      : DEFAULT_INTERVIEWER_SETTINGS.difficulty,
  note: (input?.note ?? "").trim().slice(0, 400)
});

export const buildInterviewerSettingsInstructions = (
  settings: InterviewerSettings
) => {
  const lines = [
    PERSONALITY_INSTRUCTIONS[settings.personality],
    LITERACY_INSTRUCTIONS[settings.literacy],
    DIALECT_INSTRUCTIONS[settings.dialect],
    DIFFICULTY_INSTRUCTIONS[settings.difficulty]
  ];

  if (settings.note) {
    lines.push(
      `Additional scene note from the operator: ${settings.note}`
    );
  }

  return lines.join("\n");
};

import express from "express";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  createPattern2InterviewerConfig,
  createPattern2StudentConfig
} from "./patterns/pattern2.js";
import {
  getIndustryScenario,
  type IndustryFollowUpTopicSpec,
  type InterviewIndustry
} from "./industry.js";
import {
  DEFAULT_INTERVIEWER_SETTINGS,
  sanitizeInterviewerSettings,
  type InterviewDifficulty,
  type InterviewerLiteracy,
  type InterviewerDialect,
  type InterviewerPersonality,
  type InterviewerSettings
} from "./interviewerSettings.js";
import {
  getCandidateLanguageLevelGuidance,
  getCandidateLanguageLevelLabel,
  type CandidateLanguageLevel
} from "./prompts/candidate.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";
const OPENAI_ROUTING_MODEL =
  process.env.OPENAI_ROUTING_MODEL ?? "gpt-4o-mini";
const MIN_TURNS = 20;
const MAX_TURNS = 40;
// Sales-led flow toggle. Set to false to restore the previous AI-to-AI flow.
const SALES_LED_FLOW = true;
const ENABLE_AI_CUT_IN = false;
const ENABLE_CANDIDATE_RESPONSE_VALIDATION = false;

if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is not set.");
  process.exit(1);
}

type AiKey = "ai_a" | "ai_b";
type RelayTarget = AiKey | "none";

type AiProfile = { name: string; voice: string; instructions: string };

interface RealtimeHandlers {
  onReady: () => void;
  onAudioDelta: (audioBase64: string) => void;
  onAudioDone: () => void;
  onTranscriptDelta: (delta: string) => void;
  onTranscriptDone: (transcript: string) => void;
  onInputTranscript: (transcript: string) => void;
  onInputTranscriptDone: (transcript: string) => void;
  onError: (error: Error) => void;
}

const buildSessionUpdate = (profile: AiProfile) => ({
  type: "session.update",
  session: {
    modalities: ["text", "audio"],
    instructions: profile.instructions,
    voice: profile.voice,
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    input_audio_transcription: { model: "whisper-1" },
    turn_detection: null
  }
});

const createRealtimeConnection = (getProfile: () => AiProfile, handlers: RealtimeHandlers) => {
  const ws = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on("open", () => {
    ws.send(JSON.stringify(buildSessionUpdate(getProfile())));
  });

  ws.on("message", (data) => {
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(data.toString());
    } catch {
      handlers.onError(new Error("Failed to parse OpenAI message."));
      return;
    }
    if (event.type && !String(event.type).includes("delta")) {
      console.log("[OpenAI] Event:", event.type);
    }

    if (event.type === "session.updated") {
      handlers.onReady();
      return;
    }

    if (event.type === "response.audio.delta") {
      handlers.onAudioDelta(String(event.delta ?? ""));
      return;
    }

    if (event.type === "response.audio.done") {
      handlers.onAudioDone();
      return;
    }

    if (event.type === "response.audio_transcript.delta") {
      handlers.onTranscriptDelta(String(event.delta ?? ""));
      return;
    }

    if (event.type === "response.audio_transcript.done") {
      handlers.onTranscriptDone(String(event.transcript ?? ""));
      return;
    }

    if (typeof event.type === "string" && event.type.includes("input_audio_transcription")) {
      const transcript =
        typeof event.transcript === "string"
          ? event.transcript
          : typeof event.text === "string"
            ? event.text
            : "";
      if (event.type.includes("delta") && transcript) {
        console.log("[OpenAI] Input transcript delta:", transcript);
        handlers.onInputTranscript(transcript);
        return;
      }
      if (transcript) {
        console.log("[OpenAI] Input transcript done:", transcript);
        handlers.onInputTranscriptDone(transcript);
        return;
      }
      console.log("[OpenAI] Input transcript event without text:", event.type);
    }

    if (event.type === "error") {
      handlers.onError(new Error(JSON.stringify(event)));
    }
  });

  ws.on("error", (error) => {
    handlers.onError(error);
  });

  return ws;
};

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const clientRoot = path.resolve(__dirname, "..", "..", "frontend", "dist");
app.use(express.static(clientRoot));
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

wss.on("connection", (clientSocket) => {
  console.log("[Client] WebSocket connected");
  let sessionReady: Record<AiKey, boolean> = {
    ai_a: false,
    ai_b: false
  };
  let pendingStart = false;
  let autoMode = false;
  let userSpeaking = false;
  // Always use rule-based interruption routing.
  let queuedNextKeys: AiKey[] = [];
  let totalTurns = 0;
  let sessionEnded = false;
  let sessionEndReason: "marker" | "max_turns" | null = null;

  let transcriptBuffers: Record<AiKey, string> = {
    ai_a: "",
    ai_b: ""
  };
  let audioStarted: Record<AiKey, boolean> = {
    ai_a: false,
    ai_b: false
  };
  let audioDone: Record<AiKey, boolean> = {
    ai_a: false,
    ai_b: false
  };
  let transcriptDone: Record<AiKey, boolean> = {
    ai_a: false,
    ai_b: false
  };
  let transcriptSent: Record<AiKey, boolean> = {
    ai_a: false,
    ai_b: false
  };
  let playbackDone: Record<AiKey, boolean> = {
    ai_a: false,
    ai_b: false
  };
  let currentTurn: Record<AiKey, number> = {
    ai_a: 0,
    ai_b: 0
  };
  const logEvent = (key: AiKey, event: string, detail?: string) => {
    const id = currentTurn[key];
    const detailText = detail ? ` ${detail}` : "";
    console.log(`[Turn ${key}:${id}] ${event}${detailText}`);
  };
  let transcriptDeltaQueue: Record<AiKey, string[]> = {
    ai_a: [],
    ai_b: []
  };
  let transcriptFinalText: Record<AiKey, string | null> = {
    ai_a: null,
    ai_b: null
  };
  let lastSalesUtterance = "";
  let lastInterviewerQuestionText = "";
  let lastUserTranscript = "";
  let lastUserTranscriptAt = 0;
  let pendingUserCommitAt = 0;
  let userCommitSeq = 0;
  let currentUserCommitSeq = 0;
  let lastProcessedUserCommitSeq = 0;
  let lastProcessedUserTranscript = "";
  let ignoredLateUserCommitSeq = 0;
  let waitingForUserTranscript = false;
  let userTranscriptTimer: ReturnType<typeof setTimeout> | null = null;
  let liveUserTranscriptBuffer = "";
  let userSpeakingSince = 0;
  let lastAiSpeaker: AiKey | null = null;
  let pendingDeferredUserUtterance: string | null = null;
  let lastScriptHint = "";
  let candidateLanguageLevel: CandidateLanguageLevel = "basic";
  let interviewIndustry: InterviewIndustry = "care";
  let interviewerSettings: InterviewerSettings = {
    ...DEFAULT_INTERVIEWER_SETTINGS
  };
  let expectedCandidateName: string | null = null;
  let confirmedCandidateName: string | null = null;
  let interviewerSelfIntroDone = false;
  let pendingSessionRefresh: Record<AiKey, boolean> = {
    ai_a: false,
    ai_b: false
  };
  let waitingForSessionRefresh = false;
  let interruptPending = false;
  let pendingInterruptTarget: AiKey | null = null;
  let pendingInterruptPrompt: string | null = null;
  let interruptCooldownUntil = 0;
  let waitingForHuman = false;
  let manualAdvanceReady = false;
  type Phase = "pattern1" | "pattern2" | "pattern3";
  let phase: Phase = "pattern1";
  type ScenarioMode = "unified" | "pattern1" | "pattern2" | "pattern3";
  let scenarioMode: ScenarioMode = "unified";
  type CandidateResponseMode =
    | "attendance"
    | "reaction"
    | "fixed_work_intent"
    | "fixed_effort"
    | "self_intro"
    | "good_question"
    | "acknowledge"
    | "answer_question"
    | "clarify"
    | "goodbye";
  type Pattern1Stage =
    | "attendance"
    | "reaction"
    | "work_intent"
    | "effort"
    | "good_question"
    | "complete";
  type IntroPhase =
    | "sales_intro"
    | "company_greeting"
    | "company_ack"
    | "student_intro_permission"
    | "student_intro"
    | "sales_supplement"
    | "company_wait_request"
    | "company_overview"
    | "complete";
  let introPhase: IntroPhase = "complete";
  let pattern1Stage: Pattern1Stage = "attendance";
  let companyGreetingPromptPending = false;
  let companyIntroAckPromptPending = false;
  let studentIntroApprovalPromptPending = false;
  let companyCandidateAckPromptPending = false;
  let companyOverviewPromptPending = false;
  let pendingPattern3StudentExit = false;
  let pattern2StartTimingAsked = false;
  let pattern2VisaHandoffAsked = false;
  let pendingCandidateRetry = false;
  let pendingCandidateResponseMode: CandidateResponseMode | null = null;
  let studentIntroPromptPending = false;
  const endMarkers = ["【面接終了】", "【面接中止】"];
  let lastPhaseNotified: Phase | null = null;
  type CoverageKey =
    | "experience"
    | "motivation"
    | "language"
    | "shift"
    | "stamina"
    | "visa";
  type InterviewIntent = CoverageKey | "other";
  type CandidateAnswerAssessment = "fit" | "partial" | "mismatch";
  type ConversationHistorySpeaker = "sales" | "candidate" | "interviewer";
  type ConversationHistoryEntry = {
    speaker: ConversationHistorySpeaker;
    phase: Phase;
    text: string;
  };
  type CandidateBufferedTurn = {
    turnId: number;
    name: string;
    audioChunks: string[];
    audioDone: boolean;
    validatedText: string | null;
  };
  let coverage: Record<CoverageKey, boolean> = {
    experience: false,
    motivation: false,
    language: false,
    shift: false,
    stamina: false,
    visa: false
  };
  let lastInterviewerIntent: InterviewIntent | null = null;
  let pendingCandidateRetryIntent: InterviewIntent | null = null;
  let pendingInterviewerGuidance: string | null = null;
  let pendingFollowUpContext:
    | { intent: CoverageKey; candidateAnswer: string; assessment: "fit" | "partial" }
    | null = null;
  let conversationHistory: ConversationHistoryEntry[] = [];
  let bufferedCandidateTurn: CandidateBufferedTurn | null = null;
  let lastCandidateRelayContext:
    | {
        salesText: string;
        normalizedPrompt: string;
        mode: CandidateResponseMode;
      }
    | null = null;
  let candidateValidationRetryCount = 0;
  let followUpCountsByIntent: Partial<Record<CoverageKey, number>> = {};
  let followUpTopicUsage: Record<string, number> = {};
  const MAX_HISTORY_ENTRIES = 12;
  const MAX_CANDIDATE_VALIDATION_RETRIES = 1;
  const coverageLabels: Record<CoverageKey, string> = {
    experience: "経験・業務",
    motivation: "動機・理由",
    language: "日本語力",
    shift: "シフト・夜勤",
    stamina: "体力・健康",
    visa: "在留/開始時期"
  };
  const updateCoverage = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return;
    if (!coverage.experience && /経験|前職|介護|業務|仕事|働い|勤務/.test(normalized)) {
      coverage.experience = true;
    }
    if (!coverage.motivation && /志望|理由|動機|なぜ|きっかけ|やりたい|興味/.test(normalized)) {
      coverage.motivation = true;
    }
    if (!coverage.language && /日本語|会話|コミュニケーション|聞き取り|読み|書き/.test(normalized)) {
      coverage.language = true;
    }
    if (!coverage.shift && /シフト|夜勤|早番|遅番|勤務時間|週|時間帯|休み/.test(normalized)) {
      coverage.shift = true;
    }
    if (!coverage.stamina && /体力|健康|腰|持病|疲れ|力/.test(normalized)) {
      coverage.stamina = true;
    }
    if (!coverage.visa && /ビザ|在留|滞在|資格|就労|期間|入社|開始日|いつから/.test(normalized)) {
      coverage.visa = true;
    }
  };
  const getCurrentIndustryScenario = () => getIndustryScenario(interviewIndustry);
  const appendConversationHistory = (
    speaker: ConversationHistorySpeaker,
    text: string
  ) => {
    const normalized = text.trim();
    if (!normalized) return;
    conversationHistory = [
      ...conversationHistory,
      { speaker, phase, text: normalized }
    ].slice(-MAX_HISTORY_ENTRIES);
  };
  const getRecentConversationHistory = () =>
    conversationHistory.slice(-8).map((entry) => ({
      speaker: entry.speaker,
      phase: entry.phase,
      text: entry.text
    }));
  const shouldBufferCandidateOutput = (key: AiKey) =>
    ENABLE_CANDIDATE_RESPONSE_VALIDATION &&
    key === "ai_b" &&
    SALES_LED_FLOW &&
    phase !== "pattern3";
  const getMaxFollowUpsPerIntent = () =>
    interviewerSettings.difficulty === "hard" ? 2 : 0;
  const MAX_FOLLOWUPS_PER_TOPIC = 1;
  type FollowUpTopic = IndustryFollowUpTopicSpec;
  const GENERIC_FOLLOW_UP_TOPICS: Record<
    Exclude<CoverageKey, "experience">,
    FollowUpTopic[]
  > = {
    motivation: [
      {
        key: "why_this_work",
        label: "仕事をしたい理由",
        keywords: ["理由", "きっかけ", "好き", "興味", "やりたい"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about why they became interested in this kind of work.",
          "Ask one short Japanese follow-up about what made them want to continue this kind of job."
        ]
      },
      {
        key: "helping_people",
        label: "人助け・やりがい",
        keywords: ["助けたい", "役に立ち", "感謝", "うれしい", "やりがい"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what kind of situations made them feel rewarded.",
          "Ask one short Japanese follow-up about when they feel they are helping people."
        ]
      }
    ],
    language: [
      {
        key: "daily_use",
        label: "日常利用",
        keywords: ["毎日", "少し", "勉強", "使う"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about where they use Japanese every day.",
          "Ask one short Japanese follow-up about how often they study or use Japanese."
        ]
      },
      {
        key: "workplace_communication",
        label: "職場会話",
        keywords: ["職場", "会話", "コミュニケーション", "話す", "聞く"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what kind of workplace conversations they can handle.",
          "Ask one short Japanese follow-up about whether they can understand instructions at work."
        ]
      },
      {
        key: "confidence",
        label: "自信",
        keywords: ["自信", "不安", "まだ", "上手", "大丈夫"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about how confident they feel speaking Japanese at work.",
          "Ask one short Japanese follow-up about what part of Japanese communication feels difficult for them."
        ]
      }
    ],
    shift: [
      {
        key: "days_per_week",
        label: "週の勤務日数",
        keywords: ["週", "日", "何日", "平日", "土日"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about how many days per week they can work.",
          "Ask one short Japanese follow-up about which days of the week they can work."
        ]
      },
      {
        key: "night_shift",
        label: "夜勤",
        keywords: ["夜勤", "夜", "深夜"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about whether night shifts are really possible for them.",
          "Ask one short Japanese follow-up about their experience or comfort with night shifts."
        ]
      },
      {
        key: "time_slot",
        label: "時間帯",
        keywords: ["時間", "時間帯", "早番", "遅番", "朝", "夕方"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about which time slots they can work.",
          "Ask one short Japanese follow-up about whether they have limits on working hours."
        ]
      }
    ],
    stamina: [
      {
        key: "physical_load",
        label: "体力",
        keywords: ["体力", "長時間", "立ち", "重い", "疲れ"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about whether they can handle long hours on their feet or physical work.",
          "Ask one short Japanese follow-up about how they manage physically demanding work."
        ]
      },
      {
        key: "health_condition",
        label: "健康状態",
        keywords: ["健康", "元気", "問題ない", "持病", "腰"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about their general health condition.",
          "Ask one short Japanese follow-up about whether they have any health concerns for the job."
        ]
      }
    ],
    visa: [
      {
        key: "start_timing",
        label: "開始時期",
        keywords: ["すぐ", "来週", "来月", "開始", "入社", "いつから"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about the concrete timing for starting work.",
          "Ask one short Japanese follow-up about when they can realistically begin."
        ]
      },
      {
        key: "paperwork_readiness",
        label: "手続き準備",
        keywords: ["在留", "ビザ", "手続き", "申請", "書類"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about whether they understand the paperwork or visa timing.",
          "Ask one short Japanese follow-up about how ready they are for the start procedure."
        ]
      }
    ]
  };
  const normalizeKnownTranscriptTerms = (text: string) =>
    text
      .replace(/ひときわ/gi, "ヒトキワ")
      .replace(/株式会社ヒトキワ/gi, "株式会社ヒトキワ");
  const detectInterviewIntent = (text: string): InterviewIntent => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return "other";
    if (!/[?？]|教えて|聞かせて|伺|確認|できますか|いかが|でしょうか/.test(normalized)) {
      return "other";
    }
    if (/経験|前職|介護|業務|担当|どんな仕事|何をして|どのような仕事/.test(normalized)) {
      return "experience";
    }
    if (/志望|理由|動機|なぜ|きっかけ|やりたい|興味/.test(normalized)) {
      return "motivation";
    }
    if (/日本語|会話|コミュニケーション|話せ|使え|聞き取り|読み|書き/.test(normalized)) {
      return "language";
    }
    if (/シフト|夜勤|曜日|週|何日|勤務時間|時間帯|早番|遅番|働ける/.test(normalized)) {
      return "shift";
    }
    if (/体力|健康|腰|持病|疲れ|力|元気/.test(normalized)) {
      return "stamina";
    }
    if (/ビザ|在留|資格|就労|開始日|いつから|入社|来日|働き始め/.test(normalized)) {
      return "visa";
    }
    return "other";
  };
  const getIntentRetryHint = (intent: InterviewIntent | null) => {
    const scenario = getCurrentIndustryScenario();
    switch (intent) {
      case "experience":
        return scenario.experienceRetryHint;
      case "motivation":
        return "今はその仕事をしたい理由だけを短く答えてください。";
      case "language":
        return "今は日本語をどのくらい使えるか、毎日使うか、職場で話せるかを短く答えてください。";
      case "shift":
        return "今は1週間にどれくらい働けるか、夜勤ができるか、曜日や時間帯を短く答えてください。";
      case "stamina":
        return "今は健康状態や体力について短く答えてください。";
      case "visa":
        return "今はいつから働けるか、開始時期だけを短く答えてください。";
      default:
        return "営業担当が言い換えた質問の意図に合わせて、短く具体的に答えてください。";
    }
  };
  const getIntentPatterns = (intent: CoverageKey) => {
    const scenario = getCurrentIndustryScenario();
    const escapedIndustryKeywords = scenario.experienceKeywords.map((keyword) =>
      keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    );
    const intentPatterns: Record<CoverageKey, RegExp[]> = {
      experience: [
        new RegExp(
          `${escapedIndustryKeywords.join("|")}|業務|仕事|勤務|担当`,
          "u"
        )
      ],
      motivation: [/助けたい|好き|やりたい|興味|感謝|役に立ちたい|理由|きっかけ/],
      language: [/日本語|話せ|会話|毎日|少し|勉強|使う|聞き取|読|書/],
      shift: [/夜勤|シフト|週|曜日|時間|何日|勤務|働ける|早番|遅番/],
      stamina: [/健康|元気|体力|大丈夫|問題ない|疲れ|丈夫/],
      visa: [/すぐ|来週|来月|いつから|開始|入社|働ける|在留|ビザ/]
    };
    return intentPatterns[intent];
  };
  const classifyCandidateAnswerByRules = (
    intent: InterviewIntent | null,
    text: string
  ): {
    assessment: CandidateAnswerAssessment | null;
    confidence: "high" | "medium" | "low";
  } => {
    if (!intent || intent === "other") {
      return { assessment: "fit", confidence: "high" };
    }
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) {
      return { assessment: "mismatch", confidence: "high" };
    }

    const currentIntentMatched = getIntentPatterns(intent).some((pattern) =>
      pattern.test(normalized)
    );
    if (currentIntentMatched) {
      return {
        assessment: isCandidateAnswerShallow(intent, text) ? "partial" : "fit",
        confidence: "high"
      };
    }

    const otherIntentMatched = (
      Object.keys(coverageLabels) as CoverageKey[]
    ).some(
      (key) =>
        key !== intent &&
        getIntentPatterns(key).some((pattern) => pattern.test(normalized))
    );
    if (otherIntentMatched) {
      return { assessment: "mismatch", confidence: "high" };
    }

    return { assessment: null, confidence: "low" };
  };
  const classifyCandidateAnswerWithAi = async (
    intent: InterviewIntent | null,
    answerText: string
  ): Promise<{
    assessment: CandidateAnswerAssessment;
    confidence: "high" | "medium" | "low";
  }> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1800);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: OPENAI_ROUTING_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You classify whether a candidate's short Japanese answer matches the intended interview question. Return strict JSON with keys assessment and confidence. assessment must be one of: fit, partial, mismatch. confidence must be one of: high, medium, low. fit means the answer addresses the question enough to continue. partial means it is on-topic but brief or incomplete, so the interviewer can follow up. mismatch means it answers a different question or misses the asked point, so the sales representative should ask again. Be tolerant of broken Japanese, paraphrases, and ASR errors."
            },
            {
              role: "user",
              content: JSON.stringify({
                industry: getCurrentIndustryScenario().label,
                intent,
                interviewerQuestion: lastInterviewerQuestionText,
                salesRephrase: lastSalesUtterance,
                candidateAnswer: answerText
              })
            }
          ]
        })
      });

      if (!response.ok) {
        return { assessment: "partial", confidence: "low" };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as {
        assessment?: CandidateAnswerAssessment;
        confidence?: "high" | "medium" | "low";
      };
      const assessment =
        parsed.assessment === "fit" ||
        parsed.assessment === "partial" ||
        parsed.assessment === "mismatch"
          ? parsed.assessment
          : "partial";
      const confidence =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "low";
      return { assessment, confidence };
    } catch {
      return { assessment: "partial", confidence: "low" };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const assessCandidateAnswer = async (
    intent: InterviewIntent | null,
    answerText: string
  ): Promise<CandidateAnswerAssessment> => {
    const ruleResult = classifyCandidateAnswerByRules(intent, answerText);
    if (
      ruleResult.assessment &&
      ruleResult.confidence !== "low" &&
      ruleResult.assessment !== "mismatch"
    ) {
      return ruleResult.assessment;
    }
    const aiResult = await classifyCandidateAnswerWithAi(intent, answerText);
    if (aiResult.confidence === "high" || aiResult.confidence === "medium") {
      return aiResult.assessment;
    }
    if (
      ruleResult.assessment &&
      ruleResult.confidence !== "low" &&
      ruleResult.assessment === "mismatch"
    ) {
      return "partial";
    }
    return ruleResult.assessment === "fit" || ruleResult.assessment === "partial"
      ? ruleResult.assessment
      : "partial";
  };
  const isCandidateAnswerShallow = (
    intent: InterviewIntent | null,
    text: string
  ) => {
    if (!intent || intent === "other") return false;
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return true;
    switch (intent) {
      case "experience":
        return normalized.length < 14 || /少し|ちょっと|お手伝い/.test(normalized);
      case "motivation":
        return normalized.length < 12 || /助けたい|好き/.test(normalized);
      case "language":
        return normalized.length < 12 || /少し|ちょっと|毎日/.test(normalized);
      case "shift":
        return !/夜勤|曜日|週|時間/.test(normalized);
      case "stamina":
        return normalized.length < 8 && !/健康|大丈夫|問題ない|元気/.test(normalized);
      case "visa":
        return normalized.length < 8 && !/すぐ|来週|来月|開始|入社|働ける/.test(normalized);
      default:
        return false;
    }
  };
  const buildGenericInterviewerFollowUpGuidance = (
    intent: InterviewIntent,
    candidateAnswer: string
  ) => {
    const scenario = getCurrentIndustryScenario();
    switch (intent) {
      case "experience":
        return `First react briefly and naturally in Japanese to the candidate's answer, then continue. The candidate's experience answer was brief: 「${candidateAnswer}」. ${scenario.experienceFollowUpPrompt}`;
      case "motivation":
        return `First react briefly and naturally in Japanese to the candidate's answer, then continue. The candidate's motivation answer was brief: 「${candidateAnswer}」. Ask one short Japanese follow-up about why they became interested in this work or what makes the work meaningful to them.`;
      case "language":
        return `First react briefly and naturally in Japanese to the candidate's answer, then continue. The candidate's language answer was brief: 「${candidateAnswer}」. Ask one short Japanese follow-up about where they use Japanese daily or how comfortable they are speaking at work.`;
      case "shift":
        return `First react briefly and naturally in Japanese to the candidate's answer, then continue. The candidate's shift answer was partial: 「${candidateAnswer}」. Stay on the same topic and ask one short Japanese follow-up about days per week, night shift, or workable time slots.`;
      case "stamina":
        return `First react briefly and naturally in Japanese to the candidate's answer, then continue. The candidate's stamina/health answer was brief: 「${candidateAnswer}」. Ask one short Japanese follow-up about physical stamina or whether long shifts are manageable.`;
      case "visa":
        return `First react briefly and naturally in Japanese to the candidate's answer, then continue. The candidate's start-date answer was brief: 「${candidateAnswer}」. Ask one short Japanese follow-up about the concrete timing for starting work.`;
      default:
        return null;
    }
  };
  const pickRandom = <T>(items: T[]) =>
    items[Math.floor(Math.random() * items.length)];
  const getFollowUpTopicUsageKey = (intent: CoverageKey, topicKey: string) =>
    `${intent}:${topicKey}`;
  const getFollowUpTopicsForIntent = (
    intent: CoverageKey
  ): FollowUpTopic[] => {
    if (intent === "experience") {
      return getCurrentIndustryScenario().experienceTopics;
    }
    return GENERIC_FOLLOW_UP_TOPICS[intent];
  };
  const extractMatchedFollowUpTopics = (
    intent: CoverageKey,
    combinedText: string
  ) => {
    const normalized = combinedText.replace(/\s+/g, "");
    const topics = getFollowUpTopicsForIntent(intent);
    return topics.filter((topic) =>
      topic.keywords.some((keyword) =>
        normalized.includes(keyword.replace(/\s+/g, ""))
      )
    );
  };
  const getAvailableFollowUpTopics = (intent: CoverageKey) =>
    getFollowUpTopicsForIntent(intent).filter(
      (topic) =>
        (followUpTopicUsage[getFollowUpTopicUsageKey(intent, topic.key)] ?? 0) <
        MAX_FOLLOWUPS_PER_TOPIC
    );
  const buildTopicAwareFollowUpGuidance = (
    intent: CoverageKey,
    candidateAnswer: string,
    salesSupplement: string,
    assessment: "fit" | "partial"
  ): { guidance: string; topicKey: string } | null => {
    if (interviewerSettings.difficulty === "easy") {
      return null;
    }
    const intentCount = followUpCountsByIntent[intent] ?? 0;
    if (intentCount >= getMaxFollowUpsPerIntent()) {
      return null;
    }

    const combinedText = `${candidateAnswer} ${salesSupplement}`.trim();
    const isHardDifficulty = interviewerSettings.difficulty === "hard";
    const shallowAnswer = isCandidateAnswerShallow(intent, candidateAnswer);
    if (assessment !== "partial" && !isHardDifficulty && !shallowAnswer) {
      return null;
    }
    const availableTopics = getAvailableFollowUpTopics(intent);
    const matchedTopics = extractMatchedFollowUpTopics(intent, combinedText).filter(
      (topic) => availableTopics.some((availableTopic) => availableTopic.key === topic.key)
    );

    if (matchedTopics.length > 0) {
      const topic = pickRandom(matchedTopics);
      const prompt = pickRandom(topic.followUpPrompts);
      const salesContext = salesSupplement
        ? ` The sales representative also added: 「${salesSupplement}」.`
        : "";
      return {
        guidance: `The active interview topic is ${intent}. The candidate answered: 「${candidateAnswer}」.${salesContext} First react briefly and naturally in Japanese to what was just said, then keep the flow natural and ask one short Japanese follow-up that digs into the specific topic 「${topic.label}」. ${prompt}`,
        topicKey: topic.key
      };
    }

    if (isHardDifficulty) {
      const offScriptTopics = availableTopics.filter(
        (topic) => !matchedTopics.some((matchedTopic) => matchedTopic.key === topic.key)
      );
      if (offScriptTopics.length > 0) {
        const topic = pickRandom(offScriptTopics);
        const prompt = pickRandom(topic.followUpPrompts);
        const salesContext = salesSupplement
          ? ` The sales representative also added: 「${salesSupplement}」.`
          : "";
        return {
          guidance: `The active interview topic is ${intent}. The candidate answered: 「${candidateAnswer}」.${salesContext} First react briefly and naturally in Japanese to what was just said, then ask one short Japanese follow-up that stays interview-relevant but goes one step deeper on the related subtopic 「${topic.label}」. Make it sound natural from the flow, not scripted. ${prompt}`,
          topicKey: topic.key
        };
      }
    }

    const genericKey = getFollowUpTopicUsageKey(intent, "generic");
    if ((followUpTopicUsage[genericKey] ?? 0) >= MAX_FOLLOWUPS_PER_TOPIC) {
      return null;
    }
    if (!isHardDifficulty && assessment !== "partial" && !shallowAnswer) {
      return null;
    }
    const genericGuidance = buildGenericInterviewerFollowUpGuidance(
      intent,
      candidateAnswer
    );
    if (!genericGuidance) {
      return null;
    }
    return {
      guidance: genericGuidance,
      topicKey: "generic"
    };
  };
  const markFollowUpUsed = (intent: CoverageKey, topicKey: string) => {
    followUpCountsByIntent[intent] = (followUpCountsByIntent[intent] ?? 0) + 1;
    const usageKey = getFollowUpTopicUsageKey(intent, topicKey);
    followUpTopicUsage[usageKey] = (followUpTopicUsage[usageKey] ?? 0) + 1;
  };
  const hasCandidateConfusionSignal = (text: string) =>
    /わからない|わかりません|知りません|難しい|むずかしい|もう一回|もういちど|聞き取れない|聞き取れません|聞こえない|聞こえません|理解できない|意味わからない|sorry/i.test(
      text
    );
  const hasCandidateSubstantiveContent = (text: string) => {
    const stripped = text
      .replace(
        /すみません|ごめんなさい|わからない|わかりません|知りません|難しい|むずかしい|もう一回|もういちど|聞き取れない|聞き取れません|聞こえない|聞こえません|理解できない|意味わからない|sorry|please|repeat|でも|けど|ですが|ちょっと|えっと|あの/gi,
        ""
      )
      .replace(/[、。,.!?？！…\s]/g, "");
    return /[ぁ-んァ-ン一-龯]/.test(stripped) && stripped.length >= 6;
  };
  const isStudentIntroSufficient = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    const scenario = getCurrentIndustryScenario();
    if (hasCandidateConfusionSignal(normalized) && !hasCandidateSubstantiveContent(normalized)) {
      return false;
    }
    if (
      new RegExp(
        `名前|わたし|私は|です|フィリピン|ベトナム|経験|年|歳|来日|${scenario.introKeywords.join("|")}`
      ).test(normalized)
    ) {
      return true;
    }
    return normalized.length >= 12;
  };
  const isCandidateNeedsClarification = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return true;
    // Only treat explicit retry/clarification requests as needing a retry.
    if (hasCandidateConfusionSignal(normalized) && !hasCandidateSubstantiveContent(normalized)) {
      return /もう一回|もういちど|もう一度|お願いします|簡単に|ゆっくり|聞き取れない|聞こえない|repeat|please/.test(
        normalized
      );
    }
    return false;
  };
  const isNoiseUserTranscript = (text: string) => {
    const normalized = text.trim();
    if (!normalized) return true;
    const lower = normalized.toLowerCase();
    const noiseTokens = [
      "you",
      "you.",
      "bye",
      "bye.",
      "ok",
      "ok.",
      "okay",
      "okay.",
      "yes",
      "no",
      "hello",
      "thanks",
      "thankyou",
      "um",
      "uh",
      "hmm",
      "huh",
      "...",
      "..",
      ".",
      "-",
      "_"
    ];
    if (noiseTokens.includes(lower)) return true;
    const alphaCompact = lower.replace(/[^a-z0-9]/g, "");
    if (/^[a-z]+$/.test(alphaCompact) && alphaCompact.length <= 4) return true;
    const hasJapanese = /[ぁ-んァ-ン一-龯0-9]/.test(normalized);
    const hasLatinOnlyWords =
      !hasJapanese &&
      /^[A-Za-zÀ-ÿ' .,-]+$/.test(normalized) &&
      normalized.split(/\s+/).filter(Boolean).length <= 3 &&
      alphaCompact.length <= 24;
    const hasHangul = /[\uAC00-\uD7AF]/.test(normalized);
    if (hasLatinOnlyWords) return true;
    if (hasHangul && !hasJapanese) return true;
    if (!hasJapanese && normalized.length <= 3) return true;
    return false;
  };
  const countRegexMatches = (text: string, patterns: RegExp[]) =>
    patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  const shouldTransitionToPattern2 = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;

    const hardBlockers = [
      /退室|退出|退席/,
      /まだ.*(始め|開始|スタート)/,
      /(始め|開始|スタート).*(ない|ません|まだ)/,
      /入室.*(前|したら.*だけ|したあとにまた)/,
      /面接.*(しない|やらない|延期)/
    ];
    if (hardBlockers.some((pattern) => pattern.test(normalized))) {
      return false;
    }

    const startIntentPatterns = [
      /面接開始/,
      /面接スタート/,
      /それでは.*面接/,
      /これから.*面接/,
      /面接を(始め|開始)/,
      /(始め|開始)ます/,
      /よろしくお願いします.*面接/
    ];
    const interviewerPresencePatterns = [
      /面接官/,
      /採用担当/,
      /企業様/,
      /企業の方/,
      /担当者/,
      /御社/
    ];
    const joinPatterns = [
      /入室/,
      /参加/,
      /お入り/,
      /来ました/,
      /来られ/,
      /いらっしゃ/,
      /お待たせ/
    ];
    const explicitScriptPatterns = [
      /面接官の方.*入室.*面接(開始|スタート)/,
      /(採用担当|企業の方).*(入室|参加).*(面接|開始)/,
      /(それでは|では).*(面接|ご面接).*(始め|開始)/
    ];

    const explicitScore = countRegexMatches(normalized, explicitScriptPatterns) * 4;
    const startScore = countRegexMatches(normalized, startIntentPatterns) * 2;
    const presenceScore = countRegexMatches(normalized, interviewerPresencePatterns);
    const joinScore = countRegexMatches(normalized, joinPatterns);
    const score = explicitScore + startScore + presenceScore + joinScore;

    const hasStartIntent =
      explicitScore > 0 || countRegexMatches(normalized, startIntentPatterns) > 0;
    const hasInterviewerPresence =
      countRegexMatches(normalized, interviewerPresencePatterns) > 0;
    const hasJoinSignal = countRegexMatches(normalized, joinPatterns) > 0;

    return score >= 4 && hasStartIntent && (hasInterviewerPresence || hasJoinSignal);
  };
  const shouldTransitionToPattern3 = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;

    const hardBlockers = [
      /入室/,
      /まだ.*(退室|退出|退席)/,
      /(退室|退出|退席).*(しない|させない|不要|しなくて)/,
      /学生.*(残る|残って)/,
      /候補者.*(残る|残って)/
    ];
    if (hardBlockers.some((pattern) => pattern.test(normalized))) {
      return false;
    }

    const studentPatterns = [/学生/, /生徒/, /候補者/, /本人/];
    const exitPatterns = [/退室/, /退出/, /退席/, /先に失礼/];
    const postInterviewPatterns = [
      /この後.*ヒアリング/,
      /この後.*お時間/,
      /その後.*ご説明/,
      /この後.*ビザ/,
      /その後.*ビザ/,
      /この後.*在留/,
      /その後.*在留/,
      /この後.*技人国/,
      /その後.*技人国/,
      /退室.*ビザ/,
      /退出.*ビザ/,
      /学生.*退出.*その後/,
      /学生.*退出.*この後/,
      /学生.*退室.*ヒアリング/,
      /企業様.*残って/
    ];
    const explicitScriptPatterns = [
      /(学生|生徒|候補者).*(退室|退出|退席)/,
      /(退室|退出|退席).*(学生|生徒|候補者)/,
      /(学生|生徒|候補者).*(この後|その後).*(ヒアリング|お時間)/,
      /(この後|その後).*(ヒアリング|お時間).*(いただいて|もらって|お願い)/
    ];

    const explicitScore = countRegexMatches(normalized, explicitScriptPatterns) * 4;
    const studentScore = countRegexMatches(normalized, studentPatterns);
    const exitScore = countRegexMatches(normalized, exitPatterns) * 2;
    const postInterviewScore = countRegexMatches(normalized, postInterviewPatterns) * 2;
    const score = explicitScore + studentScore + exitScore + postInterviewScore;

    const hasStudent = countRegexMatches(normalized, studentPatterns) > 0;
    const hasExit = countRegexMatches(normalized, exitPatterns) > 0;
    const hasPostInterview =
      explicitScore > 0 || countRegexMatches(normalized, postInterviewPatterns) > 0;
    const followsVisaTopic =
      lastInterviewerIntent === "visa" &&
      hasStudent &&
      (hasExit ||
        /この後|その後|残って|ご説明|ビザ|在留|技人国/.test(normalized));

    return (
      (score >= 4 && hasStudent && (hasExit || hasPostInterview)) ||
      followsVisaTopic
    );
  };
  const shouldRequestPattern3ExitApproval = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    const hasStudentExit = /(学生|生徒|候補者|本人).*(退室|退出|退席)|(退室|退出|退席).*(学生|生徒|候補者|本人)/.test(
      normalized
    );
    const hasVisaTopic = /ビザ|在留|技人国|許可率|許可|書類/.test(normalized);
    const hasPermissionAsk =
      /よろしいでしょうか|よろしいですか|いいですか|可能でしょうか|してもよろしい/.test(
        normalized
      ) || /もよろしいでしょうか|もよろしいですか/.test(normalized);
    return hasStudentExit && hasVisaTopic && hasPermissionAsk;
  };
  const shouldExecutePattern3StudentExit = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    if (/よろしいでしょうか|よろしいですか|いいですか|可能でしょうか/.test(normalized)) {
      return false;
    }
    return (
      /(退室|退出|退席).*(してください|お願いします|していただ|してもら|してもらい)/.test(
        normalized
      ) ||
      /(それでは|では).*(退室|退出|退席)/.test(normalized)
    );
  };
  const isStartTimingTopicText = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    return /いつ頃から|いつから|開始時期|勤務を始め|始められ|働くことができ|働けますか|入社時期|来月|来週|スタート/.test(
      normalized
    );
  };
  const isVisaHandoffTopicText = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    return /ビザ|在留|技人国|許可率|許可|手続き|書類/.test(normalized);
  };
  const shouldPromptCompanyResponse = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    return /印象|感想|いかが|評価|結果|内定|通知書|労働条件|雛形|ビザ|書類|日程/.test(normalized);
  };
  const isPattern3ImpressionPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /全体的な印象/,
      /印象はいかが/,
      /印象.*どう/,
      /感想/,
      /面接いただいた.*印象/,
      /ご面接.*印象/
    ]);
  };
  const isPattern3ResultTimingPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /2.?3日/,
      /結果.*ご連絡/,
      /結果.*連絡/,
      /早めに結果/,
      /いつまで/,
      /何日以内/
    ]);
  };
  const isPattern3OfferDocumentPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    if (containsAny(normalized, [/必要書類/, /履歴事項全部証明書/, /法定調書/, /決算報告書/, /雇用保険/])) {
      return false;
    }
    return containsAny(normalized, [
      /内定通知書/,
      /労働条件通知書/,
      /雛形/,
      /雇用契約書/,
      /書式の指定/,
      /合格通知書/
    ]);
  };
  const isPattern3VisaExplanationPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /技人国/,
      /ビザ/,
      /単純作業/,
      /管理業務/
    ]);
  };
  const isPattern3VisaOutcomePrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /ビザの申請が完了/,
      /1.?2ヶ月/,
      /3.?4ヶ月/,
      /5.?6ヶ月/,
      /許可率/,
      /70.?80%/,
      /100%許可/,
      /採用枠に余裕/,
      /他の方の採用/,
      /他の方の採用もご検討/
    ]);
  };
  const isPattern3CareerPathPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    if (containsAny(normalized, [/申請上重要/, /その点はいかがでしょうか/])) {
      return false;
    }
    return containsAny(normalized, [
      /御社で.*将来どのようなキャリアアップ/,
      /御社で.*キャリアアップの可能性/,
      /どのようなキャリアアップ/,
      /キャリアアップの可能性.*お伺い/,
      /採用理由書の作成にあたり/
    ]);
  };
  const isPattern3RequiredDocsPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /必要書類/,
      /履歴事項全部証明書/,
      /登記簿/,
      /法定調書/,
      /決算報告書/,
      /雇用保険/,
      /全従業員数/,
      /外国籍従業員人数/,
      /技能実習生数/
    ]);
  };
  const isPattern3DeadlinePrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /本日中/,
      /明日中/,
      /返送/,
      /期日/,
      /いつまで/,
      /日程切/,
      /今日中/
    ]);
  };
  const isPattern3ClosingPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /本日のご面接ありがとうございました/,
      /本日はありがとうございました/,
      /ご紹介をお願いします/,
      /お気軽にご連絡/,
      /引き続きよろしく/
    ]);
  };
  const getPattern3VisaCareerExamples = () => {
    switch (interviewIndustry) {
      case "restaurant":
        return "将来的には、外国人スタッフの指導、シフト作成補助、在庫管理、衛生管理などを任せていくイメージです。";
      case "hotel":
        return "将来的には、外国人スタッフの教育、客室やフロントのシフト調整、備品在庫管理、サービス品質の確認などを任せていくイメージです。";
      default:
        return "将来的には、外国人スタッフの指導、シフト管理、在庫管理、衛生管理などの管理業務も任せていくイメージです。";
    }
  };
  const buildPattern3InterviewerGuidance = (salesText: string) => {
    if (isPattern3ImpressionPrompt(salesText)) {
      return interviewerSettings.difficulty === "hard"
        ? "Respond in Japanese as the company side with overall impressions. Avoid framing it as 「良い悪い」 or 「難しい」. Do not start with stiff permission-style phrases like 「承知しました」 or 「かしこまりました」. Start naturally with 「ありがとうございます」 or directly with the impression. If natural, you may mention one especially positive candidate by name and give one short concrete positive reason, but do not give a final offer yet unless the sales representative clearly pushed that direction."
        : "Respond in Japanese as the company side with overall impressions. Avoid framing it as 「良い悪い」 or 「難しい」. Do not start with stiff permission-style phrases like 「承知しました」 or 「かしこまりました」. Start naturally with 「ありがとうございます」 or directly with the impression. Prefer a cooperative but non-final answer such as saying you will review internally and contact them again.";
    }
    if (isPattern3ResultTimingPrompt(salesText)) {
      return "Respond in Japanese as the company side. Acknowledge the request and be cooperative about giving the selection result within 2〜3日 if possible. Keep it concise and practical.";
    }
    if (isPattern3RequiredDocsPrompt(salesText)) {
      return "Respond in Japanese as the company side. Acknowledge the required documents and simply say you will prepare them. Do not ask them to send a template in this turn. Keep it short, cooperative, and practical, close to 「かしこまりました。必要書類の準備をしていきます。」.";
    }
    if (isPattern3OfferDocumentPrompt(salesText)) {
      return interviewerSettings.difficulty === "hard"
        ? "Respond in Japanese as the company side about the labor conditions notice / template. Either ask them to send their 雛形 or say you will send your own company format. Pick one path clearly and concisely."
        : "Respond in Japanese as the company side and cooperatively ask them to send their 雛形 for the labor conditions notice. Keep it short and practical.";
    }
    if (isPattern3VisaOutcomePrompt(salesText)) {
      return "Respond in Japanese as the company side after hearing the visa timeline / approval-rate explanation. Keep it short and natural. Show understanding of the timeline and approval risk, and if the sales representative mentioned considering other candidates, say you will take that into account. Do not talk about career-up in this turn. A good direction is: 「かしこまりました。承知いたしました。採用枠も含めて検討いたします。」 or 「かしこまりました。承知いたしました。他の候補者も含めて検討いたします。」.";
    }
    if (isPattern3VisaExplanationPrompt(salesText)) {
      return "Respond in Japanese as the company side after hearing the 技人国 visa explanation. Keep the reply short and cooperative, close to 「かしこまりました。将来的にキャリアアップも考えています。」. Do not add concrete examples, management details, or extra explanation in this turn unless the sales representative explicitly asks a separate follow-up about future career-up possibilities.";
    }
    if (isPattern3CareerPathPrompt(salesText)) {
      return `Respond in Japanese as the company side with 1〜2 short concrete examples of future career-up possibilities at your company. Make the Japanese sound natural by briefly naming the topic first, for example 「キャリアアップについてですが、例えば…」. Keep it practical and consistent with this industry: ${getPattern3VisaCareerExamples()}`;
    }
    if (isPattern3DeadlinePrompt(salesText)) {
      return "Respond in Japanese as the company side about the requested deadline. Be cooperative and, if reasonable, commit to 本日中 or 明日中. Keep it concise.";
    }
    if (isPattern3ClosingPrompt(salesText)) {
      return "Respond in Japanese as the company side with a short polite closing. After the closing line, end with 「【面接終了】」.";
    }
    return null;
  };
  const shouldPromptCompanyOverviewRequest = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /よろしければ.*皆さんに.*お伝え/,
      /会社様.*皆さんに.*お伝え/,
      /お伝えをいただいてもよろしい/,
      /ご説明いただいてもよろしい/,
      /1日のお仕事の流れ/,
      /会社様の雰囲気/,
      /仕事内容.*お伝え/,
      /ご安心いただければ/,
      /会社の方.*お願いします/
    ]);
  };
  const shouldPromptInitialCompanyGreeting = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    const greetingSignals = [
      /お世話になっております|お世話になります/,
      /本日は.*(貴重なお時間|お時間).*(ありがとうございます|いただきありがとうございます)/,
      /面接を担当させていただく|面接を担当します|担当させていただく/,
      /株式会社ヒトキワ|ヒトキワ/,
      /よろしくお願いいたします|よろしくお願いします/
    ];
    const hitCount = greetingSignals.filter((pattern) => pattern.test(normalized)).length;
    return hitCount >= 2;
  };
  const shouldPromptStudentIntro = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    if (/紹介料|ご紹介|紹介できます|紹介しており|人材紹介/.test(normalized)) {
      return false;
    }
    return containsAny(normalized, [
      /自己紹介(を)?(お願いします|お願い|してください|してもら|していただ|どうぞ)/,
      /自己紹介.*(お願いします|お願い|してください|どうぞ)/,
      /お名前/,
      /名前を?(お願いします|お願い|教えて|言って|どうぞ)/,
      /名前から/,
      /ご紹介(を)?(お願いします|お願い|してください|してもら)/,
      /紹介(を)?(お願いします|お願い|してください|してもら)/,
      /[A-Za-zぁ-んァ-ン一-龯]{1,12}さん.*自己紹介/
    ]);
  };
  const looksLikeSelfIntroRequest = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return (
      shouldPromptStudentIntro(normalized) ||
      /名前をお呼び/.test(normalized) ||
      /自己紹介をしてください/.test(normalized)
    );
  };
  const shouldPromptStudentIntroApproval = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /自己紹介させていただいてもよろしい/,
      /自己紹介からさせていただいてもよろしい/,
      /まずは.*自己紹介.*よろしい/,
      /学生の方から.*自己紹介/,
      /名前をお呼びする前に.*自己紹介/
    ]);
  };
  const shouldPromptCompanyIntroAcknowledgement = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized || isQuestionLike(normalized)) return false;
    if (shouldPromptStudentIntro(normalized)) return false;
    if (isExplicitCandidateAddress(text)) return false;
    const explanationSignals = [
      /改めまして.*ご説明/,
      /東京本社|埼玉|大阪/,
      /教育事業|人材紹介事業/,
      /技人国|ビザ/,
      /紹介料|無料でご紹介/,
      /外国人.*教育/,
      /従業員|スタッフ/,
      /事業内容/
    ];
    const hitCount = explanationSignals.filter((pattern) => pattern.test(normalized)).length;
    return hitCount >= 2 || (/弊社/.test(normalized) && normalized.length >= 60);
  };
  const nextAiForSalesFlow = (): AiKey => {
    if (phase === "pattern1") {
      return "ai_b";
    }
    if (phase === "pattern3") {
      return "ai_a";
    }
    if (introPhase === "sales_intro") {
      introPhase = "company_greeting";
      return "ai_a";
    }
    if (introPhase === "company_greeting") {
      introPhase = "company_ack";
      return "ai_a";
    }
    if (introPhase === "company_ack") {
      introPhase = "student_intro_permission";
      return "ai_a";
    }
    if (introPhase === "student_intro_permission") {
      studentIntroApprovalPromptPending = true;
      return "ai_a";
    }
    if (introPhase === "student_intro") {
      return "ai_b";
    }
    if (introPhase === "sales_supplement") {
      companyCandidateAckPromptPending = true;
      return "ai_a";
    }
    if (introPhase === "company_wait_request") {
      return "ai_a";
    }
    if (introPhase === "company_overview") {
      companyOverviewPromptPending = true;
      return "ai_a";
    }
    const latestCommittedSpeaker = getLatestCommittedNonSalesSpeaker();
    if (latestCommittedSpeaker === "candidate") {
      return "ai_a";
    }
    if (latestCommittedSpeaker === "interviewer") {
      return "ai_b";
    }
    return lastAiSpeaker === "ai_b" ? "ai_a" : "ai_b";
  };
  const peekNextAiForSalesFlow = (): AiKey => {
    if (phase === "pattern1") {
      return "ai_b";
    }
    if (phase === "pattern3") {
      return "ai_a";
    }
    if (introPhase === "sales_intro") {
      return "ai_a";
    }
    if (introPhase === "company_greeting") {
      return "ai_a";
    }
    if (introPhase === "company_ack") {
      return "ai_a";
    }
    if (introPhase === "student_intro_permission") {
      return "ai_a";
    }
    if (introPhase === "student_intro") {
      return "ai_b";
    }
    if (introPhase === "sales_supplement") {
      return "ai_a";
    }
    if (introPhase === "company_wait_request") {
      return "ai_a";
    }
    if (introPhase === "company_overview") {
      return "ai_a";
    }
    const latestCommittedSpeaker = getLatestCommittedNonSalesSpeaker();
    if (latestCommittedSpeaker === "candidate") {
      return "ai_a";
    }
    if (latestCommittedSpeaker === "interviewer") {
      return "ai_b";
    }
    return lastAiSpeaker === "ai_b" ? "ai_a" : "ai_b";
  };
  const hasAllCoverage = () => Object.values(coverage).every(Boolean);
  const listMissingCoverage = () =>
    (Object.entries(coverage) as [CoverageKey, boolean][])
      .filter(([, value]) => !value)
      .map(([key]) => coverageLabels[key])
      .join(", ");

  const pickNextSpeaker = (utterance: string): AiKey | "both" | null => {
    const text = utterance.replace(/\s+/g, "");
    if (!text) return null;
    const scenario = getCurrentIndustryScenario();

    const candidateHints = [
      "本人",
      "候補者",
      "求職者",
      "マリア",
      "彼女",
      "彼",
      "日本語",
      "経験",
      "介護",
      "資格",
      "前職",
      "働い",
      "できます",
      "できる",
      ...scenario.experienceKeywords
    ];
    const interviewerHints = [
      "御社",
      "施設",
      "採用",
      "条件",
      "勤務",
      "シフト",
      "夜勤",
      "面接官",
      "会社",
      "職場",
      "待遇",
      "給与",
      "入社",
      "雇用"
    ];

    const toCandidate = candidateHints.some((word) => text.includes(word));
    const toInterviewer = interviewerHints.some((word) => text.includes(word));

    if (toCandidate && toInterviewer) return "both";
    if (toCandidate) return "ai_b";
    if (toInterviewer) return "ai_a";
    return null;
  };

  const endSession = (reason: "marker" | "max_turns") => {
    if (sessionEnded) return;
    sessionEnded = true;
    sessionEndReason = reason;
    autoMode = false;
    queuedNextKeys = [];
    sendToClient({ type: "session_ended", reason });
  };

  const sendToClient = (payload: unknown) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify(payload));
    }
  };
  const emitCandidateProfile = () => {
    const scenario = getIndustryScenario(interviewIndustry);
    const profile = scenario.candidateProfile;
    sendToClient({
      type: "candidate_profile",
      profile: {
        industry: scenario.label,
        name: profile.name,
        nationality: profile.nationality,
        targetRole: profile.targetRole,
        languageLevel: getCandidateLanguageLevelLabel(candidateLanguageLevel),
        experience: profile.experience,
        strengths: profile.strengths,
        note: profile.note ?? ""
      }
    });
  };
  const setScriptHint = (text: string) => {
    if (!text || text === lastScriptHint) return;
    lastScriptHint = text;
    sendToClient({ type: "script_hint", text });
  };
  const getAiProfile = (key: AiKey): AiProfile =>
    key === "ai_a"
      ? createPattern2InterviewerConfig(interviewIndustry, interviewerSettings)
      : createPattern2StudentConfig(candidateLanguageLevel, interviewIndustry);
  const clearInterruptState = () => {
    interruptPending = false;
    pendingInterruptTarget = null;
    pendingInterruptPrompt = null;
  };
  const normalizeText = (text: string) => text.replace(/\s+/g, "");
  const escapeRegex = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sanitizeCandidateName = (raw: string | null | undefined) => {
    if (!raw) return null;
    const cleaned = raw
      .replace(/^(ではまず|それでは|では|じゃあ|まずは|まず|次は|続いて|つづいて|ありがとう|はい)+/, "")
      .replace(/(さん|様|氏)$/, "")
      .replace(/[、。,.!?？！「」『』]/g, "")
      .trim();
    if (!cleaned || cleaned.length > 12) return null;
    if (
      /^(面接官|企業|企業様|会社|施設|学生|生徒|候補者|本人|皆|みなさん|担当|営業|御社|当社|弊社)$/.test(
        cleaned
      )
    ) {
      return null;
    }
    if (!/[A-Za-zぁ-んァ-ン一-龯]/.test(cleaned)) return null;
    return cleaned;
  };
  const extractCandidateNameFromSales = (text: string) => {
    const directMatch =
      text.match(
        /(?:^|[、。\s])(ではまず|では|それでは|じゃあ|まずは|まず|次は|続いて|つづいて)?\s*([A-Za-zぁ-んァ-ン一-龯]{1,12})\s*さん[^。！？!?]*(自己紹介|お願いします|どうぞ|返事|呼ばれたら|呼びます)?/
      ) ??
      text.match(
        /(?:^|[、。\s])(ではまず|では|それでは|じゃあ|まずは|まず|次は|続いて|つづいて)?\s*([A-Za-zぁ-んァ-ン一-龯]{1,12})\s*さん/
      );
    return sanitizeCandidateName(directMatch?.[2] ?? directMatch?.[1] ?? null);
  };
  const shouldRememberCandidateNameFromSales = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    if (phase === "pattern1") {
      return isPattern1AttendancePrompt(normalized) || /呼びます|返事|呼ばれたら/.test(normalized);
    }
    if (phase === "pattern2") {
      return (
        looksLikeSelfIntroRequest(normalized)
      );
    }
    return false;
  };
  const extractCandidateNameFromIntro = (text: string) => {
    const introMatch =
      text.match(/^\s*([A-Za-zぁ-んァ-ン一-龯]{1,12})\s*(です|と申します)/) ??
      text.match(/^\s*わたしは\s*([A-Za-zぁ-んァ-ン一-龯]{1,12})/) ??
      text.match(/^\s*私[は]?[\s、]*([A-Za-zぁ-んァ-ン一-龯]{1,12})/);
    return sanitizeCandidateName(introMatch?.[1] ?? null);
  };
  const getCurrentCandidateName = () =>
    expectedCandidateName ?? confirmedCandidateName;
  const rememberCandidateNameFromSales = (text: string) => {
    const candidateName = extractCandidateNameFromSales(text);
    if (!candidateName) return;
    expectedCandidateName = candidateName;
    if (!confirmedCandidateName) {
      confirmedCandidateName = candidateName;
    }
    console.log(`[CandidateName] sales-derived="${candidateName}" text="${text}"`);
  };
  const buildCandidateNameBlock = () => {
    const candidateName = getCurrentCandidateName();
    if (!candidateName) {
      return "\n[候補者名]\n- まだ確定名がない。最初に自己紹介する時は自分で一つ名前を決め、その後は必ず同じ名前を使う。";
    }
    return `\n[候補者名]\n- 現在の候補者名は「${candidateName}」。自分の名前を言う時は必ずこの名前を使う。`;
  };
  const buildCandidateSelfIntroVariants = () => {
    const scenario = getCurrentIndustryScenario();
    const candidateName = getCurrentCandidateName() ?? scenario.candidateProfile.name;
    const nationality = scenario.candidateProfile.nationality;
    const workLabel =
      scenario.id === "care"
        ? "介護の仕事"
        : scenario.id === "restaurant"
          ? "飲食の仕事"
          : "ホテルの仕事";
    const roughWorkLabel =
      scenario.id === "care"
        ? "介護"
        : scenario.id === "restaurant"
          ? "飲食"
          : "ホテル";

    if (candidateLanguageLevel === "basic") {
      return [
        `${candidateName}です。${nationality}出身。${roughWorkLabel}、少し。`,
        `${candidateName}です。${nationality}から。${roughWorkLabel}、ちょっと。`,
        `${candidateName}です。${nationality}出身。${roughWorkLabel}の仕事、少し。`,
        `${candidateName}です。${nationality}。${roughWorkLabel}、経験少し。`
      ];
    }

    return [
      `${candidateName}です。${nationality}出身。${workLabel}、少し経験あります。`,
      `${candidateName}です。${nationality}から来ました。${workLabel}、少しやりました。`,
      `${candidateName}です。${nationality}出身です。${workLabel}、少しあります。`,
      `${candidateName}です。${nationality}出身。${workLabel}に興味あります。`
    ];
  };
  const buildInterviewerNameBlock = () => {
    const candidateName = getCurrentCandidateName();
    if (!candidateName) return "";
    return `\n[候補者名]\n- 候補者名は「${candidateName}」。必要なら「${candidateName}さん」と呼ぶ。`;
  };
  const getCandidateLevelStatusText = () =>
    `学生日本語レベル: ${getCandidateLanguageLevelLabel(candidateLanguageLevel)}`;
  const getPhaseScriptHint = (currentPhase: Phase) =>
    currentPhase === "pattern1"
      ? `P1ヒント: 出席確認、リアクション、定型回答、会社へ聞く質問の順で内容を確認してください。言い方よりも、今は何の練習をしているのかを意識して進めるのがポイントです。 / ${getCandidateLevelStatusText()}`
      : currentPhase === "pattern2"
        ? `P2ヒント: あいさつ、会社説明、自己紹介、担当補足、企業からの説明、面接質問、学生退室の流れです。各ターンで次に確認したい内容をつないでください。 / ${getCandidateLevelStatusText()}`
        : `P3ヒント: 印象確認、結果時期、内定通知書や必要書類、ビザ説明、返送期限、クロージングの順で確認すると自然です。 / ${getCandidateLevelStatusText()}`;
  const buildCueBlock = (title: string, cues: string[]) =>
    cues.length === 0 ? "" : `\n[${title}]\n- ${cues.join("\n- ")}`;
  const containsAny = (text: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));
  const isQuestionLike = (text: string) =>
    /[?？]|ですか|ますか|でしょうか|どう|何|なに|どこ|いつ|なぜ|どうして|どのよう|どんな|できますか|ありますか|いいですか/.test(
      text
    );
  const getCandidateQuestionExamples = () => [
    "外国人の先輩はいますか？",
    "将来リーダーになれますか？",
    "入社前に勉強することはありますか？",
    "仕事の時に大切なことはありますか？"
  ];
  const isPattern1AttendancePrompt = (text: string) =>
    containsAny(text, [/出席/, /返事/, /名前を呼/, /呼ばれたら/, /呼んだら/, /呼びます/]);
  const isPattern1ReactionPrompt = (text: string) =>
    containsAny(text, [/リアクション/, /相槌/, /あいづち/, /うんうん/, /うなず/]);
  const isPattern1GoodQuestionGeneratePrompt = (text: string) =>
    containsAny(text, [
      /どのような質問.*(したい|いい|考)/,
      /どんな質問.*(したい|いい|考)/,
      /例えば.*質問/,
      /質問.*一つ考/,
      /質問.*一つ言/,
      /いい質問.*何/,
      /会社へ質問する内容.*考/,
      /会社に質問する内容.*考/,
      /最後に.*会社へ質問/,
      /最後に.*会社に質問/,
      /質問ありますか/,
      /何か質問.*ありますか/
    ]);
  const isPattern1GoodQuestionFeedbackPrompt = (text: string) =>
    containsAny(text, [
      /いいですね/,
      /そのように/,
      /質問しましょう/,
      /覚えて/,
      /聞かれたら/,
      /その質問/,
      /こういう質問/
    ]) &&
    containsAny(text, [/質問/, /聞きたいこと/, /会社へ質問/, /会社に質問/]);
  const isPattern1WorkIntentPrompt = (text: string) =>
    containsAny(text, [
      /どれくらい働きたい/,
      /いつまで働きたい/,
      /日本でどれくらい/,
      /日本でずっと働きたい/
    ]);
  const isPattern1EffortPrompt = (text: string) =>
    containsAny(text, [
      /大変.*大丈夫/,
      /頑張れます/,
      /頑張れる/,
      /大丈夫ですか/,
      /大丈夫です.*頑張ります/
    ]);
  const isStrongEffortConfirmationPrompt = (text: string) =>
    containsAny(text, [
      /皆さん.*大丈夫ですか.*頑張れますか/,
      /お仕事.*大変.*大丈夫ですか.*頑張れますか/,
      /大変な時でも大丈夫ですか.*頑張れますか/,
      /大丈夫ですか.*頑張れますか/
    ]);
  const isExplicitDrillAnswerPrompt = (text: string) =>
    containsAny(text, [
      /と答えましょう/,
      /と答えて/,
      /と答えるようにしましょう/,
      /と答えるように/,
      /といいましょう/,
      /と言いましょう/,
      /と言うようにしましょう/,
      /と言うように/,
      /こう答え/,
      /なんと答えますか/,
      /どのように答えますか/,
      /どう答えますか/
    ]);
  const getDefaultPattern1Mode = (): CandidateResponseMode => {
    switch (pattern1Stage) {
      case "attendance":
        return "attendance";
      case "reaction":
        return "reaction";
      case "work_intent":
        return "fixed_work_intent";
      case "effort":
        return "fixed_effort";
      case "good_question":
        return "good_question";
      default:
        return "acknowledge";
    }
  };
  const advancePattern1Stage = (mode: CandidateResponseMode) => {
    switch (mode) {
      case "attendance":
        pattern1Stage = "reaction";
        break;
      case "reaction":
        pattern1Stage = "work_intent";
        break;
      case "fixed_work_intent":
        pattern1Stage = "effort";
        break;
      case "fixed_effort":
        pattern1Stage = "good_question";
        break;
      case "good_question":
        pattern1Stage = "complete";
        break;
      default:
        break;
    }
  };
  const classifyPattern1DirectiveByRules = (
    text: string
  ): { mode: CandidateResponseMode | null; confidence: "high" | "medium" | "low" } => {
    const normalized = normalizeText(text);
    const isDrillAnswerPrompt = isExplicitDrillAnswerPrompt(normalized);
    if (!normalized) {
      return { mode: "acknowledge", confidence: "high" };
    }
    if (isPattern1ReactionPrompt(normalized)) {
      return { mode: "reaction", confidence: "high" };
    }
    if (
      isPattern1WorkIntentPrompt(normalized) &&
      (isDrillAnswerPrompt || /聞かれたら|質問練習|練習/.test(normalized) || pattern1Stage === "work_intent")
    ) {
      return {
        mode: isDrillAnswerPrompt || pattern1Stage !== "complete"
          ? "fixed_work_intent"
          : "answer_question",
        confidence: "high"
      };
    }
    if (
      isPattern1EffortPrompt(normalized) &&
      (isDrillAnswerPrompt || /聞かれたら|質問練習|練習/.test(normalized) || pattern1Stage === "effort")
    ) {
      return {
        mode: isDrillAnswerPrompt || pattern1Stage !== "complete"
          ? "fixed_effort"
          : "answer_question",
        confidence: "high"
      };
    }
    if (
      isPattern1GoodQuestionFeedbackPrompt(normalized) &&
      (pattern1Stage === "good_question" || pattern1Stage === "complete")
    ) {
      return { mode: "acknowledge", confidence: "high" };
    }
    if (isPattern1GoodQuestionGeneratePrompt(normalized)) {
      return { mode: "good_question", confidence: "high" };
    }
    if (isPattern1AttendancePrompt(normalized)) {
      return { mode: "attendance", confidence: "high" };
    }
    if (
      containsAny(normalized, [
        /仕事内容|企業|会社|仕事|雰囲気|説明/,
        /いいですね/,
        /見つけやすい/,
        /印象になります/,
        /覚えておいて/,
        /言わないように/,
        /聞かないように/,
        /練習です/,
        /しましょう/
      ])
    ) {
      return { mode: "acknowledge", confidence: "medium" };
    }
    if (isQuestionLike(normalized)) {
      return { mode: null, confidence: "low" };
    }
    return { mode: "acknowledge", confidence: "medium" };
  };
  const classifyPattern1DirectiveWithAi = async (
    text: string,
    defaultMode: CandidateResponseMode
  ): Promise<{
    mode: CandidateResponseMode;
    confidence: "high" | "medium" | "low";
  }> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1800);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: OPENAI_ROUTING_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You classify the sales representative's latest Japanese utterance in pattern1 pre-interview practice. Return strict JSON with keys mode and confidence. mode must be one of: attendance, reaction, fixed_work_intent, fixed_effort, good_question, acknowledge, answer_question. confidence must be one of: high, medium, low. Choose fixed_work_intent when the sales representative is teaching or practicing the answer meaning 「日本でずっと働きたいです」. Choose fixed_effort when the sales representative is teaching or practicing the answer meaning 「大丈夫です。頑張ります」. Choose reaction for nodding/aizuchi practice. Choose attendance for name-call / reply practice. Choose good_question when they are asking for a good company question. Choose acknowledge for explanations, praise, or instructions that only need a short acknowledgement. Choose answer_question only when the candidate should answer a genuine question freely rather than repeat a taught phrase."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase: "pattern1",
                pattern1Stage,
                defaultMode,
                utterance: text
              })
            }
          ]
        })
      });
      if (!response.ok) {
        return { mode: defaultMode, confidence: "low" };
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as {
        mode?: CandidateResponseMode;
        confidence?: "high" | "medium" | "low";
      };
      const modeOptions: CandidateResponseMode[] = [
        "attendance",
        "reaction",
        "fixed_work_intent",
        "fixed_effort",
        "good_question",
        "acknowledge",
        "answer_question"
      ];
      const mode = modeOptions.includes(parsed.mode as CandidateResponseMode)
        ? (parsed.mode as CandidateResponseMode)
        : defaultMode;
      const confidence =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "low";
      return { mode, confidence };
    } catch {
      return { mode: defaultMode, confidence: "low" };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const resolvePattern1DirectiveMode = async (
    text: string
  ): Promise<CandidateResponseMode> => {
    const ruleResult = classifyPattern1DirectiveByRules(text);
    if (ruleResult.mode && ruleResult.confidence !== "low") {
      return ruleResult.mode;
    }
    const defaultMode = getDefaultPattern1Mode();
    const aiResult = await classifyPattern1DirectiveWithAi(text, defaultMode);
    if (aiResult.confidence === "high" || aiResult.confidence === "medium") {
      return aiResult.mode;
    }
    return defaultMode;
  };
  const validateCandidateResponseWithAi = async (input: {
    salesText: string;
    normalizedPrompt: string;
    mode: CandidateResponseMode | null;
    candidateAnswer: string;
  }): Promise<{
    verdict: "accept" | "retry";
    confidence: "high" | "medium" | "low";
    suggestedMode?: CandidateResponseMode;
    reason?: string;
  }> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2200);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: OPENAI_ROUTING_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You validate whether the candidate AI's latest Japanese reply is natural and coherent given the recent conversation in an interview-practice app. Return strict JSON with keys verdict, confidence, reason, and optional suggestedMode. verdict must be accept or retry. confidence must be high, medium, or low. suggestedMode, if present, must be one of: attendance, reaction, fixed_work_intent, fixed_effort, self_intro, good_question, acknowledge, answer_question, clarify, goodbye. Choose retry when the answer clearly reacts to the wrong part of the sales representative's utterance, copies discourse markers unnaturally, answers a different question, or breaks the conversation flow. Be tolerant of broken Japanese, short fragments, and natural variation."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase,
                pattern1Stage,
                industry: getCurrentIndustryScenario().label,
                candidateLevel: candidateLanguageLevel,
                mode: input.mode,
                latestSalesUtterance: input.salesText,
                normalizedPrompt: input.normalizedPrompt,
                candidateAnswer: input.candidateAnswer,
                recentHistory: getRecentConversationHistory()
              })
            }
          ]
        })
      });
      if (!response.ok) {
        return { verdict: "accept", confidence: "low" };
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as {
        verdict?: "accept" | "retry";
        confidence?: "high" | "medium" | "low";
        suggestedMode?: CandidateResponseMode;
        reason?: string;
      };
      const verdict =
        parsed.verdict === "retry" || parsed.verdict === "accept"
          ? parsed.verdict
          : "accept";
      const confidence =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "low";
      const allowedModes: CandidateResponseMode[] = [
        "attendance",
        "reaction",
        "fixed_work_intent",
        "fixed_effort",
        "self_intro",
        "good_question",
        "acknowledge",
        "answer_question",
        "clarify",
        "goodbye"
      ];
      const suggestedMode = allowedModes.includes(
        parsed.suggestedMode as CandidateResponseMode
      )
        ? (parsed.suggestedMode as CandidateResponseMode)
        : undefined;
      return {
        verdict,
        confidence,
        suggestedMode,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined
      };
    } catch {
      return { verdict: "accept", confidence: "low" };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const buildPattern1Directive = (
    mode: CandidateResponseMode,
    isDrillAnswerPrompt: boolean
  ): { mode: CandidateResponseMode; instructions: string[] } => {
    switch (mode) {
      case "attendance":
        return {
          mode,
          instructions: ["短く明るく「はい！」と返事する。"]
        };
      case "reaction":
        return {
          mode,
          instructions: ["短い相槌で返す。例: 「はい」「うんうん」"]
        };
      case "fixed_work_intent":
        return {
          mode,
          instructions: [
            isDrillAnswerPrompt
              ? "練習の定型として「日本でずっと働きたいです」とそのまま答える。"
              : "意味は「日本でずっと働きたいです」に寄せて短く答える。",
            "10年などの具体年数は言わない。"
          ]
        };
      case "fixed_effort":
        return {
          mode,
          instructions: [
            isDrillAnswerPrompt
              ? "練習の定型として「大丈夫です！頑張ります！」とそのまま答える。"
              : "意味は「大丈夫です」「頑張ります」に寄せて短く答える。"
          ]
        };
      case "good_question":
        return {
          mode,
          instructions: [
            "会社に聞く良い質問を1つだけ、そのまま質問文で答える。",
            `例: ${getCandidateQuestionExamples().join(" / ")}`,
            "説明への相槌だけで終わらない。"
          ]
        };
      case "answer_question":
        return {
          mode,
          instructions: [
            "質問が来ているので、相槌ではなく短い答えを返す。",
            "メッセージに説明と質問が両方ある場合は、質問への答えを優先する。"
          ]
        };
      case "acknowledge":
      default:
        return {
          mode: "acknowledge",
          instructions: [
            "今は営業担当の説明や補足を聞いている場面。短く自然に受ける。",
            "例: 「はい」「わかりました」「ありがとうございます」"
          ]
        };
    }
  };
  const buildPhaseAwareDirective = (
    mode: CandidateResponseMode,
    currentPhase: Phase,
    isDrillAnswerPrompt: boolean
  ): { mode: CandidateResponseMode; instructions: string[] } => {
    if (currentPhase === "pattern1") {
      return buildPattern1Directive(mode, isDrillAnswerPrompt);
    }

    switch (mode) {
      case "goodbye":
        return {
          mode,
          instructions: ["短くお礼して退出する。その後は話し続けない。"]
        };
      case "self_intro":
        return {
          mode,
          instructions: [
            "自己紹介を短くする。名前 + 出身 + 少しの経験で十分。",
            "文の最初は必ず自分の名前から始める。",
            "「まずは」「それでは」「はい」「よろしく」など、営業担当の言い回しを繰り返さない。"
          ]
        };
      case "fixed_work_intent":
        return {
          mode,
          instructions: [
            isDrillAnswerPrompt
              ? "練習の定型として「日本でずっと働きたいです」とそのまま答える。"
              : "日本で長く働きたい意思を短く伝える。「日本でずっと働きたいです」に近い意味なら少し言い回しが揺れてよい。"
          ]
        };
      case "fixed_effort":
        return {
          mode,
          instructions: [
            isDrillAnswerPrompt
              ? "練習の定型として「大丈夫です！頑張ります！」とそのまま答える。"
              : "大変でも働ける意思を短く伝える。「大丈夫です」「頑張ります」に近い意味なら少し言い回しが揺れてよい。"
          ]
        };
      case "good_question":
        return {
          mode,
          instructions: [
            "会社に聞く良い質問を1つだけ、そのまま質問文で答える。",
            `例: ${getCandidateQuestionExamples().join(" / ")}`,
            "給料・引っ越し・ビザの質問は避ける。"
          ]
        };
      case "answer_question":
      case "clarify":
        return {
          mode: "answer_question",
          instructions: [
            "質問への答えを優先する。相槌だけで終わらない。",
            "メッセージに説明と質問が両方ある場合は、最後の質問へ短く答える。"
          ]
        };
      case "attendance":
        return {
          mode,
          instructions: ["短く明るく「はい！」と返事する。"]
        };
      case "reaction":
        return {
          mode,
          instructions: ["短い相槌で返す。例: 「はい」「うんうん」"]
        };
      case "acknowledge":
      default:
        return {
          mode: "acknowledge",
          instructions: [
            "今は営業担当の説明や補足を聞いている場面。短く自然に受ける。",
            "例: 「はい」「わかりました」「ありがとうございます」"
          ]
        };
    }
  };
  const inferCandidateResponseDirectiveByRules = async (
    salesText: string,
    currentPhase: Phase
  ): Promise<{ mode: CandidateResponseMode; instructions: string[] }> => {
    const normalized = normalizeText(salesText);
    const isDrillAnswerPrompt = isExplicitDrillAnswerPrompt(normalized);

    if (currentPhase === "pattern2" && isStrongEffortConfirmationPrompt(normalized)) {
      return buildPhaseAwareDirective("fixed_effort", currentPhase, true);
    }

    if (pendingCandidateRetry) {
      return {
        mode: "answer_question",
        instructions: [
          "これは営業担当が言い換えた再質問。今は短く具体的に答えることを最優先する。",
          getIntentRetryHint(pendingCandidateRetryIntent),
          "わかる範囲でそのまま答える。説明への相槌だけで終わらない。"
        ]
      };
    }

    if (currentPhase === "pattern1") {
      const ruleResult = classifyPattern1DirectiveByRules(salesText);
      const resolvedMode =
        ruleResult.mode && ruleResult.confidence !== "low"
          ? ruleResult.mode
          : getDefaultPattern1Mode();
      return buildPattern1Directive(resolvedMode, isDrillAnswerPrompt);
    }

    if (containsAny(normalized, [/退出|退室|ありがとうございました|失礼します/])) {
      return buildPhaseAwareDirective(
        "goodbye",
        currentPhase,
        isDrillAnswerPrompt
      );
    }
    if (looksLikeSelfIntroRequest(normalized) || /お名前/.test(normalized)) {
      return buildPhaseAwareDirective(
        "self_intro",
        currentPhase,
        isDrillAnswerPrompt
      );
    }
    if (containsAny(normalized, [/どれくらい働きたい|いつまで働きたい|日本でどれくらい/])) {
      return buildPhaseAwareDirective(
        isDrillAnswerPrompt ? "fixed_work_intent" : "answer_question",
        currentPhase,
        isDrillAnswerPrompt
      );
    }
    if (containsAny(normalized, [/大変.*大丈夫|頑張れます|頑張れる|大丈夫ですか/])) {
      return buildPhaseAwareDirective(
        isDrillAnswerPrompt ? "fixed_effort" : "answer_question",
        currentPhase,
        isDrillAnswerPrompt
      );
    }
    if (
      containsAny(normalized, [
        /どのような質問/,
        /どんな質問/,
        /例えば.*質問/,
        /質問.*一つ/,
        /会社へ質問/,
        /何か質問/
      ])
    ) {
      return buildPhaseAwareDirective(
        "good_question",
        currentPhase,
        isDrillAnswerPrompt
      );
    }
    if (isQuestionLike(normalized)) {
      return buildPhaseAwareDirective(
        "answer_question",
        currentPhase,
        isDrillAnswerPrompt
      );
    }
    return buildPhaseAwareDirective(
      "acknowledge",
      currentPhase,
      isDrillAnswerPrompt
    );
  };
  const shouldUseAiForCandidateDirective = (
    salesText: string,
    currentPhase: Phase,
    mode: CandidateResponseMode
  ) => {
    if (pendingCandidateRetry) return false;
    const normalized = normalizeText(salesText);
    if (!normalized) return false;
    const sentenceCount = salesText
      .split(/[。！？!?]/)
      .map((part) => part.trim())
      .filter(Boolean).length;
    const hasExplanationMarkers = containsAny(normalized, [
      /いいですね/,
      /ありがとうございます/,
      /わかりました/,
      /説明/,
      /印象/,
      /覚えて/,
      /しましょう/,
      /そのように/,
      /練習/,
      /例/
    ]);
    const hasQuestionMarkers =
      isQuestionLike(normalized) ||
      containsAny(normalized, [
        /どんな質問/,
        /どのような質問/,
        /聞きたいこと/,
        /何か質問/,
        /どう答え/,
        /と答え/
      ]);
    const hasMixedSignals = hasExplanationMarkers && hasQuestionMarkers;
    if (currentPhase === "pattern1") {
      return (
        hasMixedSignals ||
        sentenceCount >= 2 ||
        normalized.length >= 28 ||
        mode === "good_question" ||
        mode === "acknowledge"
      );
    }
    if (
      currentPhase === "pattern2" &&
      mode === "fixed_effort" &&
      isStrongEffortConfirmationPrompt(normalized)
    ) {
      return false;
    }
    if (
      currentPhase === "pattern2" &&
      mode === "answer_question" &&
      isQuestionLike(normalized) &&
      !containsAny(normalized, [
        /いいですね/,
        /覚えて/,
        /しましょう/,
        /練習/,
        /そのように/,
        /例:/,
        /と答え/
      ])
    ) {
      return false;
    }
    return (
      hasMixedSignals &&
      (mode === "acknowledge" ||
        mode === "answer_question" ||
        mode === "good_question")
    );
  };
  const classifyCandidateDirectiveWithAi = async (
    salesText: string,
    currentPhase: Phase,
    defaultMode: CandidateResponseMode,
    defaultPrompt: string
  ): Promise<{
    mode: CandidateResponseMode;
    normalizedPrompt: string;
    confidence: "high" | "medium" | "low";
  }> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: OPENAI_ROUTING_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You classify how the candidate AI should respond to the sales representative's latest Japanese utterance in an interview-practice app. Return strict JSON with keys mode, normalizedPrompt, confidence. mode must be one of: attendance, reaction, fixed_work_intent, fixed_effort, self_intro, good_question, acknowledge, answer_question, clarify, goodbye. confidence must be high, medium, or low. normalizedPrompt must be a short Japanese candidate-facing prompt that strips discourse markers and focuses only on what the candidate should react to. Use the recent conversation to decide whether the utterance is teaching, praising, asking a new question, or only requiring a short acknowledgement. Prefer acknowledge for praise, feedback, examples, or explanations that do not require a new substantive answer."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase: currentPhase,
                pattern1Stage,
                candidateLevel: candidateLanguageLevel,
                industry: getCurrentIndustryScenario().label,
                pendingCandidateRetry,
                lastInterviewerIntent,
                defaultMode,
                defaultPrompt,
                latestSalesUtterance: salesText,
                recentHistory: getRecentConversationHistory()
              })
            }
          ]
        })
      });
      if (!response.ok) {
        return {
          mode: defaultMode,
          normalizedPrompt: defaultPrompt,
          confidence: "low"
        };
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as {
        mode?: CandidateResponseMode;
        normalizedPrompt?: string;
        confidence?: "high" | "medium" | "low";
      };
      const allowedModes: CandidateResponseMode[] = [
        "attendance",
        "reaction",
        "fixed_work_intent",
        "fixed_effort",
        "self_intro",
        "good_question",
        "acknowledge",
        "answer_question",
        "clarify",
        "goodbye"
      ];
      const mode = allowedModes.includes(parsed.mode as CandidateResponseMode)
        ? (parsed.mode as CandidateResponseMode)
        : defaultMode;
      const confidence =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "low";
      const normalizedPrompt =
        typeof parsed.normalizedPrompt === "string" &&
        parsed.normalizedPrompt.trim()
          ? parsed.normalizedPrompt.trim()
          : defaultPrompt;
      return { mode, normalizedPrompt, confidence };
    } catch {
      return {
        mode: defaultMode,
        normalizedPrompt: defaultPrompt,
        confidence: "low"
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const shouldReviewCandidateDirectiveCoherence = (
    salesText: string,
    currentPhase: Phase,
    mode: CandidateResponseMode
  ) => {
    const normalized = normalizeText(salesText);
    if (!normalized) return false;
    if (currentPhase === "pattern1") {
      return (
        mode === "good_question" ||
        pattern1Stage === "good_question" ||
        pattern1Stage === "complete" ||
        containsAny(normalized, [
          /いいですね/,
          /そのように/,
          /質問しましょう/,
          /覚えて/,
          /聞きたいこと/,
          /どんな質問/
        ])
      );
    }
    return false;
  };
  const reviewCandidateDirectiveCoherenceWithAi = async (
    salesText: string,
    currentPhase: Phase,
    proposedMode: CandidateResponseMode,
    proposedPrompt: string
  ): Promise<{
    mode: CandidateResponseMode;
    normalizedPrompt: string;
    confidence: "high" | "medium" | "low";
  }> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 900);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: OPENAI_ROUTING_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You review whether the proposed candidate response mode is coherent with the recent Japanese conversation in an interview-practice app. Return strict JSON with keys mode, normalizedPrompt, confidence. mode must be one of: attendance, reaction, fixed_work_intent, fixed_effort, self_intro, good_question, acknowledge, answer_question, clarify, goodbye. confidence must be high, medium, or low. If the candidate has already answered the drill and the sales representative is now praising, giving an example, reinforcing, or wrapping up the point, revise the mode to acknowledge. Only keep good_question when the sales representative is clearly asking the candidate to generate a new company question right now."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase: currentPhase,
                pattern1Stage,
                proposedMode,
                proposedPrompt,
                latestSalesUtterance: salesText,
                recentHistory: getRecentConversationHistory()
              })
            }
          ]
        })
      });
      if (!response.ok) {
        return {
          mode: proposedMode,
          normalizedPrompt: proposedPrompt,
          confidence: "low"
        };
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as {
        mode?: CandidateResponseMode;
        normalizedPrompt?: string;
        confidence?: "high" | "medium" | "low";
      };
      const allowedModes: CandidateResponseMode[] = [
        "attendance",
        "reaction",
        "fixed_work_intent",
        "fixed_effort",
        "self_intro",
        "good_question",
        "acknowledge",
        "answer_question",
        "clarify",
        "goodbye"
      ];
      const mode = allowedModes.includes(parsed.mode as CandidateResponseMode)
        ? (parsed.mode as CandidateResponseMode)
        : proposedMode;
      const confidence =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "low";
      const normalizedPrompt =
        typeof parsed.normalizedPrompt === "string" &&
        parsed.normalizedPrompt.trim()
          ? parsed.normalizedPrompt.trim()
          : proposedPrompt;
      return { mode, normalizedPrompt, confidence };
    } catch {
      return {
        mode: proposedMode,
        normalizedPrompt: proposedPrompt,
        confidence: "low"
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const inferCandidateResponseDirective = async (
    salesText: string,
    currentPhase: Phase
  ): Promise<{
    mode: CandidateResponseMode;
    instructions: string[];
    normalizedPrompt: string;
  }> => {
    const normalized = normalizeText(salesText);
    const isDrillAnswerPrompt = isExplicitDrillAnswerPrompt(normalized);
    const ruleDirective = await inferCandidateResponseDirectiveByRules(
      salesText,
      currentPhase
    );
    const defaultPrompt = normalizeSalesInputForCandidate(
      salesText,
      ruleDirective
    );

    let resolvedMode = ruleDirective.mode;
    let resolvedPrompt = defaultPrompt;

    if (
      shouldUseAiForCandidateDirective(
        salesText,
        currentPhase,
        ruleDirective.mode
      )
    ) {
      const aiDirective = await classifyCandidateDirectiveWithAi(
        salesText,
        currentPhase,
        ruleDirective.mode,
        defaultPrompt
      );
      if (aiDirective.confidence === "high" || aiDirective.confidence === "medium") {
        resolvedMode = aiDirective.mode;
        resolvedPrompt = aiDirective.normalizedPrompt;
        console.log(
          `[CandidateDirectiveAI] phase=${currentPhase} mode=${ruleDirective.mode}->${aiDirective.mode} confidence=${aiDirective.confidence} prompt="${aiDirective.normalizedPrompt}" text="${salesText}"`
        );
      }
    }

    if (
      shouldReviewCandidateDirectiveCoherence(
        salesText,
        currentPhase,
        resolvedMode
      )
    ) {
      const reviewed = await reviewCandidateDirectiveCoherenceWithAi(
        salesText,
        currentPhase,
        resolvedMode,
        resolvedPrompt
      );
      if (reviewed.confidence === "high" || reviewed.confidence === "medium") {
        console.log(
          `[CandidateDirectiveReview] phase=${currentPhase} mode=${resolvedMode}->${reviewed.mode} confidence=${reviewed.confidence} prompt="${reviewed.normalizedPrompt}" text="${salesText}"`
        );
        resolvedMode = reviewed.mode;
        resolvedPrompt = reviewed.normalizedPrompt;
      }
    }

    const resolvedDirective = buildPhaseAwareDirective(
      resolvedMode,
      currentPhase,
      isDrillAnswerPrompt
    );
    return {
      ...resolvedDirective,
      normalizedPrompt: resolvedPrompt
    };
  };
  const getCandidateCueLines = (salesText: string, currentPhase: Phase) => {
    const normalized = normalizeText(salesText);
    const cues: string[] = [];

    if (currentPhase === "pattern1") {
      if (isPattern1ReactionPrompt(normalized)) {
        cues.push("今はリアクション練習。短く「はい」「うんうん」などの相槌で返す。");
      }
      if (isPattern1AttendancePrompt(normalized)) {
        cues.push("今は出席確認。名前を呼ばれたら短く明るく「はい！」と返事する。");
      }
      if (isPattern1WorkIntentPrompt(normalized)) {
        cues.push(
          isExplicitDrillAnswerPrompt(normalized)
            ? "今は練習の定型。「日本でずっと働きたいです」とそのまま答える。10年など具体年数は言わない。"
            : "意味は「日本で長く働きたい」に寄せる。言い回しは少し揺れてよいが、具体年数は言わない。"
        );
      }
      if (isPattern1EffortPrompt(normalized)) {
        cues.push(
          isExplicitDrillAnswerPrompt(normalized)
            ? "今は練習の定型。「大丈夫です！頑張ります！」とそのまま答える。"
            : "意味は「大丈夫」「頑張れる」に寄せる。言い回しは少し揺れてよい。"
        );
      }
      if (isPattern1GoodQuestionGeneratePrompt(normalized)) {
        cues.push("会社への質問は1つだけ。外国人の先輩、リーダー、入社前勉強、仕事で大切なこと、のような良い質問を選ぶ。");
        cues.push("給料、引っ越し補助、ビザサポートなど自分本位な質問はしない。");
      }
      if (isPattern1GoodQuestionFeedbackPrompt(normalized)) {
        cues.push("今は質問練習へのフィードバック。新しい質問は作らず、「はい」「わかりました」で受ける。");
      }
      if (containsAny(normalized, [/仕事内容|企業|会社|仕事|雰囲気|説明/])) {
        cues.push("仕事内容の説明を聞く場面。短い相槌や「はい、ありがとうございます」で自然に受ける。");
      }
      if (
        containsAny(normalized, [
          /いいですね/,
          /見つけやすい/,
          /印象になります/,
          /覚えておいて/,
          /言わないように/,
          /聞かないように/,
          /練習です/,
          /しましょう/
        ])
      ) {
        cues.push("今は営業担当の補足説明。短く「はい」「わかりました」「ありがとうございます」で受ける。");
      }
    }

    if (currentPhase === "pattern2") {
      if (containsAny(normalized, [/自己紹介|お名前|名前|紹介/])) {
        cues.push("自己紹介は短く、名前 + 出身 + 少しの経験で答える。");
      }
      if (containsAny(normalized, [/どれくらい働きたい|いつまで働きたい|日本でどれくらい/])) {
        cues.push("意味は「日本で長く働きたい」に寄せる。言い回しは少し揺れてよい。");
      }
      if (containsAny(normalized, [/大変.*大丈夫|頑張れます|頑張れる|大丈夫ですか/])) {
        cues.push("意味は「大丈夫です」「頑張ります」に寄せる。言い回しは少し揺れてよい。");
      }
      if (containsAny(normalized, [/質問あります|聞きたいこと|何か質問/])) {
        cues.push("会社への質問は1つだけ。良い質問を選び、給料・引っ越し・ビザは避ける。");
      }
      if (containsAny(normalized, [/退出|退室|ありがとうございました|失礼します/])) {
        cues.push("退室の流れ。短くお礼して退出し、その後は発話しない。");
      }
    }

    return cues;
  };
  const getInterviewerCueLines = (salesText: string, currentPhase: Phase) => {
    const normalized = normalizeText(salesText);
    const cues: string[] = [];

    if (currentPhase === "pattern2") {
      if (shouldRequestPattern3ExitApproval(salesText)) {
        cues.push("ここは学生を先に退出させてからビザや許可率の話をしたい、という許可確認。");
        cues.push("短く承諾だけ返す。例: 「承知しました。それでは、どうぞお声がけください。」");
        cues.push("このターンでは締めに入らない。「本日は以上」「ご退出ください」などは言わない。");
      }
      if (
        introPhase === "student_intro_permission" &&
        shouldPromptStudentIntroApproval(salesText)
      ) {
        cues.push("ここは学生自己紹介の許可だけを返す場面。短く「お願いします！」と返す。");
        cues.push("まだ会社説明や質問には入らない。次は営業が学生の名前を呼ぶ。");
      }
      if (introPhase === "sales_supplement") {
        cues.push("ここは学生自己紹介と営業補足を受けた直後。短く「ありがとうございます。」とだけ返す。");
        cues.push("まだ会社説明や質問には入らない。次は営業から会社説明の依頼を待つ。");
      }
      if (introPhase === "company_wait_request") {
        cues.push("営業から会社説明の依頼が来るまで待つ。自分から説明や質問を始めない。");
      }
      if (introPhase === "company_overview" && shouldPromptCompanyOverviewRequest(salesText)) {
        cues.push("最初に短く「ありがとうございます。」と受ける。");
        cues.push("続けて「では私も自己紹介をさせていただきます。採用担当の田中と申します。」のように自己紹介へ入る。");
        cues.push("このターンでは会社説明だけにとどめ、具体的な質問には入らない。");
      }
      if (introPhase === "sales_intro" && shouldPromptInitialCompanyGreeting(salesText)) {
        cues.push("ここは会社側の最初のあいさつ。短く「よろしくお願いします。」程度で返す。");
        cues.push("まだ会社説明や質問には入らない。次は営業が学生へ自己紹介を促すのを待つ。");
      }
      if (introPhase === "company_ack" && shouldPromptCompanyIntroAcknowledgement(salesText)) {
        cues.push("ここは営業側の会社説明に対する受け返し。短く「はい、ありがとうございます。」と返す。");
        cues.push("まだ会社説明や学生への質問は始めない。次は営業が学生自己紹介の許可を確認するのを待つ。");
      }
      if (containsAny(normalized, [/仕事内容|仕事の流れ|雰囲気|会社説明|事業所紹介|ご説明/])) {
        cues.push("仕事内容、1日の流れ、職場の雰囲気を簡潔に説明する。");
      }
      if (containsAny(normalized, [/お聞きしたいこと|質問したいこと|聞きたいこと.*ジョン|ジョン.*聞きたいこと|ジョン.*質問/])) {
        cues.push("ここから質問ターン。候補者に対する最初の具体的な質問を1つ短く始める。");
      }
      if (containsAny(normalized, [/お伝えしたいこと|特に大丈夫/])) {
        cues.push("締めの場面では、簡潔に前向きな一言で返す。例: 「特に大丈夫です。皆さんと一緒に働けるのを楽しみにしています。」");
      }
      cues.push("学生へ直接主導せず、営業担当が進行役である前提を守る。");
    }

    if (currentPhase === "pattern3") {
      if (isPattern3ImpressionPrompt(salesText)) {
        cues.push("印象ベースで自然に答える。「難しい」「良い悪い」を軸にしない。");
        cues.push("「承知しました」「かしこまりました」から始めず、「ありがとうございます」または印象の本題から自然に入る。");
        cues.push("未決定なら「社内で検討して改めて連絡する」といった協力的な返しでよい。");
      }
      if (isPattern3ResultTimingPrompt(salesText)) {
        cues.push("結果連絡はできるだけ2〜3日以内で協力的に返す。");
      }
      if (isPattern3RequiredDocsPrompt(salesText)) {
        cues.push("必要書類の案内には協力的に返し、準備する姿勢を示す。");
        cues.push("このターンでは雛形送付の依頼には進まず、『必要書類の準備をしていきます』程度で止める。");
      }
      if (isPattern3OfferDocumentPrompt(salesText)) {
        cues.push("内定通知書や雛形のやり取りには協力的に答える。自社書式か雛形送付のどちらかを選ぶ。");
        cues.push("easyでは雛形送付を依頼する返しが無難。");
      }
      if (isPattern3VisaOutcomePrompt(salesText)) {
        cues.push("ビザ結果の時期や許可率の説明には理解を示し、採用枠や他候補も含めて検討する旨を短く返す。");
        cues.push("このターンではキャリアアップの話には進まない。");
      }
      if (isPattern3VisaExplanationPrompt(salesText)) {
        cues.push("技人国ビザの説明には理解を示し、将来の管理業務やキャリアアップの可能性を前向きに返す。");
        cues.push("このターンでは短く「かしこまりました。将来的にキャリアアップも考えています。」程度で止める。");
      }
      if (isPattern3CareerPathPrompt(salesText)) {
        cues.push("将来どのようなキャリアアップを想定しているか、1〜2個の具体例で短く答える。");
        cues.push("自然さのため、「キャリアアップについてですが、例えば…」のように話題名を一度置いてから具体例に入る。");
      }
      if (isPattern3DeadlinePrompt(salesText)) {
        cues.push("返送期限の打診には、可能な範囲で本日中/明日中に寄せて協力的に返す。");
      }
      if (isPattern3ClosingPrompt(salesText)) {
        cues.push("締めの最後は丁寧に応じ、「【面接終了】」で終える。");
      }
    }

    return cues;
  };
  const summarizeCandidateQuestionFocus = (salesText: string) => {
    const normalized = normalizeText(salesText);
    const scenario = getCurrentIndustryScenario();
    if (
      containsAny(normalized, [
        /自己紹介|お名前|名前|紹介/
      ])
    ) {
      return "自己紹介だけを短く答える。";
    }
    if (
      containsAny(normalized, [
        new RegExp(scenario.experienceKeywords.join("|")),
        /経験|前職|業務|担当|仕事|何をして|どのような仕事/
      ])
    ) {
      return "これまでの仕事内容や担当したことを短く答える。";
    }
    if (containsAny(normalized, [/志望|理由|動機|なぜ|きっかけ|やりたい|興味/])) {
      return "その仕事をしたい理由やきっかけを短く答える。";
    }
    if (containsAny(normalized, [/日本語|会話|コミュニケーション|話せ|使え|勉強/])) {
      return "日本語をどのくらい使えるか、どこで使っているかを短く答える。";
    }
    if (containsAny(normalized, [/シフト|夜勤|曜日|週|何日|勤務時間|時間帯|働ける/])) {
      return "働ける日数、曜日、夜勤、時間帯を短く答える。";
    }
    if (containsAny(normalized, [/体力|健康|腰|持病|疲れ|元気|大丈夫/])) {
      return "健康状態や体力について短く答える。";
    }
    if (containsAny(normalized, [/ビザ|在留|開始日|いつから|入社|来日|働き始め/])) {
      return "いつから働けるか、開始時期を短く答える。";
    }
    if (containsAny(normalized, [/質問あります|聞きたいこと|何か質問|会社へ質問/])) {
      return "会社に聞きたい良い質問を1つだけ言う。";
    }
    return null;
  };
  const extractCandidateQuestionSnippet = (salesText: string) => {
    const sentences = salesText
      .split(/[。！？!?]/)
      .map((part) => part.trim())
      .filter(Boolean);
    const candidateSentence =
      [...sentences].reverse().find((part) =>
        /ですか|ますか|でしょうか|教えて|聞かせて|お願いします|してください/.test(
          part
        )
      ) ?? sentences.at(-1);
    if (!candidateSentence) return null;
    return candidateSentence
      .replace(/^(では|それでは|じゃあ|あと|次に|はい|ありがとうございます)\s*/g, "")
      .replace(/^[^、]{0,12}(さん|様)[、,]\s*/g, "")
      .trim();
  };
  const ensureSentenceEnding = (text: string, ending: "。" | "？" = "。") => {
    const normalized = text.trim().replace(/[。．！？!?]+$/u, "");
    if (!normalized) return "";
    return `${normalized}${ending}`;
  };
  const buildCanonicalCandidateQuestionByIntent = (
    intent: InterviewIntent | null
  ) => {
    const scenario = getCurrentIndustryScenario();
    switch (intent) {
      case "experience":
        return ensureSentenceEnding(
          scenario.id === "care"
            ? "これまでどのような介護の補助をしましたか"
            : scenario.id === "restaurant"
              ? "これまでお店でどのような仕事をしましたか"
              : "これまでホテルでどのような仕事をしましたか",
          "？"
        );
      case "motivation":
        return ensureSentenceEnding("なぜこの仕事をしたいと思いましたか", "？");
      case "language":
        return ensureSentenceEnding(
          "日本語をどのくらい使えますか。どんな場面で使っていますか"
        );
      case "shift":
        return ensureSentenceEnding(
          "1週間にどのくらい働けますか。夜勤はできますか"
        );
      case "stamina":
        return ensureSentenceEnding("体力や健康面は大丈夫ですか", "？");
      case "visa":
        return ensureSentenceEnding("いつから働けますか", "？");
      default:
        return null;
    }
  };
  const normalizeSalesInputForCandidate = (
    salesText: string,
    directive: { mode: CandidateResponseMode; instructions: string[] }
  ) => {
    const activeIntent = pendingCandidateRetryIntent ?? lastInterviewerIntent;
    const questionSnippet = stripLeadingDiscourseMarkers(
      extractCandidateQuestionSnippet(salesText) ?? "",
      { stripYes: true }
    )
      .replace(/^[^、]{0,12}(さん|様)[、,]\s*/g, "")
      .trim();

    switch (directive.mode) {
      case "attendance":
        return "返事をしてください。";
      case "reaction":
        return "短く相槌してください。";
      case "fixed_work_intent":
        return "日本でどれくらい働きたいですか。";
      case "fixed_effort":
        return "仕事が大変な時も大丈夫ですか。頑張れますか。";
      case "self_intro":
        return "自己紹介をしてください。";
      case "good_question":
        return "会社に聞きたい良い質問を1つ言ってください。";
      case "goodbye":
        return "短くお礼して退出してください。";
      case "acknowledge":
        return "営業担当の説明を聞いて、短く返してください。";
      case "answer_question":
      case "clarify": {
        if (questionSnippet && questionSnippet.length <= 44) {
          const ending = /ですか|ますか|でしょうか|教えて|聞かせて|してください|お願いします/.test(
            questionSnippet
          )
            ? "？"
            : "。";
          return ensureSentenceEnding(questionSnippet, ending);
        }
        return (
          buildCanonicalCandidateQuestionByIntent(activeIntent) ??
          "営業担当が言い換えた質問に短く答えてください。"
        );
      }
      default:
        return "営業担当の意図を理解して、短く返してください。";
    }
  };
  const buildCandidateIntentSummary = (
    salesText: string,
    directive: { mode: CandidateResponseMode; instructions: string[] }
  ) => {
    const summaryLines: string[] = [];
    switch (directive.mode) {
      case "attendance":
        summaryLines.push("今は出席確認。短く明るく返事する。");
        break;
      case "reaction":
        summaryLines.push("今はリアクション練習。短い相槌で返す。");
        break;
      case "fixed_work_intent":
        summaryLines.push("今は『日本でどれくらい働きたいか』の定型練習。");
        break;
      case "fixed_effort":
        summaryLines.push("今は『大丈夫か / 頑張れるか』の定型練習。");
        break;
      case "self_intro":
        summaryLines.push("今は自己紹介だけを求められている。");
        break;
      case "good_question":
        summaryLines.push("今は会社に聞く良い質問を1つ言う場面。");
        break;
      case "goodbye":
        summaryLines.push("今は退出や締めの流れ。短くお礼して終える。");
        break;
      case "acknowledge":
        summaryLines.push("今は営業担当の説明や補足を聞いている場面。短く受ける。");
        break;
      case "answer_question": {
        const focusSummary = summarizeCandidateQuestionFocus(salesText);
        if (focusSummary) {
          summaryLines.push(focusSummary);
        } else {
          summaryLines.push("今は営業担当が言い換えた質問に短く答える。");
        }
        const questionSnippet = extractCandidateQuestionSnippet(salesText);
        if (questionSnippet) {
          summaryLines.push(`最後に聞かれている内容: ${questionSnippet}`);
        }
        break;
      }
      default:
        summaryLines.push("営業担当の意図をくみ取り、必要な返答だけを短く返す。");
        break;
    }
    summaryLines.push("営業担当の原文や言い回しはそのまま真似しない。意味を理解して答える。");
    return summaryLines;
  };
  const stripLeadingDiscourseMarkers = (
    text: string,
    options?: { stripYes?: boolean }
  ) => {
    let current = text.trim();
    const markerPattern = options?.stripYes
      ? /^(まずは|まず|それでは|ではまず|では|じゃあ|はい[,、]?(それでは|では)?|えっと|えーと|あの|うーん)[、,\s]*/u
      : /^(まずは|まず|それでは|ではまず|では|じゃあ|えっと|えーと|あの|うーん)[、,\s]*/u;
    while (markerPattern.test(current)) {
      current = current.replace(markerPattern, "").trim();
    }
    return current;
  };
  const normalizeCandidateFinalText = (
    text: string,
    mode: CandidateResponseMode | null
  ) => {
    let normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return normalized;

    const looksLikeEnglishMetaReply = (value: string) => {
      const asciiRatio =
        (value.match(/[A-Za-z]/g)?.length ?? 0) / Math.max(value.length, 1);
      return (
        asciiRatio > 0.35 &&
        /let me know|need more help|how can i help|happy to help|anything else|if you need|sales representative|next prompt|self-introduction|wait for|before continuing|can add a supplement/i.test(
          value
        )
      );
    };

    const looksLikeLeakedInstructionReply = (value: string) =>
      /sales representative|candidate|self-introduction|next prompt|wait for their next prompt|respond only after|before continuing|can add a supplement|営業担当|次の指示|待ってください/i.test(
        value
      );

    const resolveCandidateModeFromContext = () => {
      if (mode) return mode;
      return lastCandidateRelayContext?.mode ?? null;
    };

    const effectiveMode = resolveCandidateModeFromContext();

    const buildCandidateFallbackFromContext = (currentMode: CandidateResponseMode) => {
      const normalizedPrompt = normalizeText(lastCandidateRelayContext?.normalizedPrompt ?? "");
      const salesText = normalizeText(lastCandidateRelayContext?.salesText ?? "");
      const combined = `${normalizedPrompt} ${salesText}`.trim();
      switch (currentMode) {
        case "attendance":
          return "はい！";
        case "reaction":
          return "はい。";
        case "fixed_work_intent":
          return "日本でずっと働きたいです。";
        case "fixed_effort":
          return "大丈夫です！頑張ります！";
        case "self_intro":
          return buildCandidateSelfIntroVariants()[0] ?? `${candidateName}です。`;
        case "good_question":
          return "外国人の先輩、いますか？";
        case "acknowledge":
          return "はい、わかりました。";
        case "clarify":
          return "すみません、もう一度、お願いします。";
        case "answer_question":
        default:
          if (containsAny(combined, [/大変.*大丈夫|頑張れます|頑張れる|大丈夫ですか/])) {
            return "大丈夫です！頑張ります！";
          }
          if (containsAny(combined, [/どれくらい働きたい|いつまで働きたい|日本でどれくらい/])) {
            return "日本でずっと働きたいです。";
          }
          if (containsAny(combined, [/日本語|会話|コミュニケーション|話せ|使え|勉強/])) {
            return "少し、分かる。";
          }
          if (containsAny(combined, [/シフト|夜勤|曜日|週|何日|勤務時間|時間帯|働ける/])) {
            return "はい、大丈夫です。";
          }
          if (containsAny(combined, [/体力|健康|腰|持病|疲れ|元気/])) {
            return "はい、大丈夫です。";
          }
          if (containsAny(combined, [/ビザ|在留|開始日|いつから|入社|来日|働き始め/])) {
            return "すぐ、働ける。";
          }
          if (containsAny(combined, [/志望|理由|動機|なぜ|きっかけ|やりたい|興味/])) {
            return "人、助けたい。";
          }
          if (containsAny(combined, [/経験|前職|業務|担当|仕事|何をして|どのような仕事/])) {
            return "少し、手伝った。";
          }
          return "はい。";
      }
    };

    const candidateName =
      getCurrentCandidateName() ?? getCurrentIndustryScenario().candidateProfile.name;

    if (
      effectiveMode &&
      (looksLikeEnglishMetaReply(normalized) ||
        looksLikeLeakedInstructionReply(normalized))
    ) {
      const fallback = buildCandidateFallbackFromContext(effectiveMode);
      console.log(
        `[CandidateNormalizeFallback] mode=${effectiveMode} raw="${normalized}" fallback="${fallback}"`
      );
      normalized = fallback;
    }

    if (!effectiveMode) return stripLeadingDiscourseMarkers(normalized);

    switch (effectiveMode) {
      case "attendance":
        return "はい！";
      case "reaction":
        if (/うん/.test(normalized)) return "うんうん。";
        return "はい。";
      case "fixed_work_intent":
        return "日本でずっと働きたいです。";
      case "fixed_effort":
        return "大丈夫です！頑張ります！";
      case "self_intro": {
        normalized = stripLeadingDiscourseMarkers(normalized, { stripYes: true });
        normalized = normalized.replace(/^[、,\s]+/u, "");
        normalized = normalized.replace(
          new RegExp(`^${escapeRegex(candidateName)}(?:さん)?`, "u"),
          candidateName
        );
        normalized = normalized.replace(
          new RegExp(
            `^${escapeRegex(candidateName)}(?:です)?[。．]?\\s*${escapeRegex(candidateName)}(?:です)?[。．]?\\s*`,
            "u"
          ),
          `${candidateName}です。`
        );
        if (normalized.startsWith(candidateName)) {
          normalized = normalized.replace(
            new RegExp(`^${escapeRegex(candidateName)}(?:です)?`, "u"),
            `${candidateName}です`
          );
          normalized = normalized.replace(
            new RegExp(`^${escapeRegex(candidateName)}です(?![。．])`, "u"),
            `${candidateName}です。`
          );
        } else {
          normalized = normalized.replace(/^(です|でした)[。．]?\s*/u, "");
          normalized = `${candidateName}です。${normalized}`;
        }
        return normalized;
      }
      case "good_question": {
        normalized = stripLeadingDiscourseMarkers(normalized);
        if (!/[?？]$/.test(normalized)) {
          normalized = `${normalized.replace(/[。．]+$/u, "")}？`;
        }
        return normalized;
      }
      case "acknowledge":
        if (/ありがとう/.test(normalized)) return "ありがとうございます。";
        if (/わかりました|わかった/.test(normalized)) return "はい、わかりました。";
        return stripLeadingDiscourseMarkers(normalized);
      case "goodbye":
        if (/ありがとう/.test(normalized)) return "ありがとうございます。";
        return stripLeadingDiscourseMarkers(normalized);
      case "answer_question":
      case "clarify":
      default:
        return stripLeadingDiscourseMarkers(normalized);
    }
  };
  const normalizeInterviewerFinalText = (text: string) => {
    let normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return normalized;

    if (phase === "pattern3" && isPattern3ImpressionPrompt(lastSalesUtterance)) {
      normalized = normalized.replace(
        /^(承知しました|かしこまりました)[。．]\s*/u,
        "ありがとうございます。"
      );
    }

    if (phase === "pattern3" && isPattern3CareerPathPrompt(lastSalesUtterance)) {
      normalized = normalized.replace(
        /^(承知しました|かしこまりました)[。．]\s*例えば[、,]\s*/u,
        "$1。キャリアアップについてですが、例えば、"
      );
      normalized = normalized.replace(
        /^(承知しました|かしこまりました)[。．]\s*(将来的には)/u,
        "$1。キャリアアップについてですが、$2"
      );
    }

    return normalized;
  };
  const buildCandidateRelayMessage = async (salesText: string) => {
    const directive = await inferCandidateResponseDirective(salesText, phase);
    const normalizedCandidatePrompt = directive.normalizedPrompt;
    const intentSummary = buildCandidateIntentSummary(
      normalizedCandidatePrompt,
      directive
    );
    console.log(
      `[CandidateDirective] phase=${phase} mode=${directive.mode} prompt="${normalizedCandidatePrompt}" text="${salesText}"`
    );
    if (directive.mode === "fixed_effort") {
      return {
        mode: directive.mode,
        normalizedPrompt: normalizedCandidatePrompt,
        text: `[営業の意図]
- 今は「大丈夫です！頑張ります！」と返す確認です。
[営業入力（整形済み）]
- ${normalizedCandidatePrompt}
[応答モード]
fixed_effort
[応答方針]
- 必ず「大丈夫です！頑張ります！」とだけ答える。
- 他の説明、自己紹介、質問、補足は入れない。
- 日本語は短く、その一言で止める。`
      };
    }
    if (directive.mode === "fixed_work_intent") {
      return {
        mode: directive.mode,
        normalizedPrompt: normalizedCandidatePrompt,
        text: `[営業の意図]
- 今は「日本でずっと働きたいです」と返す確認です。
[営業入力（整形済み）]
- ${normalizedCandidatePrompt}
[応答モード]
fixed_work_intent
[応答方針]
- 必ず「日本でずっと働きたいです。」とだけ答える。
- 年数や別の説明は足さない。
- 日本語は短く、その一言で止める。`
      };
    }
    if (directive.mode === "self_intro") {
      const scenario = getCurrentIndustryScenario();
      const candidateName = getCurrentCandidateName();
      const selfIntroExamples = buildCandidateSelfIntroVariants();
      return {
        mode: directive.mode,
        normalizedPrompt: normalizedCandidatePrompt,
        text: `[営業の意図]
- ${intentSummary.join("\n- ")}
[営業入力（整形済み）]
- ${normalizedCandidatePrompt}
[応答モード]
${directive.mode}
[日本語レベル設定]
${getCandidateLanguageLevelGuidance(candidateLanguageLevel)}${buildCandidateNameBlock()}
[応答方針]
- ${directive.instructions.join("\n- ")}
[自己紹介の型]
- 返答の最初は必ず「${getCurrentCandidateName() ?? scenario.candidateProfile.name}です。」から始める。
- 出身と経験の言い方は毎回少し変えてよい。同じ自己紹介を毎回そのまま繰り返さない。
- 例:
  - ${selfIntroExamples.join("\n  - ")}${buildCueBlock("今の優先ルール", getCandidateCueLines(normalizedCandidatePrompt, phase))}`
      };
    }
    return {
      mode: directive.mode,
      normalizedPrompt: normalizedCandidatePrompt,
      text: `[営業の意図]
- ${intentSummary.join("\n- ")}
[営業入力（整形済み）]
- ${normalizedCandidatePrompt}
[応答モード]
${directive.mode}
[日本語レベル設定]
${getCandidateLanguageLevelGuidance(candidateLanguageLevel)}${buildCandidateNameBlock()}
[応答方針]
- ${directive.instructions.join("\n- ")}${buildCueBlock("今の優先ルール", getCandidateCueLines(normalizedCandidatePrompt, phase))}`
    };
  };
  const buildInterviewerRelayMessage = (salesText: string) => {
    if (phase === "pattern2" && introPhase === "sales_intro" && shouldPromptInitialCompanyGreeting(salesText)) {
      return `[営業が面接冒頭のあいさつをしました]
[営業入力]
${salesText}${buildInterviewerNameBlock()}
[今の優先ルール]
- ここでは会社側として短く「よろしくお願いします。」とだけ返す。
- まだ自己紹介、会社説明、質問は始めない。`;
    }
    if (phase === "pattern2" && introPhase === "company_ack" && shouldPromptCompanyIntroAcknowledgement(salesText)) {
      return `[営業が自社説明をしました]
[営業入力]
${salesText}${buildInterviewerNameBlock()}
[今の優先ルール]
- ここでは会社側として短く「はい、ありがとうございます。」とだけ返す。
- まだ会社説明や学生への質問は始めない。次は営業が学生自己紹介の許可を確認する。`;
    }
    if (phase === "pattern2" && introPhase === "student_intro_permission" && shouldPromptStudentIntroApproval(salesText)) {
      return `[営業が学生自己紹介の許可を求めました]
[営業入力]
${salesText}${buildInterviewerNameBlock()}
[今の優先ルール]
- ここでは会社側として短く「お願いします！」とだけ返す。
- 次は営業が学生の名前を呼んで自己紹介を促す。`;
    }
    if (phase === "pattern2" && introPhase === "sales_supplement") {
      return `[営業が学生紹介の補足をしました]
[営業入力]
${salesText}${buildInterviewerNameBlock()}
[今の優先ルール]
- ここでは会社側として短く「ありがとうございます。」とだけ返す。
- まだ会社説明や質問には入らない。次は営業から会社説明の依頼を待つ。`;
    }
    return `[営業が面接官に伝えました]: ${salesText}${buildInterviewerNameBlock()}${buildCueBlock("今の優先ルール", getInterviewerCueLines(salesText, phase))}`;
  };
  const shouldRelaySalesToCandidate = (salesText: string) => {
    if (phase === "pattern1") return true;
    if (phase !== "pattern2") return false;
    if (pendingCandidateRetry || studentIntroPromptPending) return true;

    const normalized = normalizeText(salesText);
    return (
      containsAny(normalized, [
        /自己紹介|お名前|名前|紹介/,
        /どれくらい働きたい|いつまで働きたい|日本でどれくらい/,
        /大変.*大丈夫|頑張れます|頑張れる|大丈夫ですか/,
        /質問あります|聞きたいこと|何か質問/,
        /退出|退室|ありがとうございました|失礼します/,
        /お願いします/,
        /ください/,
        /ですか/,
        /ますか/,
        /でしょうか/
      ]) || (isQuestionLike(normalized) && /さん|あなた|本人|候補者/.test(normalized))
    );
  };
  const shouldRelaySalesToInterviewer = (salesText: string) => {
    if (phase === "pattern3") return true;
    if (phase !== "pattern2" || pendingCandidateRetry) return false;

    const normalized = normalizeText(salesText);
    return containsAny(normalized, [
      /仕事内容|仕事の流れ|雰囲気|会社説明|事業所紹介|ご説明/,
      /お伝えしたいこと|ございますでしょうか|ありますでしょうか|特に大丈夫/,
      /退出|退室|ヒアリング|この後/,
      /印象|結果|通知書|労働条件|ビザ|技人国|書類|日程/
    ]);
  };
  const buildInterruptPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (phase === "pattern3") {
      if (/結果|日程|2.?3日|いつまで/.test(normalized)) {
        return "The sales representative paused mid-explanation. Interrupt naturally in Japanese as the company side and briefly say you need internal confirmation on the result timing, in one short line.";
      }
      if (/通知書|労働条件|雇用契約|雛形/.test(normalized)) {
        return "The sales representative paused mid-explanation. Interrupt naturally in Japanese as the company side and briefly react to the labor conditions notice/template topic with one short line.";
      }
      if (/ビザ|技人国|必要書類|書類/.test(normalized)) {
        return "The sales representative paused mid-explanation. Interrupt naturally in Japanese as the company side and briefly ask or acknowledge one practical point about visa or required documents.";
      }
      return "The sales representative paused mid-explanation. Interrupt naturally in Japanese as the company side with one concise clarification or reaction. Sound slightly interruptive but professional.";
    }

    if (/仕事内容|仕事|雰囲気|会社/.test(normalized)) {
      return "The sales representative paused mid-explanation. Interrupt naturally in Japanese as the interviewer with one short practical clarification about the job or workplace.";
    }
    if (/勤務|シフト|夜勤|時間|開始時期/.test(normalized)) {
      return "The sales representative paused mid-explanation. Interrupt naturally in Japanese as the interviewer with one concise question about schedule or start timing.";
    }
    return "The sales representative paused mid-explanation. Interrupt naturally in Japanese as the interviewer with one short cut-in line that redirects to a practical interview point.";
  };
  const maybeScheduleInterruption = (partialText: string) => {
    if (
      !ENABLE_AI_CUT_IN ||
      !SALES_LED_FLOW ||
      userSpeaking !== true ||
      sessionEnded ||
      interruptPending ||
      pendingInterruptTarget ||
      pendingCandidateRetry ||
      Date.now() < interruptCooldownUntil ||
      (phase !== "pattern2" && phase !== "pattern3")
    ) {
      return;
    }

    const normalized = normalizeText(partialText);
    if (!normalized || normalized.length < 18) return;

    const elapsedMs = userSpeakingSince > 0 ? Date.now() - userSpeakingSince : 0;
    const longTalkScore =
      normalized.length >= 45 ? 2 : normalized.length >= 28 ? 1 : 0;
    const elapsedScore =
      elapsedMs >= 8000 ? 2 : elapsedMs >= 5500 ? 1 : 0;

    let topicalScore = 0;
    let probability = 0;

    if (phase === "pattern2") {
      if (/仕事内容|仕事|雰囲気|会社|施設/.test(normalized)) topicalScore += 1;
      if (/勤務|シフト|夜勤|時間|開始時期/.test(normalized)) topicalScore += 1;
      if (/説明|まず|事前に|改めまして/.test(normalized)) topicalScore += 1;
      probability = 0.28;
    } else {
      if (/結果|日程|2.?3日|いつまで/.test(normalized)) topicalScore += 2;
      if (/通知書|労働条件|雇用契約|雛形/.test(normalized)) topicalScore += 2;
      if (/ビザ|技人国|必要書類|書類/.test(normalized)) topicalScore += 1;
      if (/説明|流れ|案内|確認/.test(normalized)) topicalScore += 1;
      probability = 0.42;
    }

    const score = longTalkScore + elapsedScore + topicalScore;
    if (score < 3) return;
    if (Math.random() > probability) return;

    interruptPending = true;
    pendingInterruptTarget = "ai_a";
    pendingInterruptPrompt = buildInterruptPrompt(partialText);
    interruptCooldownUntil = Date.now() + 18000;
    sendToClient({
      type: "interrupt_pending",
      target: "ai_a",
      phase,
      reason: phase === "pattern3" ? "company_cut_in" : "interviewer_cut_in"
    });
  };
  const isAcknowledgementOnlyUtterance = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized || isQuestionLike(normalized)) return false;
    const compact = normalized.replace(/[、。！？!?,\s]/g, "");
    return /^(はい|ええ|よろしくお願いします|ありがとうございます|ありがとうございました|承知しました|かしこまりました|わかりました|失礼します|以上です)+$/.test(
      compact
    );
  };
  const getLatestCommittedNonSalesSpeaker = () =>
    [...conversationHistory].reverse().find((entry) => entry.speaker !== "sales")
      ?.speaker ?? null;
  const wasLatestCommittedSpeakerCandidate = () =>
    getLatestCommittedNonSalesSpeaker() === "candidate";
  const looksLikeSalesSupplementForInterviewer = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized || isQuestionLike(normalized)) return false;
    const candidateName = getCurrentCandidateName();
    const escapedName = candidateName
      ? candidateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : null;
    const mentionsCandidate = escapedName
      ? new RegExp(`${escapedName}さん?`).test(normalized)
      : false;
    return (
      /補足/.test(normalized) ||
      /と聞いております|と聞いており|とのことです|とおっしゃって|と思っております|だそうです/.test(
        normalized
      ) ||
      /以前の職場|前の職場|勤務していた|働いていた|経験していた|対応できる|対応できそう|見込み|問題ない|大丈夫だと思|柔軟に|安心して|意識して|対応していた/.test(
        normalized
      ) ||
      (mentionsCandidate &&
        /は.*(していました|していた|でした|できます|できる|行っていました|経験があり|意識して|対応して|活躍)/.test(
          normalized
        ))
    );
  };
  const isExplicitCandidateAddress = (text: string) => {
    const candidateName = getCurrentCandidateName();
    const escapedName = candidateName
      ? candidateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : null;
    const namePattern = escapedName
      ? new RegExp(`(^|[。！？!?])[^。！？!?]{0,12}${escapedName}さん?[、,。！？!?]`)
      : null;
    return (
      Boolean(namePattern?.test(text)) ||
      /(^|[。！？!?])[^。！？!?]{0,12}(本人|候補者|あなた)[、,]/.test(text) ||
      /(^|[。！？!?])[^。！？!?]{0,12}(皆さん|みなさん|学生の皆さん|生徒の皆さん)[、,!！]/.test(
        text
      ) ||
      looksLikeSelfIntroRequest(text) ||
      /お名前/.test(normalizeText(text))
    );
  };
  const isExplicitInterviewerAddress = (text: string) => {
    const normalized = normalizeText(text);
    if (
      /(^|[。！？!?])[^。！？!?]{0,12}(面接官様|面接官の方|企業様|企業の方|採用担当|担当者|御社|田中様)[、,。！？!?]/.test(
        text
      )
    ) {
      return true;
    }
    return /質問はございます|ご説明いただ|いかがでしょうか|お伝えいただ|確認いただ/.test(
      normalized
    );
  };
  const getLastExplicitAddressTarget = (text: string): RelayTarget | null => {
    const candidateName = getCurrentCandidateName();
    const escapedName = candidateName
      ? candidateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : null;
    const candidatePatterns = [
      escapedName
        ? new RegExp(`(^|[。！？!?])[^。！？!?]{0,12}${escapedName}さん?[、,。！？!?]`, "g")
        : null,
      /(^|[。！？!?])[^。！？!?]{0,12}(本人|候補者|あなた)[、,!！]/g,
      /(^|[。！？!?])[^。！？!?]{0,12}(皆さん|みなさん|学生の皆さん|生徒の皆さん)[、,!！]/g
    ].filter(Boolean) as RegExp[];
    const interviewerPatterns = [
      /(^|[。！？!?])[^。！？!?]{0,12}(面接官様|面接官の方|企業様|企業の方|採用担当|担当者|御社|田中様)[、,。！？!?]/g
    ];

    const getLastIndex = (patterns: RegExp[]) => {
      let lastIndex = -1;
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          lastIndex = Math.max(lastIndex, match.index);
        }
      }
      return lastIndex;
    };

    const lastCandidateIndex = getLastIndex(candidatePatterns);
    const lastInterviewerIndex = getLastIndex(interviewerPatterns);
    if (lastCandidateIndex < 0 && lastInterviewerIndex < 0) return null;
    if (lastCandidateIndex > lastInterviewerIndex) return "ai_b";
    if (lastInterviewerIndex > lastCandidateIndex) return "ai_a";
    return null;
  };
  const getDefaultRelayTarget = (): RelayTarget => {
    if (phase === "pattern1") return "ai_b";
    if (phase === "pattern3") return "ai_a";
    if (pendingCandidateRetry || studentIntroPromptPending) return "ai_b";
    return peekNextAiForSalesFlow();
  };
  const classifyRelayTargetByRules = (
    text: string
  ): { target: RelayTarget | null; confidence: "high" | "medium" | "low" } => {
    const normalized = normalizeText(text);
    const defaultTarget = getDefaultRelayTarget();
    const latestSpeakerWasCandidate =
      lastAiSpeaker === "ai_b" || wasLatestCommittedSpeakerCandidate();
    if (!normalized) {
      return { target: "none", confidence: "high" };
    }
    if (phase === "pattern1") {
      return { target: "ai_b", confidence: "high" };
    }
    if (phase === "pattern3") {
      return { target: "ai_a", confidence: "high" };
    }
    if (pendingCandidateRetry || studentIntroPromptPending) {
      return { target: "ai_b", confidence: "high" };
    }
    if (
      phase === "pattern2" &&
      latestSpeakerWasCandidate &&
      !pendingCandidateRetry &&
      !isQuestionLike(normalized) &&
      !isAcknowledgementOnlyUtterance(text) &&
      (pendingFollowUpContext || looksLikeSalesSupplementForInterviewer(text))
    ) {
      return { target: "ai_a", confidence: "high" };
    }
    if (
      phase === "pattern2" &&
      latestSpeakerWasCandidate &&
      !pendingCandidateRetry &&
      !isQuestionLike(normalized) &&
      !isAcknowledgementOnlyUtterance(text) &&
      defaultTarget === "ai_a"
    ) {
      return { target: "ai_a", confidence: "medium" };
    }
    if (phase === "pattern2" && isStrongEffortConfirmationPrompt(normalized)) {
      return { target: "ai_b", confidence: "high" };
    }
    if (isAcknowledgementOnlyUtterance(text)) {
      return { target: "none", confidence: "high" };
    }

    const candidateAddressed = isExplicitCandidateAddress(text);
    const interviewerAddressed = isExplicitInterviewerAddress(text);

    if (candidateAddressed && !interviewerAddressed) {
      return { target: "ai_b", confidence: "high" };
    }
    if (interviewerAddressed && !candidateAddressed) {
      return { target: "ai_a", confidence: "high" };
    }
    if (candidateAddressed && interviewerAddressed) {
      const lastAddressTarget = getLastExplicitAddressTarget(text);
      if (lastAddressTarget === "ai_b") {
        return { target: "ai_b", confidence: "high" };
      }
      if (lastAddressTarget === "ai_a") {
        return { target: "ai_a", confidence: "high" };
      }
      return { target: null, confidence: "low" };
    }
    if (!isQuestionLike(normalized)) {
      if (phase === "pattern2" && latestSpeakerWasCandidate) {
        return { target: "ai_a", confidence: "medium" };
      }
      return { target: "none", confidence: "medium" };
    }
    return { target: null, confidence: "low" };
  };
  const classifyRelayTargetWithAi = async (
    text: string,
    defaultTarget: RelayTarget
  ): Promise<{ target: RelayTarget; confidence: "high" | "medium" | "low" }> => {
    const recentHistory = getRecentConversationHistory();
    const lastCandidateAnswer =
      [...conversationHistory].reverse().find((entry) => entry.speaker === "candidate")
        ?.text ?? "";
    const latestNonSalesSpeaker =
      [...conversationHistory].reverse().find((entry) => entry.speaker !== "sales")
        ?.speaker ?? null;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1800);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: OPENAI_ROUTING_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You classify who should answer the sales representative's latest Japanese utterance in a 3-party interview practice app. Return strict JSON with keys target and confidence. target must be one of: interviewer, candidate, none. confidence must be one of: high, medium, low. Use the recent conversation history and current interview intent, not just surface keywords. Choose interviewer when the sales representative is summarizing, supplementing, or handing the floor back to the company-side person, even if the candidate's name appears only as the topic. Choose candidate only when the sales representative is clearly asking the candidate to answer now. Choose none for acknowledgements, transitions, or statements that do not require an answer."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase,
                introPhase,
                defaultTarget:
                  defaultTarget === "ai_a"
                    ? "interviewer"
                    : defaultTarget === "ai_b"
                      ? "candidate"
                      : "none",
                lastAiSpeaker,
                latestNonSalesSpeaker,
                pendingCandidateRetry,
                lastInterviewerIntent,
                lastInterviewerQuestionText,
                lastCandidateAnswer,
                lastSalesUtterance,
                candidateName: getCurrentCandidateName(),
                utterance: text,
                recentHistory
              })
            }
          ]
        })
      });

      if (!response.ok) {
        return { target: defaultTarget, confidence: "low" };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as {
        target?: "interviewer" | "candidate" | "none";
        confidence?: "high" | "medium" | "low";
      };
      const target =
        parsed.target === "interviewer"
          ? "ai_a"
          : parsed.target === "candidate"
            ? "ai_b"
            : "none";
      const confidence =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "low";
      console.log(
        `[RelayTargetAI] target=${target} confidence=${confidence} phase=${phase} introPhase=${introPhase} latestNonSalesSpeaker=${latestNonSalesSpeaker ?? "none"} intent=${lastInterviewerIntent ?? "other"} text="${text}"`
      );
      return { target, confidence };
    } catch {
      return { target: defaultTarget, confidence: "low" };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const resolvePendingCandidateRetryRelay = async (
    text: string
  ): Promise<{
    target: RelayTarget;
    confidence: "high" | "medium" | "low";
    clearPendingRetry: boolean;
  }> => {
    if (isAcknowledgementOnlyUtterance(text)) {
      return {
        target: "none",
        confidence: "high",
        clearPendingRetry: false
      };
    }
    const candidateAddressed = isExplicitCandidateAddress(text);
    const interviewerAddressed = isExplicitInterviewerAddress(text);
    if (candidateAddressed && !interviewerAddressed) {
      return {
        target: "ai_b",
        confidence: "high",
        clearPendingRetry: false
      };
    }
    if (interviewerAddressed && !candidateAddressed) {
      return {
        target: "ai_a",
        confidence: "high",
        clearPendingRetry: true
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: OPENAI_ROUTING_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You classify the sales representative's latest Japanese utterance while the system is waiting for the candidate to retry an answer. Return strict JSON with keys decision, confidence, reason. decision must be one of: retry_candidate, supplement_interviewer, acknowledge_only. confidence must be high, medium, or low. Choose retry_candidate only when the sales representative is clearly asking the candidate to answer again in simpler words. Choose supplement_interviewer when the sales representative is adding explanation or supplementation for the interviewer/company side instead of asking the candidate again. Choose acknowledge_only for short acknowledgements or transitions that should not be relayed yet."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase,
                introPhase,
                retryIntent: pendingCandidateRetryIntent ?? lastInterviewerIntent,
                interviewerQuestion: lastInterviewerQuestionText,
                lastCandidateAnswer:
                  [...conversationHistory]
                    .reverse()
                    .find((entry) => entry.speaker === "candidate")?.text ?? "",
                latestSalesUtterance: text,
                recentHistory: getRecentConversationHistory()
              })
            }
          ]
        })
      });

      if (!response.ok) {
        return {
          target: "ai_b",
          confidence: "low",
          clearPendingRetry: false
        };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as {
        decision?: "retry_candidate" | "supplement_interviewer" | "acknowledge_only";
        confidence?: "high" | "medium" | "low";
        reason?: string;
      };
      const confidence =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "low";
      const decision = parsed.decision ?? "retry_candidate";
      const result =
        decision === "supplement_interviewer"
          ? {
              target: "ai_a" as RelayTarget,
              confidence,
              clearPendingRetry: true
            }
          : decision === "acknowledge_only"
            ? {
                target: "none" as RelayTarget,
                confidence,
                clearPendingRetry: false
              }
            : {
                target: "ai_b" as RelayTarget,
                confidence,
                clearPendingRetry: false
              };
      console.log(
        `[PendingRetryRelay] decision=${decision} confidence=${confidence} target=${result.target}${parsed.reason ? ` reason="${parsed.reason}"` : ""} text="${text}"`
      );
      return result;
    } catch {
      return {
        target: "ai_b",
        confidence: "low",
        clearPendingRetry: false
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const resolveSalesRelayTarget = async (text: string): Promise<RelayTarget> => {
    const defaultTarget = getDefaultRelayTarget();
    const ruleResult = classifyRelayTargetByRules(text);
    if (
      ruleResult.target !== null &&
      ruleResult.confidence !== "low" &&
      !(ruleResult.target === "none" && ruleResult.confidence !== "high")
    ) {
      return ruleResult.target;
    }
    const aiResult = await classifyRelayTargetWithAi(text, defaultTarget);
    if (aiResult.confidence === "high" || aiResult.confidence === "medium") {
      return aiResult.target;
    }
    if (ruleResult.target === "none") {
      return "none";
    }
    return defaultTarget;
  };
  const pushConversationText = (key: AiKey, text: string) => {
    const socket = aiSockets[key];
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text
            }
          ]
        }
      })
    );
  };
  const flushBufferedCandidateTurn = () => {
    if (!bufferedCandidateTurn) return;
    if (!bufferedCandidateTurn.audioDone || !bufferedCandidateTurn.validatedText) return;
    const { turnId, name, audioChunks, validatedText } = bufferedCandidateTurn;
    sendToClient({
      type: "audio_start",
      source: "ai_b",
      name,
      turnId
    });
    for (const chunk of audioChunks) {
      sendToClient({
        type: "audio",
        source: "ai_b",
        turnId,
        data: chunk
      });
    }
    sendToClient({
      type: "transcript_done",
      source: "ai_b",
      name,
      turnId,
      text: validatedText
    });
    sendToClient({
      type: "audio_done",
      source: "ai_b",
      turnId
    });
    transcriptFinalText.ai_b = null;
    transcriptDeltaQueue.ai_b = [];
    transcriptSent.ai_b = true;
    bufferedCandidateTurn = null;
    checkTurnCompletion("ai_b");
  };
  const sendSessionUpdateToAi = (key: AiKey) => {
    const socket = aiSockets[key];
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(buildSessionUpdate(getAiProfile(key))));
  };
  const maybeStartPendingSession = () => {
    if (!pendingStart && !waitingForSessionRefresh) return;
    if (!sessionReady.ai_a || !sessionReady.ai_b) return;
    if (pendingSessionRefresh.ai_a || pendingSessionRefresh.ai_b) return;

    pendingStart = false;
    waitingForSessionRefresh = false;
    sendToClient({ type: "sessions_ready" });
    sendPhaseContextToCandidate(phase);
    sendPhaseContextToInterviewer(phase);
    setScriptHint(getPhaseScriptHint(phase));
    if (SALES_LED_FLOW) {
      waitingForHuman = true;
      lastAiSpeaker = null;
      return;
    }
    if (!SALES_LED_FLOW) {
      if (autoMode) {
        requestAiResponse("ai_a");
      } else {
        queuedNextKeys = ["ai_a"];
        manualAdvanceReady = true;
      }
    }
  };
  const updateScriptHintAfterAiTurn = (key: AiKey, finalText: string, wasCompanyOverviewStage: boolean) => {
    const normalized = normalizeText(finalText);
    if (phase === "pattern2" && key === "ai_b" && introPhase === "sales_supplement") {
      setScriptHint("P2ヒント: 学生自己紹介の直後です。担当目線で強みや意欲を短く補足し、企業へつなげてください。");
      return;
    }
    if (phase === "pattern2" && key === "ai_a" && wasCompanyOverviewStage) {
      setScriptHint("P2ヒント: 会社説明の次は、仕事の大変さに対応できるかを学生へ確認する内容へ進めてください。");
      return;
    }
    if (
      phase === "pattern2" &&
      key === "ai_b" &&
      /大丈夫です|頑張ります/.test(normalized)
    ) {
      setScriptHint("P2ヒント: 次は企業に追加で確認したい内容があるかを聞き、その後に学生退室へつなげてください。");
      return;
    }
    if (phase === "pattern3" && key === "ai_a") {
      if (/検討|結果|2.?3日/.test(normalized)) {
        setScriptHint("P3ヒント: 次は内定通知書や結果期限など、日程と書類の確認に進むと自然です。");
        return;
      }
      if (/技人国|キャリア|管理業務|採用理由書/.test(normalized)) {
        setScriptHint("P3ヒント: ビザ説明の次は、必要書類と返送期限の確認へ進めてください。");
      }
    }
  };

  const emitPhaseUpdate = (nextPhase: Phase, reason: "start" | "trigger" | "manual") => {
    sendToClient({ type: "phase_update", phase: nextPhase, reason });
  };
  const emitHumanTurnReady = (reason: "phase_transition" | "manual_phase" | "server_ready") => {
    sendToClient({ type: "human_turn_ready", reason, phase });
  };

  const setPhase = (nextPhase: Phase, reason: "start" | "trigger" | "manual") => {
    if (scenarioMode !== "unified" && reason !== "start") return;
    if (phase === nextPhase) return;
    if (reason === "manual") {
      sessionEnded = false;
      sessionEndReason = null;
      queuedNextKeys = [];
      manualAdvanceReady = false;
      clearInterruptState();
    }
    phase = nextPhase;
    if (phase === "pattern1") {
      pattern1Stage = "attendance";
    }
    if (phase === "pattern2") {
      introPhase = "sales_intro";
      pendingPattern3StudentExit = false;
      pattern2StartTimingAsked = false;
      pattern2VisaHandoffAsked = false;
      companyGreetingPromptPending = false;
      companyIntroAckPromptPending = false;
      studentIntroApprovalPromptPending = false;
      companyCandidateAckPromptPending = false;
      pendingCandidateRetry = false;
      pendingCandidateRetryIntent = null;
      pendingInterviewerGuidance = null;
      pendingFollowUpContext = null;
      lastInterviewerIntent = null;
      lastCandidateRelayContext = null;
      candidateValidationRetryCount = 0;
      followUpCountsByIntent = {};
      followUpTopicUsage = {};
      companyGreetingPromptPending = false;
      companyIntroAckPromptPending = false;
      studentIntroApprovalPromptPending = false;
      companyCandidateAckPromptPending = false;
      companyOverviewPromptPending = false;
      studentIntroPromptPending = false;
      interviewerSelfIntroDone = false;
    }
    if (phase === "pattern3") {
      introPhase = "complete";
      pendingPattern3StudentExit = false;
      pattern2StartTimingAsked = false;
      pattern2VisaHandoffAsked = false;
      companyGreetingPromptPending = false;
      companyIntroAckPromptPending = false;
      studentIntroApprovalPromptPending = false;
      companyCandidateAckPromptPending = false;
      pendingCandidateRetry = false;
      pendingCandidateRetryIntent = null;
      pendingInterviewerGuidance = null;
      pendingFollowUpContext = null;
      lastInterviewerIntent = null;
      lastCandidateRelayContext = null;
      bufferedCandidateTurn = null;
      candidateValidationRetryCount = 0;
      companyGreetingPromptPending = false;
      companyIntroAckPromptPending = false;
      studentIntroApprovalPromptPending = false;
      companyCandidateAckPromptPending = false;
      companyOverviewPromptPending = false;
      studentIntroPromptPending = false;
    }
    emitPhaseUpdate(phase, reason);
    sendPhaseContextToCandidate(phase);
    sendPhaseContextToInterviewer(phase);
    setScriptHint(getPhaseScriptHint(phase));
    if (reason === "manual") {
      emitHumanTurnReady("manual_phase");
    }
  };

  const sendPhaseContextToCandidate = (nextPhase: Phase) => {
    if (lastPhaseNotified === nextPhase) return;
    const studentSocket = aiSockets.ai_b;
    if (!studentSocket || studentSocket.readyState !== WebSocket.OPEN) return;
    const scenario = getIndustryScenario(interviewIndustry);
    const levelLine =
      candidateLanguageLevel === "prototype"
        ? "Language level reminder: speak relatively smoothly like the earlier prototype, but remain a non-native speaker."
        : candidateLanguageLevel === "standard"
          ? "Language level reminder: answer simple interview questions in short understandable Japanese."
          : "Language level reminder: stay close to drill level; self-introduction and simple fixed answers are enough.";
    const text =
      nextPhase === "pattern1"
        ? `Phase: pattern1 (sales vs student training).
${levelLine}
Follow the drills when prompted by the sales representative:
- Attendance: when your name is called, respond "はい" (briefly).
- Reaction practice: show simple reactions like "うんうん" or "はい".
- Q&A: if asked "日本でどれくらい働きたい？" answer "日本でずっと働きたいです".
- Q&A: if asked "お仕事大変でも大丈夫？頑張れますか？" answer "大丈夫です。頑張ります".
- If asked for questions to the company, avoid money/relocation/visa. Ask one good question such as:
  "外国人の先輩はいますか？" / "将来リーダーになれますか？" / "入社前に勉強することはありますか？" / "仕事の時に大切なことはありますか？"
- If the sales representative explains the company or job, react naturally with short acknowledgements and interest.
- Keep responses short and simple, as usual.`
        : nextPhase === "pattern2"
          ? `Phase: pattern2 (sales-led interview with interviewer present).
${levelLine}
Wait for the sales representative to paraphrase before answering.
${getCurrentCandidateName() ? `Use the exact candidate name 「${getCurrentCandidateName()}」 whenever you say your own name or hear the sales representative address you.` : "If you choose a name in your self-introduction, keep using the exact same name for the rest of the session."}
Industry setting: ${scenario.label}. ${scenario.candidateBackgroundContext}
When prompted by the sales representative:
- For self-introduction, give your name and one short background detail.
- After your self-introduction, wait for the sales representative to add a short supplement. Do not keep talking.
- If asked "日本でどれくらい働きたい？" answer "日本でずっと働きたいです".
- If asked "お仕事大変でも大丈夫？頑張れますか？" answer "大丈夫です。頑張ります".
- If asked for questions to the company, avoid money/relocation/visa. Ask one good question like:
  "外国人の先輩はいますか？" / "将来リーダーになれますか？" / "入社前に勉強することはありますか？" / "仕事の時に大切なことはありますか？".
- If the sales representative says the interview part is over or asks students to leave, say thanks briefly and stop speaking after that.
Keep responses short and simple.`
          : `Phase: pattern3 (post-interview discussion with the company).
You have left the interview. Do not respond anymore.`;
    studentSocket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text
            }
          ]
        }
      })
    );
    lastPhaseNotified = nextPhase;
  };

  const sendPhaseContextToInterviewer = (nextPhase: Phase) => {
    const interviewerSocket = aiSockets.ai_a;
    if (!interviewerSocket || interviewerSocket.readyState !== WebSocket.OPEN) return;
    const scenario = getIndustryScenario(interviewIndustry);
    const text =
      nextPhase === "pattern1"
        ? `Phase: pattern1 (sales vs student training).
Do not speak. Wait until pattern2 or pattern3.`
        : nextPhase === "pattern2"
          ? `Phase: pattern2 (sales-led interview with interviewer present).
Wait for the sales representative to prompt you before each question.
The sales representative leads the meeting. Do not seize control of the flow.
If the sales representative opens only with a greeting, first answer briefly as the company side with 「よろしくお願いします。」 and stop there.
If the sales representative then explains ヒトキワ's own company/business, answer briefly with 「はい、ありがとうございます。」 and stop there.
If the sales representative asks whether students may start self-introductions, answer briefly with 「お願いします！」 and stop there.
After the candidate introduces themselves and the sales representative adds a supplement, wait. Do not speak yet.
Right after that sales supplement, it is acceptable to reply once, briefly, with 「ありがとうございます。」 and stop there.
Only when the sales representative explicitly asks the company side to explain the job/company to the students, start your first substantial reply.
At that point, first say a short acknowledgement such as 「ありがとうございます。」.
Then introduce yourself as the hiring company representative. Example tone: 「では私も自己紹介をさせていただきます。採用担当の田中と申します。」.
Industry setting: ${scenario.label}. ${scenario.interviewerCompanyContext}
Start from a short company/job explanation only when the sales representative asks.
If asked to introduce the job or company atmosphere, respond briefly first, then proceed with questions.
If the sales representative says salary/place/hours were already explained to students, simply acknowledge and continue.
Do not ask candidates directly; let the sales representative relay in simpler words.
It is acceptable to ask one short follow-up on the same topic if the candidate's answer is vague or partial.
It is also acceptable to ask a natural off-script but interview-relevant question when the conversation supports it.
When speaking about your company in Japanese, use natural in-company wording like 「当社」「弊社」「当施設」.
Keep Japanese natural and conversational. Avoid mechanical starts like 「承知しました」 unless you are truly responding to a permission or explicit request. Prefer natural transitions such as 「ありがとうございます」「よく分かりました」「なるほど」, and when moving into a detailed explanation, name the topic briefly if it makes the sentence sound more human.
Avoid detailed visa/document discussion while students are present. However, near the end of pattern2, after start timing has been covered, ask one short visa-related handoff question to the sales representative before closing the student interview segment.
If the sales representative asks permission to let the students leave before discussing visa approval likelihood or visa-related details, answer with approval only, such as 「承知しました。それでは、どうぞお声がけください。」. Do not close the meeting and do not tell the students to leave yourself in that turn.
Do not say 「【面接終了】」 in pattern2. The whole meeting ends only in pattern3.`
          : `Phase: pattern3 (post-interview closing with the company only).
Students have left. Respond as the hiring company representative.
Follow this flow when the sales rep prompts you:
- First, give overall impressions in a natural way. Do not frame your answer around 「難しい」 or 「良い悪い」.
- When giving overall impressions, do not start with stiff permission-style phrases like 「承知しました」 or 「かしこまりました」. Start naturally with 「ありがとうございます」 or directly with the impression.
- If you have not decided yet, say you will review internally and try to give a result within 2〜3 days.
- If asked about an offer/conditions document (内定通知書 / 労働条件通知書), respond cooperatively. Either ask them to send their 雛形 or say you will send your own format.
- If sales explains visa processing timing, approval-rate uncertainty, or asks whether you can also consider other candidates, respond to that topic directly and briefly. Do not jump to career-up in that turn.
- When sales explains the 技人国ビザ and career-up expectations, reply briefly and cooperatively, close to 「かしこまりました。将来的にキャリアアップも考えています。」.
- In that turn, do not add concrete examples or management details unless the sales representative explicitly asks a separate follow-up about future career-up possibilities.
- If asked what future career-up is possible at your company, give 1〜2 short concrete examples that fit your industry.
- If asked about required documents or next steps, acknowledge and be cooperative.
- If the sales representative asks for a return date for documents, be as cooperative as possible and try to commit to today/tomorrow when reasonable.
- Do not close the whole meeting early just because one topic is done. Move topic by topic as the sales representative leads.
Use natural company wording like 「当社」「弊社」「当施設」, not 「今回の職場」.
Keep Japanese natural and businesslike. Avoid mechanical or template-like phrasing. When moving from agreement into a concrete explanation, briefly name the topic first if that sounds more natural, for example 「キャリアアップについてですが、例えば…」.
When the sales rep clearly gives the final closing thanks, end politely with "【面接終了】".
Keep responses concise and businesslike.`;
    interviewerSocket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text
            }
          ]
        }
      })
    );
  };

  const clearUserTranscriptTimer = () => {
    if (userTranscriptTimer) {
      clearTimeout(userTranscriptTimer);
      userTranscriptTimer = null;
    }
  };

  const handleUserUtteranceReady = async (transcript: string) => {
    const normalized = transcript.trim();
    if (!normalized || sessionEnded) return;
    if (shouldRememberCandidateNameFromSales(normalized)) {
      rememberCandidateNameFromSales(normalized);
    }
    appendConversationHistory("sales", normalized);

    let forceNextAi: AiKey | null = null;
    let forcedRelayTarget: RelayTarget | null = null;
    let skipCandidateForward = false;
    let skipInterviewerForward = false;
    let suppressAutoAdvance = false;
    let humanTurnReadyReason: "phase_transition" | "server_ready" =
      "phase_transition";
    if (pendingInterruptTarget) {
      forceNextAi = pendingInterruptTarget;
      clearInterruptState();
    }
    if (
      SALES_LED_FLOW &&
      scenarioMode === "unified" &&
      phase === "pattern1" &&
      shouldTransitionToPattern2(normalized)
    ) {
      setPhase("pattern2", "trigger");
      introPhase = "sales_intro";
      skipCandidateForward = true;
      suppressAutoAdvance = true;
    }
    const pattern3ExitApprovalRequest =
      SALES_LED_FLOW &&
      scenarioMode === "unified" &&
      phase === "pattern2" &&
      shouldRequestPattern3ExitApproval(normalized);
    if (pattern3ExitApprovalRequest) {
      pendingPattern3StudentExit = true;
      forceNextAi = "ai_a";
      forcedRelayTarget = "ai_a";
      pendingInterviewerGuidance =
        "The sales representative is asking permission to let the students leave before discussing visa approval likelihood or related details. Reply in one short Japanese line granting permission only, for example 「承知しました。それでは、どうぞお声がけください。」. Do not close the meeting, do not tell the student to leave yourself, and do not start any further explanation yet.";
    }
    if (
      SALES_LED_FLOW &&
      scenarioMode === "unified" &&
      phase === "pattern2" &&
      ((!pattern3ExitApprovalRequest && shouldTransitionToPattern3(normalized)) ||
        (pendingPattern3StudentExit && shouldExecutePattern3StudentExit(normalized)))
    ) {
      setPhase("pattern3", "trigger");
      pendingPattern3StudentExit = false;
      skipCandidateForward = true;
      suppressAutoAdvance = true;
      if (shouldPromptCompanyResponse(normalized)) {
        suppressAutoAdvance = false;
        forceNextAi = "ai_a";
      }
    }
    if (
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      introPhase === "sales_intro" &&
      shouldPromptInitialCompanyGreeting(normalized)
    ) {
      companyGreetingPromptPending = true;
      forceNextAi = "ai_a";
      forcedRelayTarget = "ai_a";
    }
    if (
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      introPhase === "sales_supplement"
    ) {
      if (shouldPromptCompanyOverviewRequest(normalized)) {
        introPhase = "company_overview";
        companyOverviewPromptPending = true;
        forceNextAi = "ai_a";
        forcedRelayTarget = "ai_a";
      }
    }
    if (
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      introPhase === "company_wait_request"
    ) {
      if (shouldPromptCompanyOverviewRequest(normalized)) {
        introPhase = "company_overview";
        companyOverviewPromptPending = true;
        forceNextAi = "ai_a";
        forcedRelayTarget = "ai_a";
      } else {
        forcedRelayTarget = "none";
        suppressAutoAdvance = true;
        humanTurnReadyReason = "server_ready";
      }
    }
    if (
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      introPhase === "company_ack" &&
      shouldPromptCompanyIntroAcknowledgement(normalized)
    ) {
      companyIntroAckPromptPending = true;
      forceNextAi = "ai_a";
      forcedRelayTarget = "ai_a";
    }
    if (
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      introPhase === "student_intro_permission" &&
      shouldPromptStudentIntroApproval(normalized)
    ) {
      studentIntroApprovalPromptPending = true;
      forceNextAi = "ai_a";
      forcedRelayTarget = "ai_a";
    }
    if (
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      (introPhase === "student_intro" || introPhase === "sales_intro" || introPhase === "company_ack") &&
      !companyGreetingPromptPending &&
      !companyIntroAckPromptPending &&
      !studentIntroApprovalPromptPending &&
      shouldPromptStudentIntro(normalized)
    ) {
      introPhase = "student_intro";
      studentIntroPromptPending = true;
      forceNextAi = "ai_b";
      skipInterviewerForward = true;
    }
    if (
      suppressAutoAdvance &&
      studentIntroPromptPending &&
      forceNextAi === "ai_b"
    ) {
      suppressAutoAdvance = false;
    }

    let retryRelayDecision:
      | {
          target: RelayTarget;
          confidence: "high" | "medium" | "low";
          clearPendingRetry: boolean;
        }
      | null = null;
    if (
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      pendingCandidateRetry &&
      !studentIntroPromptPending &&
      !skipCandidateForward
    ) {
      retryRelayDecision = await resolvePendingCandidateRetryRelay(normalized);
      if (retryRelayDecision.clearPendingRetry) {
        pendingCandidateRetry = false;
        pendingCandidateRetryIntent = null;
      }
    }
    const resolvedRelayTarget =
      forcedRelayTarget ??
      ((SALES_LED_FLOW && !skipCandidateForward)
        ? retryRelayDecision?.target ?? (await resolveSalesRelayTarget(normalized))
        : phase === "pattern3"
          ? "ai_a"
          : "none");
    if (phase === "pattern3" && resolvedRelayTarget === "ai_a") {
      const pattern3Guidance = buildPattern3InterviewerGuidance(normalized);
      if (pattern3Guidance) {
        pendingInterviewerGuidance = pattern3Guidance;
      }
    }
    console.log(
      `[SalesRelay] phase=${phase} introPhase=${introPhase} lastAiSpeaker=${lastAiSpeaker ?? "none"} pendingRetry=${pendingCandidateRetry} target=${resolvedRelayTarget} retryDecision=${retryRelayDecision ? `${retryRelayDecision.target}/${retryRelayDecision.confidence}` : "none"} suppressAutoAdvance=${suppressAutoAdvance} text="${normalized}"`
    );
    if (
      autoMode &&
      SALES_LED_FLOW &&
      !suppressAutoAdvance &&
      forceNextAi === null &&
      !waitingForHuman &&
      lastAiSpeaker !== null
    ) {
      pendingDeferredUserUtterance = normalized;
      console.log(
        `[SalesFlow] Deferring user utterance until AI playback completes: ${normalized}`
      );
      return;
    }
    const candidateDirectedUtterance = resolvedRelayTarget === "ai_b";
    if (
      SALES_LED_FLOW &&
      resolvedRelayTarget === "none" &&
      (!pendingCandidateRetry || retryRelayDecision?.target === "none") &&
      forceNextAi === null
    ) {
      suppressAutoAdvance = true;
      humanTurnReadyReason = "server_ready";
    }
    if (
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      (lastAiSpeaker === "ai_b" || wasLatestCommittedSpeakerCandidate()) &&
      candidateDirectedUtterance &&
      !pendingCandidateRetry &&
      forceNextAi === null
    ) {
      forceNextAi = "ai_b";
    }
    if (
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      (lastAiSpeaker === "ai_b" || wasLatestCommittedSpeakerCandidate()) &&
      pendingFollowUpContext &&
      !pendingCandidateRetry &&
      resolvedRelayTarget !== "ai_b"
    ) {
      if (
        pendingFollowUpContext.intent === "visa" &&
        pattern2StartTimingAsked &&
        !pattern2VisaHandoffAsked
      ) {
        pendingInterviewerGuidance =
          "First react briefly and naturally in Japanese to what was just said. Then, before closing the student interview, ask the sales representative one short Japanese question about visa approval likelihood or visa-related process while the students are still present. Do not ask the candidate directly. Keep it concise, for example along the lines of 「ありがとうございます。最後に、ビザの許可率や進め方について少し確認してもよろしいでしょうか？」. Do not say the questions are over yet.";
      } else {
        const followUp = buildTopicAwareFollowUpGuidance(
          pendingFollowUpContext.intent,
          pendingFollowUpContext.candidateAnswer,
          normalized,
          pendingFollowUpContext.assessment
        );
        if (followUp) {
          pendingInterviewerGuidance = followUp.guidance;
          markFollowUpUsed(pendingFollowUpContext.intent, followUp.topicKey);
        } else {
          pendingInterviewerGuidance = null;
        }
      }
      pendingFollowUpContext = null;
    }

    if (SALES_LED_FLOW && !skipCandidateForward && phase !== "pattern3") {
      lastSalesUtterance = normalized;
      if (resolvedRelayTarget === "ai_b") {
        const candidateRelay = await buildCandidateRelayMessage(lastSalesUtterance);
        pendingCandidateResponseMode = candidateRelay.mode;
        lastCandidateRelayContext = {
          salesText: lastSalesUtterance,
          normalizedPrompt: candidateRelay.normalizedPrompt,
          mode: candidateRelay.mode
        };
        candidateValidationRetryCount = 0;
        if (phase === "pattern1") {
          console.log(
            `[Pattern1Directive] stage=${pattern1Stage} mode=${candidateRelay.mode} text="${lastSalesUtterance}"`
          );
          advancePattern1Stage(candidateRelay.mode);
        }
        pushConversationText("ai_b", candidateRelay.text);
      }
      if (!skipInterviewerForward && resolvedRelayTarget === "ai_a") {
        pushConversationText("ai_a", buildInterviewerRelayMessage(lastSalesUtterance));
      }
    }
    if (SALES_LED_FLOW && !skipCandidateForward && phase === "pattern3") {
      lastSalesUtterance = normalized;
      pushConversationText("ai_a", buildInterviewerRelayMessage(lastSalesUtterance));
    }

    if (autoMode) {
      if (suppressAutoAdvance) {
        console.log(
          `[SalesFlow] human_turn_ready reason=${humanTurnReadyReason} target=${resolvedRelayTarget} text="${normalized}"`
        );
        waitingForHuman = true;
        emitHumanTurnReady(humanTurnReadyReason);
        return;
      }
      if (forceNextAi) {
        pendingCandidateRetry = false;
        waitingForHuman = false;
        queuedNextKeys = [forceNextAi];
        const first = queuedNextKeys.shift() ?? forceNextAi;
        requestAiResponse(first, 350);
        return;
      }
      if (SALES_LED_FLOW) {
        const nextAi =
          pendingCandidateRetry
            ? "ai_b"
            : resolvedRelayTarget === "ai_a" || resolvedRelayTarget === "ai_b"
              ? resolvedRelayTarget
              : nextAiForSalesFlow();
        pendingCandidateRetry = false;
        waitingForHuman = false;
        queuedNextKeys = [nextAi];
        const first = queuedNextKeys.shift() ?? nextAi;
        requestAiResponse(first, 350);
      } else {
        let nextKeys: AiKey[] = ["ai_a"];
        if (lastUserTranscript && Date.now() - lastUserTranscriptAt < 5000) {
          const decision = pickNextSpeaker(lastUserTranscript);
          if (decision === "ai_a") {
            nextKeys = ["ai_a"];
          } else if (decision === "ai_b") {
            nextKeys = ["ai_b"];
          } else if (decision === "both") {
            nextKeys = ["ai_a", "ai_b"];
          }
        }
        queuedNextKeys = [...nextKeys];
        const first = queuedNextKeys.shift() ?? "ai_a";
        requestAiResponse(first, 350);
      }
    } else {
      if (suppressAutoAdvance) {
        waitingForHuman = true;
        manualAdvanceReady = false;
        emitHumanTurnReady(humanTurnReadyReason);
        return;
      }
      if (forceNextAi) {
        pendingCandidateRetry = false;
        waitingForHuman = false;
        queuedNextKeys = [forceNextAi];
        manualAdvanceReady = true;
        return;
      }
      if (SALES_LED_FLOW) {
        const nextAi =
          pendingCandidateRetry
            ? "ai_b"
            : resolvedRelayTarget === "ai_a" || resolvedRelayTarget === "ai_b"
              ? resolvedRelayTarget
              : nextAiForSalesFlow();
        pendingCandidateRetry = false;
        waitingForHuman = false;
        queuedNextKeys = [nextAi];
        manualAdvanceReady = true;
      } else {
        let nextKeys: AiKey[] = ["ai_a"];
        if (lastUserTranscript && Date.now() - lastUserTranscriptAt < 5000) {
          const decision = pickNextSpeaker(lastUserTranscript);
          if (decision === "ai_a") {
            nextKeys = ["ai_a"];
          } else if (decision === "ai_b") {
            nextKeys = ["ai_b"];
          } else if (decision === "both") {
            nextKeys = ["ai_a", "ai_b"];
          }
        }
        queuedNextKeys = [...nextKeys];
        manualAdvanceReady = true;
      }
    }
  };

  const createAiSocket = (key: AiKey) => {
    return createRealtimeConnection(() => getAiProfile(key), {
      onReady: () => {
        sessionReady[key] = true;
        if (pendingSessionRefresh[key]) {
          pendingSessionRefresh[key] = false;
        }
        maybeStartPendingSession();
      },
      onAudioDelta: (audioBase64) => {
        const profile = getAiProfile(key);
        if (
          shouldBufferCandidateOutput(key) &&
          bufferedCandidateTurn &&
          bufferedCandidateTurn.turnId === currentTurn[key]
        ) {
          bufferedCandidateTurn.audioChunks.push(audioBase64);
          if (!audioStarted[key]) {
            audioStarted[key] = true;
            logEvent(key, "audio_start");
          }
          return;
        }
        sendToClient({
          type: "audio",
          source: key,
          turnId: currentTurn[key],
          data: audioBase64
        });
        if (!audioStarted[key]) {
          audioStarted[key] = true;
          logEvent(key, "audio_start");
          sendToClient({
            type: "audio_start",
            source: key,
            name: profile.name,
            turnId: currentTurn[key]
          });
        }
        if (transcriptDeltaQueue[key].length > 0) {
          const delta = transcriptDeltaQueue[key].shift();
          if (delta) {
            sendToClient({
              type: "transcript_delta",
              source: key,
              name: profile.name,
              turnId: currentTurn[key],
              delta
            });
          }
        }
      },
      onAudioDone: () => {
        const profile = getAiProfile(key);
        logEvent(key, "audio_done");
        if (
          shouldBufferCandidateOutput(key) &&
          bufferedCandidateTurn &&
          bufferedCandidateTurn.turnId === currentTurn[key]
        ) {
          audioDone[key] = true;
          bufferedCandidateTurn.audioDone = true;
          flushBufferedCandidateTurn();
          return;
        }
        sendToClient({
          type: "audio_done",
          source: key,
          turnId: currentTurn[key]
        });
        audioDone[key] = true;
        if (transcriptFinalText[key] && !transcriptSent[key]) {
          sendToClient({
            type: "transcript_done",
            source: key,
            name: profile.name,
            turnId: currentTurn[key],
            text: transcriptFinalText[key]
          });
          transcriptFinalText[key] = null;
          transcriptDeltaQueue[key] = [];
          transcriptSent[key] = true;
        }
        checkTurnCompletion(key);
      },
      onTranscriptDelta: (delta) => {
        transcriptBuffers[key] += delta;
        if (delta) {
          transcriptDeltaQueue[key].push(delta);
          logEvent(key, "transcript_delta", `len=${delta.length}`);
        }
      },
      onTranscriptDone: async (transcript) => {
        const profile = getAiProfile(key);
        const responseMode = key === "ai_b" ? pendingCandidateResponseMode : null;
        const rawFinalText = transcript || transcriptBuffers[key];
        let finalText = rawFinalText;
        if (key === "ai_b") {
          finalText = normalizeCandidateFinalText(finalText, responseMode);
          if (rawFinalText !== finalText) {
            console.log(
              `[CandidateNormalize] mode=${responseMode ?? "unknown"} raw="${rawFinalText}" normalized="${finalText}"`
            );
          }
          pendingCandidateResponseMode = null;
        } else if (key === "ai_a") {
          finalText = normalizeInterviewerFinalText(finalText);
          if (rawFinalText !== finalText) {
            console.log(
              `[InterviewerNormalize] raw="${rawFinalText}" normalized="${finalText}"`
            );
          }
        }
        if (
          key === "ai_b" &&
          shouldBufferCandidateOutput(key) &&
          lastCandidateRelayContext
        ) {
          const validation = await validateCandidateResponseWithAi({
            salesText: lastCandidateRelayContext.salesText,
            normalizedPrompt: lastCandidateRelayContext.normalizedPrompt,
            mode: responseMode,
            candidateAnswer: finalText
          });
          console.log(
            `[CandidateValidate] verdict=${validation.verdict} confidence=${validation.confidence} mode=${responseMode ?? "unknown"} answer="${finalText}"${validation.reason ? ` reason="${validation.reason}"` : ""}`
          );
          if (
            validation.verdict === "retry" &&
            validation.confidence !== "low" &&
            candidateValidationRetryCount < MAX_CANDIDATE_VALIDATION_RETRIES
          ) {
            candidateValidationRetryCount += 1;
            bufferedCandidateTurn = null;
            transcriptBuffers[key] = "";
            transcriptFinalText[key] = null;
            transcriptDeltaQueue[key] = [];
            transcriptDone[key] = false;
            transcriptSent[key] = false;
            audioDone[key] = false;
            audioStarted[key] = false;
            playbackDone[key] = false;
            const retryMode = validation.suggestedMode ?? responseMode ?? "answer_question";
            pendingCandidateResponseMode = retryMode;
            const socket = aiSockets.ai_b;
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "message",
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: `Your previous reply was not natural enough for the current conversation and was discarded. Try once more in Japanese. Latest sales meaning: 「${lastCandidateRelayContext.normalizedPrompt}」. Expected response mode: ${retryMode}. ${validation.reason ? `Fix this issue: ${validation.reason}. ` : ""}Do not repeat the discarded reply: 「${finalText}」. Keep it short and natural for the current context.`
                      }
                    ]
                  }
                })
              );
            }
            requestAiResponse("ai_b", 120);
            return;
          }
        }
        const wasCompanyGreetingStage =
          key === "ai_a" && companyGreetingPromptPending;
        const wasCompanyIntroAckStage =
          key === "ai_a" && companyIntroAckPromptPending;
        const wasStudentIntroApprovalStage =
          key === "ai_a" && studentIntroApprovalPromptPending;
        const wasCompanyCandidateAckStage =
          key === "ai_a" && companyCandidateAckPromptPending;
        const wasCompanyOverviewStage = key === "ai_a" && introPhase === "company_overview";
        transcriptBuffers[key] = "";
        transcriptFinalText[key] = finalText;
        if (SALES_LED_FLOW && phase === "pattern2") {
          if (key === "ai_b") {
            const introducedName = extractCandidateNameFromIntro(finalText);
            if (introducedName) {
              confirmedCandidateName = expectedCandidateName ?? introducedName;
            }
            if (introPhase === "student_intro") {
              if (isStudentIntroSufficient(finalText)) {
                introPhase = "sales_supplement";
              }
            }
            const needsClarification = isCandidateNeedsClarification(finalText);
            const activeIntent =
              pendingCandidateRetryIntent ?? lastInterviewerIntent;
            const answerAssessment = needsClarification
              ? "mismatch"
              : await assessCandidateAnswer(activeIntent, finalText);
            const intentMismatch = answerAssessment === "mismatch";
            pendingCandidateRetry = needsClarification || intentMismatch;
            console.log(
              `[CandidateAnswer] intent=${activeIntent ?? "other"} assessment=${answerAssessment} needsClarification=${needsClarification} pendingRetry=${pendingCandidateRetry} answer="${finalText}" question="${lastInterviewerQuestionText}" sales="${lastSalesUtterance}"`
            );
            if (pendingCandidateRetry) {
              pendingCandidateRetryIntent = activeIntent;
              pendingFollowUpContext = null;
              pendingInterviewerGuidance = null;
              clearInterruptState();
              if (intentMismatch && activeIntent) {
                setScriptHint(
                  `P2ヒント: 候補者が質問意図を取り違えています。${getIntentRetryHint(activeIntent)}`
                );
              }
            } else {
              pendingInterviewerGuidance = null;
              pendingFollowUpContext =
                activeIntent && activeIntent !== "other"
                  ? {
                      intent: activeIntent,
                      candidateAnswer: finalText,
                      assessment: answerAssessment === "partial" ? "partial" : "fit"
                    }
                  : null;
              pendingCandidateRetryIntent = null;
            }
          }
          if (key === "ai_a") {
            lastInterviewerQuestionText = finalText;
            const detectedIntent = detectInterviewIntent(finalText);
            if (detectedIntent !== "other") {
              lastInterviewerIntent = detectedIntent;
            }
            if (phase === "pattern2" && detectedIntent === "visa") {
              if (isVisaHandoffTopicText(finalText)) {
                pattern2VisaHandoffAsked = true;
              } else if (isStartTimingTopicText(finalText)) {
                pattern2StartTimingAsked = true;
              }
            }
            if (wasCompanyGreetingStage) {
              companyGreetingPromptPending = false;
              introPhase = "company_ack";
              setScriptHint("P2ヒント: 企業の「よろしくお願いします」が返りました。次はヒトキワの会社説明を行ってください。");
            }
            if (wasCompanyIntroAckStage) {
              companyIntroAckPromptPending = false;
              introPhase = "student_intro_permission";
              setScriptHint("P2ヒント: 企業の「はい、ありがとうございます」が返りました。次は学生自己紹介の許可を企業へ確認してください。");
            }
            if (wasStudentIntroApprovalStage) {
              studentIntroApprovalPromptPending = false;
              introPhase = "student_intro";
              setScriptHint("P2ヒント: 企業の「お願いします！」が返りました。次は学生の名前を呼んで自己紹介を促してください。");
            }
            if (wasCompanyCandidateAckStage) {
              companyCandidateAckPromptPending = false;
              introPhase = "company_wait_request";
              setScriptHint("P2ヒント: 企業の「ありがとうございます」が返りました。次は会社説明を依頼してください。");
            }
            if (introPhase === "company_overview") {
              introPhase = "complete";
            }
          }
        }
        transcriptDone[key] = true;
        logEvent(key, "transcript_done", `len=${finalText.length}`);
        totalTurns += 1;
        if (key === "ai_a") {
          appendConversationHistory("interviewer", finalText);
        }
        if (key === "ai_b") {
          appendConversationHistory("candidate", finalText);
        }
        if (
          phase === "pattern2" &&
          key === "ai_a" &&
          !interviewerSelfIntroDone &&
          !wasCompanyGreetingStage &&
          !wasCompanyIntroAckStage &&
          !wasStudentIntroApprovalStage &&
          !wasCompanyCandidateAckStage &&
          (wasCompanyOverviewStage || /申します|採用担当|人事担当|面接担当/.test(finalText))
        ) {
          interviewerSelfIntroDone = true;
        }
        updateScriptHintAfterAiTurn(key, finalText, wasCompanyOverviewStage);
        if (key === "ai_a") {
          updateCoverage(finalText);
        }
        if (endMarkers.some((marker) => finalText.includes(marker))) {
          if (phase === "pattern3") {
            endSession("marker");
          } else {
            console.log(
              `[EndGuard] marker ignored (turn=${totalTurns}, coverage=${JSON.stringify(coverage)})`
            );
            if (key === "ai_a") {
              const missing = listMissingCoverage();
              const aiSocket = aiSockets.ai_a;
              if (aiSocket && aiSocket.readyState === WebSocket.OPEN && missing) {
                aiSocket.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text: `Continue the interview. Missing topics: ${missing}. Do NOT close yet.`
                        }
                      ]
                    }
                  })
                );
              }
              if (phase === "pattern2") {
                aiSocket?.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text:
                            "The student interview segment may be done, but the whole meeting is NOT over. Do not say 【面接終了】 in pattern2. Wait for the sales representative to move to pattern3, then continue as the company side."
                        }
                      ]
                    }
                  })
                );
              }
            }
          }
        } else if (totalTurns >= MAX_TURNS) {
          endSession("max_turns");
        }
        if (
          key === "ai_b" &&
          shouldBufferCandidateOutput(key) &&
          bufferedCandidateTurn &&
          bufferedCandidateTurn.turnId === currentTurn[key]
        ) {
          bufferedCandidateTurn.validatedText = finalText;
          flushBufferedCandidateTurn();
        } else if (audioDone[key] && transcriptFinalText[key] && !transcriptSent[key]) {
          sendToClient({
            type: "transcript_done",
            source: key,
            name: profile.name,
            turnId: currentTurn[key],
            text: transcriptFinalText[key]
          });
          transcriptFinalText[key] = null;
          transcriptDeltaQueue[key] = [];
          transcriptSent[key] = true;
        }
        checkTurnCompletion(key);
        if (finalText.trim()) {
          const otherKey: AiKey = key === "ai_a" ? "ai_b" : "ai_a";
          const otherSocket = aiSockets[otherKey];
          if (otherSocket && otherSocket.readyState === WebSocket.OPEN) {
            const label = key === "ai_a" ? "Interviewer" : "Candidate";
            const shouldForward =
              !SALES_LED_FLOW || (phase === "pattern2" && key !== "ai_a");
            if (shouldForward) {
              otherSocket.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "message",
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: `[${label} said]: ${finalText}`
                      }
                    ]
                  }
                })
              );
            }
          }
        }
      },
      onInputTranscriptDone: (transcript) => {
        if (key !== "ai_a") return;
        const normalized = normalizeKnownTranscriptTerms(transcript).trim();
        liveUserTranscriptBuffer = "";
        if (!normalized) return;
        if (
          !waitingForUserTranscript &&
          currentUserCommitSeq === ignoredLateUserCommitSeq
        ) {
          console.log(
            `[UserTranscript] Ignored late transcript after no-speech timeout: ${normalized}`
          );
          return;
        }
        if (isNoiseUserTranscript(normalized)) {
          if (waitingForUserTranscript) {
            waitingForUserTranscript = false;
            ignoredLateUserCommitSeq = currentUserCommitSeq;
            pendingUserCommitAt = 0;
            clearUserTranscriptTimer();
            clearInterruptState();
            sendToClient({ type: "user_no_speech" });
          }
          return;
        }
        const now = Date.now();
        if (
          normalized === lastProcessedUserTranscript &&
          currentUserCommitSeq === lastProcessedUserCommitSeq
        ) {
          return;
        }
        lastUserTranscript = normalized;
        lastUserTranscriptAt = now;
        lastProcessedUserTranscript = normalized;
        lastProcessedUserCommitSeq = currentUserCommitSeq;
        sendToClient({ type: "user_transcript", text: normalized });
        if (lastUserTranscriptAt >= pendingUserCommitAt) {
          const isLateButAcceptable =
            !waitingForUserTranscript &&
            pendingUserCommitAt > 0 &&
            now - pendingUserCommitAt < 8000;
          if (waitingForUserTranscript || isLateButAcceptable) {
            waitingForUserTranscript = false;
            pendingUserCommitAt = 0;
            clearUserTranscriptTimer();
            void handleUserUtteranceReady(normalized);
          }
        }
      },
      onInputTranscript: (delta) => {
        if (key !== "ai_a" || !delta) return;
        liveUserTranscriptBuffer += delta;
        maybeScheduleInterruption(liveUserTranscriptBuffer);
      },
      onError: (error) => {
        sendToClient({ type: "error", message: error.message });
      }
    });
  };

  const requestAiResponse = (key: AiKey, delayMs = 0) => {
    const socket = aiSockets[key];
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    currentTurn[key] += 1;
    logEvent(key, "response_create");
    audioStarted[key] = false;
    audioDone[key] = false;
    transcriptDone[key] = false;
    transcriptSent[key] = false;
    playbackDone[key] = false;
    transcriptDeltaQueue[key] = [];
    transcriptFinalText[key] = null;
    transcriptBuffers[key] = "";
    if (shouldBufferCandidateOutput(key)) {
      bufferedCandidateTurn = {
        turnId: currentTurn[key],
        name: getAiProfile(key).name,
        audioChunks: [],
        audioDone: false,
        validatedText: null
      };
    }
    setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (key === "ai_a" && pendingInterviewerGuidance) {
        socket.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: pendingInterviewerGuidance
                }
              ]
            }
          })
        );
        pendingInterviewerGuidance = null;
      }
      if (
        key === "ai_a" &&
        phase === "pattern2" &&
        !interviewerSelfIntroDone &&
        (companyOverviewPromptPending || introPhase === "company_overview")
      ) {
        socket.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text:
                    "This is your first substantial turn in pattern2. First say a short acknowledgement such as 「ありがとうございます。」. Then introduce yourself as the hiring company representative in Japanese, and only after that continue into the company/job explanation. Use a natural line such as 「では私も自己紹介をさせていただきます。採用担当の田中と申します。」. Stop after the explanation in this turn. Do not begin concrete interview questions yet."
                }
              ]
            }
          })
        );
      }
      if (key === "ai_a" && companyOverviewPromptPending) {
        companyOverviewPromptPending = false;
        const scenario = getIndustryScenario(interviewIndustry);
        socket.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `Briefly explain the job responsibilities and workplace atmosphere for this role. ${scenario.companyOverviewGuidance} Keep it concise, and in Japanese refer to your company/facility naturally as 「当社」「弊社」「当施設」. In this turn, stop after the explanation. Do not begin concrete interview questions yet, and do not close the whole meeting here.`
                }
              ]
            }
          })
        );
      }
      if (key === "ai_b" && studentIntroPromptPending) {
        studentIntroPromptPending = false;
        pendingCandidateResponseMode = "self_intro";
        lastCandidateRelayContext = {
          salesText: lastSalesUtterance || "自己紹介をお願いします。",
          normalizedPrompt: "自己紹介をしてください。",
          mode: "self_intro"
        };
        candidateValidationRetryCount = 0;
        const candidateName = getCurrentCandidateName();
        const scenario = getIndustryScenario(interviewIndustry);
        const selfIntroExamples = buildCandidateSelfIntroVariants();
        socket.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text:
                    candidateName
                      ? `Give a very short self-introduction now. Use this exact candidate name: 「${candidateName}」. The very first words must be exactly 「${candidateName}です。」. Do not put any other word before the name. Do not repeat discourse markers from the sales representative such as 「まずは」「それでは」「はい」. Keep it simple: name + origin + short role experience. Vary the origin/experience phrasing a little each time instead of repeating the same exact wording. Example shapes:\n- ${selfIntroExamples.join("\n- ")}`
                      : `Give a very short self-introduction now. Pick one simple name and keep using the exact same name for the whole session. The very first words must be exactly 「<your name>です。」. Do not put any other word before the name. Do not repeat discourse markers from the sales representative such as 「まずは」「それでは」「はい」. Keep it simple: name + origin + short role experience. Vary the origin/experience phrasing a little each time instead of repeating the same exact wording. Example shapes:\n- ${selfIntroExamples.join("\n- ")}`
                }
              ]
            }
          })
        );
      }
      if (key === "ai_a" && pendingInterruptPrompt) {
        socket.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: pendingInterruptPrompt
                }
              ]
            }
          })
        );
        pendingInterruptPrompt = null;
      }
      socket.send(
        JSON.stringify({
          type: "response.create",
          response: { modalities: ["text", "audio"] }
        })
      );
    }, delayMs);
  };

  const checkTurnCompletion = (key: AiKey) => {
    if (!audioDone[key] || !transcriptDone[key] || !playbackDone[key]) return;
    if (!autoMode || userSpeaking) return;
    if (sessionEnded) return;

    if (SALES_LED_FLOW) {
      lastAiSpeaker = key;
      waitingForHuman = true;
      if (pendingDeferredUserUtterance) {
        const deferredUtterance = pendingDeferredUserUtterance;
        pendingDeferredUserUtterance = null;
        queueMicrotask(() => {
          void handleUserUtteranceReady(deferredUtterance);
        });
      }
      return;
    }

    const nextKey =
      queuedNextKeys.shift() ?? (key === "ai_a" ? "ai_b" : "ai_a");
    requestAiResponse(nextKey, 450);
  };

  const aiSockets: Record<AiKey, WebSocket> = {
    ai_a: createAiSocket("ai_a"),
    ai_b: createAiSocket("ai_b")
  };

  clientSocket.on("message", (raw) => {
    let message: {
      type?: string;
      target?: AiKey;
      data?: string;
      text?: string;
      turnId?: number;
      mode?: "auto" | "step";
      phase?: Phase;
      scenario?: ScenarioMode;
      candidateLevel?: CandidateLanguageLevel;
      industry?: InterviewIndustry;
      personality?: InterviewerPersonality;
      literacy?: InterviewerLiteracy;
      dialect?: InterviewerDialect;
      difficulty?: InterviewDifficulty;
      note?: string;
    };
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "start") {
      autoMode = message.mode !== "step";
      sessionEnded = false;
      sessionEndReason = null;
      totalTurns = 0;
      queuedNextKeys = [];
      waitingForHuman = SALES_LED_FLOW;
      lastAiSpeaker = null;
      lastInterviewerQuestionText = "";
      pendingCandidateResponseMode = null;
      pendingDeferredUserUtterance = null;
      manualAdvanceReady = false;
      bufferedCandidateTurn = null;
      lastCandidateRelayContext = null;
      candidateValidationRetryCount = 0;
      conversationHistory = [];
      scenarioMode = message.scenario ?? "unified";
      candidateLanguageLevel = message.candidateLevel ?? "basic";
      interviewIndustry = message.industry ?? "care";
      interviewerSettings = sanitizeInterviewerSettings({
        personality: message.personality,
        literacy: message.literacy,
        dialect: message.dialect,
        difficulty: message.difficulty,
        note: message.note
      });
      clearInterruptState();
      liveUserTranscriptBuffer = "";
      userSpeakingSince = 0;
      userCommitSeq = 0;
      currentUserCommitSeq = 0;
      lastProcessedUserCommitSeq = 0;
      lastProcessedUserTranscript = "";
      ignoredLateUserCommitSeq = 0;
      expectedCandidateName = getIndustryScenario(interviewIndustry).candidateProfile.name;
      confirmedCandidateName = getIndustryScenario(interviewIndustry).candidateProfile.name;
      interviewerSelfIntroDone = false;
      lastInterviewerIntent = null;
      pendingCandidateRetryIntent = null;
      pendingInterviewerGuidance = null;
      pendingFollowUpContext = null;
      followUpCountsByIntent = {};
      followUpTopicUsage = {};
      emitCandidateProfile();
      if (SALES_LED_FLOW) {
        if (scenarioMode === "pattern2") {
          phase = "pattern2";
        } else if (scenarioMode === "pattern3") {
          phase = "pattern3";
        } else {
          phase = "pattern1";
        }
      if (phase === "pattern2") {
          introPhase = "sales_intro";
        } else if (phase === "pattern3") {
          introPhase = "complete";
        } else {
          introPhase = "sales_intro";
          pattern1Stage = "attendance";
        }
        companyGreetingPromptPending = false;
        companyIntroAckPromptPending = false;
        studentIntroApprovalPromptPending = false;
        companyCandidateAckPromptPending = false;
        pendingPattern3StudentExit = false;
        pattern2StartTimingAsked = false;
        pattern2VisaHandoffAsked = false;
        studentIntroPromptPending = false;
      } else {
        phase = "pattern2";
        introPhase = "complete";
        companyGreetingPromptPending = false;
        companyIntroAckPromptPending = false;
        studentIntroApprovalPromptPending = false;
        companyCandidateAckPromptPending = false;
        pendingPattern3StudentExit = false;
        pattern2StartTimingAsked = false;
        pattern2VisaHandoffAsked = false;
        studentIntroPromptPending = false;
      }
      emitPhaseUpdate(phase, "start");
      lastPhaseNotified = null;
      lastScriptHint = "";
      coverage = {
        experience: false,
        motivation: false,
        language: false,
        shift: false,
        stamina: false,
        visa: false
      };
      if (sessionReady.ai_a && sessionReady.ai_b) {
        pendingSessionRefresh = {
          ai_a: true,
          ai_b: true
        };
        waitingForSessionRefresh = true;
        sendToClient({ type: "waiting_for_sessions" });
        setScriptHint(getPhaseScriptHint(phase));
        sendSessionUpdateToAi("ai_a");
        sendSessionUpdateToAi("ai_b");
      } else {
        pendingStart = true;
        sendToClient({ type: "waiting_for_sessions" });
        setScriptHint(getPhaseScriptHint(phase));
      }
      return;
    }

    if (message.type === "request_ai" && message.target) {
      requestAiResponse(message.target);
      return;
    }

    if (message.type === "set_phase" && message.phase) {
      if (scenarioMode !== "unified") {
        return;
      }
      setPhase(message.phase, "manual");
      waitingForHuman = true;
      return;
    }

    if (message.type === "user_audio" && message.data) {
      Object.values(aiSockets).forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: message.data
            })
          );
        }
      });
      return;
    }

    if (message.type === "user_audio_clear") {
      Object.values(aiSockets).forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        }
      });
      waitingForUserTranscript = false;
      pendingUserCommitAt = 0;
      liveUserTranscriptBuffer = "";
      lastSalesUtterance = "";
      queuedNextKeys = [];
      clearUserTranscriptTimer();
      clearInterruptState();
      return;
    }

    if (message.type === "user_audio_commit") {
      Object.values(aiSockets).forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
      });
      userCommitSeq += 1;
      currentUserCommitSeq = userCommitSeq;
      ignoredLateUserCommitSeq = 0;
      lastSalesUtterance = "";
      queuedNextKeys = [];
      manualAdvanceReady = false;
      waitingForUserTranscript = true;
      pendingUserCommitAt = Date.now();
      liveUserTranscriptBuffer = "";
      clearUserTranscriptTimer();
      userTranscriptTimer = setTimeout(() => {
        if (!waitingForUserTranscript) return;
        waitingForUserTranscript = false;
        ignoredLateUserCommitSeq = currentUserCommitSeq;
        pendingUserCommitAt = 0;
        lastSalesUtterance = "";
        clearInterruptState();
        sendToClient({ type: "user_no_speech" });
      }, 3000);
      return;
    }

    if (message.type === "user_text") {
      const normalized = normalizeKnownTranscriptTerms(message.text ?? "").trim();
      if (!normalized) {
        sendToClient({ type: "user_no_speech" });
        return;
      }
      waitingForUserTranscript = false;
      pendingUserCommitAt = 0;
      clearUserTranscriptTimer();
      clearInterruptState();
      liveUserTranscriptBuffer = "";
      queuedNextKeys = [];
      manualAdvanceReady = false;
      lastSalesUtterance = "";
      const now = Date.now();
      lastUserTranscript = normalized;
      lastUserTranscriptAt = now;
      lastProcessedUserTranscript = normalized;
      sendToClient({ type: "user_transcript", text: normalized });
      void handleUserUtteranceReady(normalized);
      return;
    }

    if (message.type === "user_speaking") {
      userSpeaking = true;
      userSpeakingSince = Date.now();
      liveUserTranscriptBuffer = "";
      clearInterruptState();
      return;
    }

    if (message.type === "user_done") {
      userSpeaking = false;
      userSpeakingSince = 0;
      return;
    }

    if (message.type === "advance") {
      if (autoMode || sessionEnded || !manualAdvanceReady) return;
      const nextKey = queuedNextKeys.shift();
      if (!nextKey) return;
      manualAdvanceReady = false;
      requestAiResponse(nextKey, 350);
      return;
    }

    if (message.type === "audio_playback_done" && message.target) {
      if (message.turnId !== undefined && message.turnId !== currentTurn[message.target]) {
        return;
      }
      playbackDone[message.target] = true;
      logEvent(message.target, "audio_playback_done");
      checkTurnCompletion(message.target);
      return;
    }
  });

  clientSocket.on("close", () => {
    console.log("[Client] WebSocket closed");
    Object.values(aiSockets).forEach((socket) => socket.close());
  });

  clientSocket.on("error", (error) => {
    console.error("[Client] WebSocket error:", error);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});

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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";
const MIN_TURNS = 20;
const MAX_TURNS = 40;
// Sales-led flow toggle. Set to false to restore the previous AI-to-AI flow.
const SALES_LED_FLOW = true;

if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is not set.");
  process.exit(1);
}

type AiKey = "ai_a" | "ai_b";

type AiProfile = { name: string; voice: string; instructions: string };
const AI_PROFILES: Record<AiKey, AiProfile> = {
  ai_a: createPattern2InterviewerConfig(),
  ai_b: createPattern2StudentConfig()
};

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

const createRealtimeConnection = (profile: (typeof AI_PROFILES)[AiKey], handlers: RealtimeHandlers) => {
  const ws = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on("open", () => {
    const sessionUpdate = {
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
    };

    ws.send(JSON.stringify(sessionUpdate));
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
  let lastUserTranscript = "";
  let lastUserTranscriptAt = 0;
  let pendingUserCommitAt = 0;
  let waitingForUserTranscript = false;
  let userTranscriptTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAiSpeaker: AiKey | null = null;
  let waitingForHuman = false;
  let manualAdvanceReady = false;
  type Phase = "pattern1" | "pattern2" | "pattern3";
  let phase: Phase = "pattern1";
  type ScenarioMode = "unified" | "pattern1" | "pattern2" | "pattern3";
  let scenarioMode: ScenarioMode = "unified";
  type IntroPhase = "sales_intro" | "student_intro" | "sales_supplement" | "company_overview" | "complete";
  let introPhase: IntroPhase = "complete";
  let companyOverviewPromptPending = false;
  let pendingCandidateRetry = false;
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
  let coverage: Record<CoverageKey, boolean> = {
    experience: false,
    motivation: false,
    language: false,
    shift: false,
    stamina: false,
    visa: false
  };
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
  const isStudentIntroSufficient = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    if (/わからない|知りません|すみません|sorry/i.test(normalized)) return false;
    if (/名前|わたし|私は|です|フィリピン|工場|介護|経験|年|歳|来日/.test(normalized)) {
      return true;
    }
    return normalized.length >= 12;
  };
  const isCandidateNeedsClarification = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return true;
    // Only treat explicit confusion/requests as needing a retry.
    if (/わからない|知りません|難しい|むずかしい|もう一回|もういちど|聞き取れ|聞こえない|理解できない|意味わからない|sorry/i.test(normalized)) {
      return true;
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
    const hasHangul = /[\uAC00-\uD7AF]/.test(normalized);
    if (hasHangul && !hasJapanese) return true;
    if (!hasJapanese && normalized.length <= 3) return true;
    return false;
  };
  const shouldTransitionToPattern2 = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    const hasInterviewer = /面接官|採用担当|企業|担当者/.test(normalized);
    const hasStart = /入室|参加|開始|始め|スタート|面接開始/.test(normalized);
    const hasDismiss = /退室|退出/.test(normalized);
    return hasInterviewer && hasStart && !hasDismiss;
  };
  const shouldTransitionToPattern3 = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    const hasStudent = /学生|生徒|候補者/.test(normalized);
    const hasExit = /退室|退出|退席/.test(normalized);
    return hasStudent && hasExit;
  };
  const shouldPromptCompanyResponse = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    return /印象|感想|いかが|評価|結果|内定|通知書|労働条件|雛形|ビザ|書類|日程/.test(normalized);
  };
  const shouldPromptStudentIntro = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    return /自己紹介|お名前|名前|紹介/.test(normalized);
  };
  const nextAiForSalesFlow = (): AiKey => {
    if (phase === "pattern1") {
      return "ai_b";
    }
    if (phase === "pattern3") {
      return "ai_a";
    }
    if (introPhase === "sales_intro") {
      introPhase = "student_intro";
      return "ai_b";
    }
    if (introPhase === "student_intro") {
      return "ai_b";
    }
    if (introPhase === "sales_supplement") {
      introPhase = "company_overview";
      companyOverviewPromptPending = true;
      return "ai_a";
    }
    if (introPhase === "company_overview") {
      companyOverviewPromptPending = true;
      return "ai_a";
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
      "できる"
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

  const emitPhaseUpdate = (nextPhase: Phase, reason: "start" | "trigger" | "manual") => {
    sendToClient({ type: "phase_update", phase: nextPhase, reason });
  };

  const setPhase = (nextPhase: Phase, reason: "start" | "trigger" | "manual") => {
    if (scenarioMode !== "unified" && reason !== "start") return;
    if (phase === nextPhase) return;
    phase = nextPhase;
    if (phase === "pattern2") {
      introPhase = "student_intro";
      pendingCandidateRetry = false;
      companyOverviewPromptPending = false;
      studentIntroPromptPending = false;
    }
    if (phase === "pattern3") {
      introPhase = "complete";
      pendingCandidateRetry = false;
      companyOverviewPromptPending = false;
      studentIntroPromptPending = false;
    }
    emitPhaseUpdate(phase, reason);
    sendPhaseContextToCandidate(phase);
    sendPhaseContextToInterviewer(phase);
  };

  const sendPhaseContextToCandidate = (nextPhase: Phase) => {
    if (lastPhaseNotified === nextPhase) return;
    const studentSocket = aiSockets.ai_b;
    if (!studentSocket || studentSocket.readyState !== WebSocket.OPEN) return;
    const text =
      nextPhase === "pattern1"
        ? `Phase: pattern1 (sales vs student training).
Follow the drills when prompted by the sales representative:
- Attendance: when your name is called, respond "はい" (briefly).
- Reaction practice: show simple reactions like "うんうん" or "はい".
- Q&A: if asked "日本でどれくらい働きたい？" answer "日本でずっと働きたいです".
- Q&A: if asked "お仕事大変でも大丈夫？頑張れますか？" answer "大丈夫です。頑張ります".
- If asked for questions to the company, avoid money/relocation/visa. Ask one good question such as:
  "外国人の先輩はいますか？" / "将来リーダーになれますか？" / "入社前に勉強することはありますか？" / "仕事の時に大切なことはありますか？"
- Keep responses short and simple, as usual.`
        : nextPhase === "pattern2"
          ? `Phase: pattern2 (sales-led interview with interviewer present).
Wait for the sales representative to paraphrase before answering.
When prompted by the sales representative:
- For self-introduction, give your name and one short background detail.
- If asked "日本でどれくらい働きたい？" answer "日本でずっと働きたいです".
- If asked "お仕事大変でも大丈夫？頑張れますか？" answer "大丈夫です。頑張ります".
- If asked for questions to the company, avoid money/relocation/visa. Ask one good question like:
  "外国人の先輩はいますか？" / "将来リーダーになれますか？" / "入社前に勉強することはありますか？" / "仕事の時に大切なことはありますか？".
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
    const text =
      nextPhase === "pattern1"
        ? `Phase: pattern1 (sales vs student training).
Do not speak. Wait until pattern2 or pattern3.`
        : nextPhase === "pattern2"
          ? `Phase: pattern2 (sales-led interview with interviewer present).
Wait for the sales representative to prompt you before each question.
If asked to introduce the job or company atmosphere, respond briefly first, then proceed with questions.
Do not ask candidates directly; let the sales representative relay in simpler words.
Avoid visa-related questions while students are present.`
          : `Phase: pattern3 (post-interview closing with the company only).
Students have left. Respond as the hiring company representative.
Follow this flow when the sales rep prompts you:
- Impressions: share overall impressions without saying "難しい" or "良い悪い".
- If you have not decided yet, say you will review internally and can reply within 2-3 days.
- If asked about an offer/conditions document (労働条件通知書), agree and choose a cooperative path:
  either request their template (雛形) or say you will send your company format.
- When sales explains the 技人国ビザ and career-up expectations, acknowledge and confirm understanding.
- If asked about required documents or next steps, acknowledge and be cooperative.
When the sales rep says the closing is done (e.g., "以上で終了です" / "本日はありがとうございました"), end with "【面接終了】".
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

  const handleUserUtteranceReady = (transcript: string) => {
    const normalized = transcript.trim();
    if (!normalized || sessionEnded) return;

    let forceNextAi: AiKey | null = null;
    let skipCandidateForward = false;
    let suppressAutoAdvance = false;
    if (
      SALES_LED_FLOW &&
      scenarioMode === "unified" &&
      phase === "pattern1" &&
      shouldTransitionToPattern2(normalized)
    ) {
      setPhase("pattern2", "trigger");
      introPhase = "student_intro";
      skipCandidateForward = true;
      suppressAutoAdvance = true;
    }
    if (
      SALES_LED_FLOW &&
      scenarioMode === "unified" &&
      phase === "pattern2" &&
      shouldTransitionToPattern3(normalized)
    ) {
      setPhase("pattern3", "trigger");
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
      introPhase === "student_intro" &&
      shouldPromptStudentIntro(normalized)
    ) {
      studentIntroPromptPending = true;
      forceNextAi = "ai_b";
      skipCandidateForward = true;
    }
    if (
      suppressAutoAdvance &&
      studentIntroPromptPending &&
      forceNextAi === "ai_b"
    ) {
      suppressAutoAdvance = false;
    }

    if (SALES_LED_FLOW && !skipCandidateForward && phase !== "pattern3") {
      lastSalesUtterance = normalized;
      const studentSocket = aiSockets.ai_b;
      if (studentSocket && studentSocket.readyState === WebSocket.OPEN) {
        studentSocket.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `[営業が言いました]: ${lastSalesUtterance}`
                }
              ]
            }
          })
        );
      }
      if (phase === "pattern2") {
        const interviewerSocket = aiSockets.ai_a;
        if (interviewerSocket && interviewerSocket.readyState === WebSocket.OPEN) {
          interviewerSocket.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: `[営業が面接官に伝えました]: ${lastSalesUtterance}`
                  }
                ]
              }
            })
          );
        }
      }
    }

    if (autoMode) {
      if (suppressAutoAdvance) {
        waitingForHuman = true;
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
        if (!waitingForHuman && lastAiSpeaker !== null) {
          return;
        }
        const nextAi = pendingCandidateRetry ? "ai_b" : nextAiForSalesFlow();
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
        const nextAi = pendingCandidateRetry ? "ai_b" : nextAiForSalesFlow();
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
    const profile = AI_PROFILES[key];
    return createRealtimeConnection(profile, {
      onReady: () => {
        sessionReady[key] = true;
        if (pendingStart && sessionReady.ai_a && sessionReady.ai_b) {
          pendingStart = false;
          sendToClient({ type: "sessions_ready" });
          sendPhaseContextToCandidate(phase);
          sendPhaseContextToInterviewer(phase);
          if (autoMode) {
            if (SALES_LED_FLOW) {
              waitingForHuman = true;
              lastAiSpeaker = null;
            } else {
              requestAiResponse("ai_a");
            }
          }
        }
      },
      onAudioDelta: (audioBase64) => {
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
        logEvent(key, "audio_done");
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
      onTranscriptDone: (transcript) => {
        const finalText = transcript || transcriptBuffers[key];
        transcriptBuffers[key] = "";
        transcriptFinalText[key] = finalText;
        transcriptDone[key] = true;
        logEvent(key, "transcript_done", `len=${finalText.length}`);
        totalTurns += 1;
        if (SALES_LED_FLOW && phase === "pattern2") {
          if (key === "ai_b") {
            if (introPhase === "student_intro") {
              if (isStudentIntroSufficient(finalText)) {
                introPhase = "sales_supplement";
              }
            }
            const needsClarification = isCandidateNeedsClarification(finalText);
            pendingCandidateRetry = needsClarification;
          }
          if (key === "ai_a" && introPhase === "company_overview") {
            introPhase = "complete";
          }
        }
        if (key === "ai_a") {
          updateCoverage(finalText);
        }
        if (endMarkers.some((marker) => finalText.includes(marker))) {
          if (phase === "pattern3") {
            endSession("marker");
          } else if (totalTurns >= MIN_TURNS && hasAllCoverage()) {
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
            }
          }
        } else if (totalTurns >= MAX_TURNS) {
          endSession("max_turns");
        }
        if (audioDone[key] && transcriptFinalText[key] && !transcriptSent[key]) {
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
        const normalized = transcript.trim();
        if (!normalized) return;
        if (isNoiseUserTranscript(normalized)) {
          if (waitingForUserTranscript) {
            waitingForUserTranscript = false;
            pendingUserCommitAt = 0;
            clearUserTranscriptTimer();
            sendToClient({ type: "user_no_speech" });
          }
          return;
        }
        const now = Date.now();
        if (normalized === lastUserTranscript && now - lastUserTranscriptAt < 2000) {
          return;
        }
        lastUserTranscript = normalized;
        lastUserTranscriptAt = now;
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
            handleUserUtteranceReady(normalized);
          }
        }
      },
      onInputTranscript: () => {},
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
    setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (key === "ai_a" && companyOverviewPromptPending) {
        companyOverviewPromptPending = false;
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
                    "Before asking questions, briefly explain the job responsibilities and workplace atmosphere for this role. Keep it concise."
                }
              ]
            }
          })
        );
      }
      if (key === "ai_b" && studentIntroPromptPending) {
        studentIntroPromptPending = false;
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
                    "Give a very short self-introduction now. Keep it simple and consistent: name + origin + short care/helper experience. Example: 「ジョンです。フィリピン出身。介護施設で補助、少し。」"
                }
              ]
            }
          })
        );
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
      turnId?: number;
      mode?: "auto" | "step";
      phase?: Phase;
      scenario?: ScenarioMode;
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
      manualAdvanceReady = false;
      scenarioMode = message.scenario ?? "unified";
      if (SALES_LED_FLOW) {
        if (scenarioMode === "pattern2") {
          phase = "pattern2";
        } else if (scenarioMode === "pattern3") {
          phase = "pattern3";
        } else {
          phase = "pattern1";
        }
        if (phase === "pattern2") {
          introPhase = "student_intro";
        } else if (phase === "pattern3") {
          introPhase = "complete";
        } else {
          introPhase = "sales_intro";
        }
        studentIntroPromptPending = false;
      } else {
        phase = "pattern2";
        introPhase = "complete";
        studentIntroPromptPending = false;
      }
      emitPhaseUpdate(phase, "start");
      lastPhaseNotified = null;
      coverage = {
        experience: false,
        motivation: false,
        language: false,
        shift: false,
        stamina: false,
        visa: false
      };
      if (sessionReady.ai_a && sessionReady.ai_b) {
        sendToClient({ type: "sessions_ready" });
        sendPhaseContextToCandidate(phase);
        sendPhaseContextToInterviewer(phase);
        if (!SALES_LED_FLOW) {
          if (autoMode) {
            requestAiResponse("ai_a");
          } else {
            queuedNextKeys = ["ai_a"];
            manualAdvanceReady = true;
          }
        }
      } else {
        pendingStart = true;
        sendToClient({ type: "waiting_for_sessions" });
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

    if (message.type === "user_audio_commit") {
      Object.values(aiSockets).forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
      });
      lastSalesUtterance = "";
      queuedNextKeys = [];
      manualAdvanceReady = false;
      waitingForUserTranscript = true;
      pendingUserCommitAt = Date.now();
      clearUserTranscriptTimer();
      userTranscriptTimer = setTimeout(() => {
        if (!waitingForUserTranscript) return;
        waitingForUserTranscript = false;
        pendingUserCommitAt = 0;
        lastSalesUtterance = "";
        sendToClient({ type: "user_no_speech" });
      }, 3000);
      return;
    }

    if (message.type === "user_speaking") {
      userSpeaking = true;
      return;
    }

    if (message.type === "user_done") {
      userSpeaking = false;
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

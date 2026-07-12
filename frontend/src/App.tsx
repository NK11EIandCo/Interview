import { useEffect, useRef, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { initializeApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

const WS_STATUS = {
  connecting: "connecting",
  open: "open",
  closed: "closed",
  error: "error"
} as const;

type WsStatus = (typeof WS_STATUS)[keyof typeof WS_STATUS];

type TranscriptItem = {
  source: "ai_a" | "ai_b" | "user" | "system";
  name: string;
  text: string;
  status: "streaming" | "final";
  id: string;
  phase: "pattern1" | "pattern2" | "pattern3";
};

type TranscriptDelta = {
  source: "ai_a" | "ai_b";
  name: string;
  delta: string;
  turnId: number;
};

type CandidateLanguageLevel = "basic" | "standard" | "prototype";
type InterviewIndustry =
  | "construction"
  | "food"
  | "manufacturing"
  | "hotel"
  | "care";
type InterviewerPersonality =
  | "balanced"
  | "meticulous"
  | "rough"
  | "curious";
type InterviewerLiteracy = "low" | "medium" | "high";
type InterviewerDialect = "standard" | "kansai";
type InterviewDifficulty = "easy" | "hard";

type CandidateBrief = {
  industry: string;
  name: string;
  nationality: string;
  targetRole: string;
  languageLevel: string;
  experience: string[];
  strengths: string[];
  note?: string;
};

type AppConfig = {
  firebase?: {
    apiKey?: string;
    authDomain?: string;
    projectId?: string;
    storageBucket?: string;
    messagingSenderId?: string;
    appId?: string;
  };
  supabase?: {
    url?: string;
    anonKey?: string;
  };
};

declare global {
  interface Window {
    APP_CONFIG?: AppConfig;
  }
}

const getWsUrl = () => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const portOverride = import.meta.env.VITE_WS_PORT;
  const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const port = portOverride ?? (isLocalhost ? "3000" : "");
  const host = port
    ? `${window.location.hostname}:${Number.parseInt(port, 10)}`
    : window.location.host;
  return `${protocol}://${host}/ws`;
};

const getApiUrl = (pathname: string) => {
  const protocol = window.location.protocol;
  const portOverride = import.meta.env.VITE_API_PORT ?? import.meta.env.VITE_WS_PORT;
  const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const port = portOverride ?? (isLocalhost ? "3000" : "");
  const host = port
    ? `${window.location.hostname}:${Number.parseInt(port, 10)}`
    : window.location.host;
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${protocol}//${host}${normalizedPath}`;
};

const SYSTEM_TRANSCRIPT_NAME = "__system__";
const USER_TRANSCRIPT_TIMEOUT_MS = 8000;

const decodeBase64ToInt16 = (base64: string) => {
  const binary = window.atob(base64);
  const len = binary.length;
  const buffer = new ArrayBuffer(len);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(buffer);
};

const encodeInt16ToBase64 = (int16: Int16Array) => {
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
};

const float32ToInt16 = (float32Array: Float32Array) => {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
};

const initFirebase = (config?: AppConfig["firebase"]): Auth | null => {
  if (!config?.apiKey) return null;
  const app = initializeApp(config);
  return getAuth(app);
};

const initSupabase = (config?: AppConfig["supabase"]): SupabaseClient | null => {
  if (!config?.url || !config?.anonKey) return null;
  return createClient(config.url, config.anonKey);
};

const getCandidateLanguageLevelLabel = (level: CandidateLanguageLevel | string) => {
  switch (level) {
    case "basic":
      return "初級";
    case "standard":
      return "中級";
    case "prototype":
      return "上級";
    default:
      return level;
  }
};

type SystemNotice = {
  kind: "no_speech" | "relay_target_unclear" | "mic_error";
  title: string;
  detail: string;
  guidance: string;
};

type EvaluationCategoryKey =
  | "facilitation"
  | "closing"
  | "knowledge"
  | "communication";

type EvaluationCategoryResult = {
  score: number | null;
  label: string;
  summary: string;
  evidence: string[];
};

type EvaluationNgFinding = {
  phrase: string;
  reason: string;
  category: EvaluationCategoryKey;
  phase: "pattern1" | "pattern2" | "pattern3" | "unknown";
};

type InterviewEvaluationResult = {
  overallScore: number | null;
  overallLabel: string;
  overallComment: string;
  categories: Record<EvaluationCategoryKey, EvaluationCategoryResult>;
  goodPoints: string[];
  improvementPoints: string[];
  conversationIssues: string[];
  ngFindings: EvaluationNgFinding[];
};

type SessionEvaluationContext = {
  scenarioMode: "unified" | "pattern1" | "pattern2" | "pattern3";
  candidateLevel: CandidateLanguageLevel;
  industry: InterviewIndustry;
  interviewerDifficulty: InterviewDifficulty;
  interviewerLiteracy: InterviewerLiteracy;
  interviewerPersonality: InterviewerPersonality;
  interviewerDialect: InterviewerDialect;
};

const EVALUATION_CATEGORY_LABELS: Record<EvaluationCategoryKey, string> = {
  facilitation: "進行管理",
  closing: "クロージング",
  knowledge: "知識正確性",
  communication: "態度・伝わり方"
};

export const App = () => {
  const [wsStatus, setWsStatus] = useState<WsStatus>(WS_STATUS.connecting);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [, setLogs] = useState<string[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [scriptHint, setScriptHint] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [flowMode, setFlowMode] = useState<"auto" | "step">("auto");
  const [candidateLanguageLevel, setCandidateLanguageLevel] =
    useState<CandidateLanguageLevel>(() => {
      try {
        const saved = window.localStorage.getItem(
          "interview.candidateLanguageLevel"
        );
        if (
          saved === "basic" ||
          saved === "standard" ||
          saved === "prototype"
        ) {
          return saved;
        }
      } catch {
        return "basic";
      }
      return "basic";
    });
  const [industry, setIndustry] = useState<InterviewIndustry>(() => {
    try {
      const saved = window.localStorage.getItem("interview.industry");
      if (
        saved === "construction" ||
        saved === "food" ||
        saved === "manufacturing" ||
        saved === "hotel"
      ) {
        return saved;
      }
    } catch {
      return "construction";
    }
    return "construction";
  });
  const [interviewerPersonality, setInterviewerPersonality] =
    useState<InterviewerPersonality>(() => {
      try {
        const saved = window.localStorage.getItem("interview.personality");
        if (
          saved === "balanced" ||
          saved === "meticulous" ||
          saved === "rough" ||
          saved === "curious"
        ) {
          return saved;
        }
      } catch {
        return "balanced";
      }
      return "balanced";
    });
  const [interviewerLiteracy, setInterviewerLiteracy] =
    useState<InterviewerLiteracy>(() => {
      try {
        const saved = window.localStorage.getItem("interview.literacy");
        if (saved === "low" || saved === "medium" || saved === "high") {
          return saved;
        }
      } catch {
        return "medium";
      }
      return "medium";
    });
  const [interviewerDialect, setInterviewerDialect] =
    useState<InterviewerDialect>(() => {
      try {
        const saved = window.localStorage.getItem("interview.dialect");
        if (saved === "standard" || saved === "kansai") {
          return saved;
        }
      } catch {
        return "standard";
      }
      return "standard";
    });
  const [interviewerDifficulty, setInterviewerDifficulty] =
    useState<InterviewDifficulty>(() => {
      try {
        const saved = window.localStorage.getItem("interview.difficulty");
        if (saved === "easy" || saved === "hard") {
          return saved;
        }
        if (saved === "beginner") {
          return "easy";
        }
      } catch {
        return "easy";
      }
      return "easy";
    });
  const [sceneNote, setSceneNote] = useState(() => {
    try {
      return window.localStorage.getItem("interview.sceneNote") ?? "";
    } catch {
      return "";
    }
  });
  const [manualAdvanceReady, setManualAdvanceReady] = useState(false);
  const [, setInterruptPending] = useState(false);
  const [awaitingUserTranscript, setAwaitingUserTranscript] = useState(false);
  const [awaitingAiResponse, setAwaitingAiResponse] = useState(false);
  const [systemNotice, setSystemNotice] = useState<SystemNotice | null>(null);
  const [activeAiStreamingCount, setActiveAiStreamingCount] = useState(0);
  const [phase, setPhase] = useState<"pattern1" | "pattern2" | "pattern3">("pattern1");
  const [scenarioMode, setScenarioMode] = useState<
    "unified" | "pattern1" | "pattern2" | "pattern3"
  >("unified");
  const [candidateProfile, setCandidateProfile] = useState<CandidateBrief | null>(null);
  const [, setConfigStatus] = useState({
    firebase: false,
    supabase: false
  });
  const [textInputEnabled, setTextInputEnabled] = useState(() => {
    try {
      return window.localStorage.getItem("interview.textInputEnabled") === "true";
    } catch {
      return false;
    }
  });
  const [hintEnabled, setHintEnabled] = useState(() => {
    try {
      const saved = window.localStorage.getItem("interview.hintEnabled");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [textInputDraft, setTextInputDraft] = useState("");
  const [sessionStarted, setSessionStarted] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [completedPracticePhases, setCompletedPracticePhases] = useState<
    Record<"pattern1" | "pattern2" | "pattern3", boolean>
  >({
    pattern1: false,
    pattern2: false,
    pattern3: false
  });
  const [sessionEvaluationContext, setSessionEvaluationContext] =
    useState<SessionEvaluationContext | null>(null);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [evaluationResult, setEvaluationResult] =
    useState<InterviewEvaluationResult | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const recordingRef = useRef(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const nextPlaybackTimeRef = useRef(0);
  const playbackEndTimeRef = useRef<Record<string, number>>({});
  const transcriptWrapRef = useRef<HTMLDivElement | null>(null);
  const activeTranscriptRef = useRef<Record<string, string>>({});
  const transcriptCounterRef = useRef(0);
  const pendingTranscriptQueueRef = useRef<Record<string, TranscriptDelta[]>>({});
  const pendingFinalRef = useRef<Record<string, string | null>>({});
  const pendingFinalNameRef = useRef<Record<string, string>>({});
  const playbackDoneTimerRef = useRef<Record<string, number | null>>({});
  const playbackSafetyTimerRef = useRef<Record<string, number | null>>({});
  const playbackReportedRef = useRef<Record<string, boolean>>({});
  const finalizeSafetyTimerRef = useRef<Record<string, number | null>>({});
  const finalizeTimerRef = useRef<Record<string, number | null>>({});
  const audioDoneRef = useRef<Record<string, boolean>>({});
  const activeTurnRef = useRef<Record<string, number>>({});
  const finalizedTurnRef = useRef<Record<string, boolean>>({});
  const awaitingUserTimerRef = useRef<number | null>(null);
  const activeAiTurnKeysRef = useRef<Set<string>>(new Set());
  const hasConnectedRef = useRef(false);
  const interruptPendingRef = useRef(false);
  const interruptSilenceFramesRef = useRef(0);
  const interruptStopRequestedRef = useRef(false);
  const awaitingUserTranscriptRef = useRef(false);
  const detectedSpeechFramesRef = useRef(0);
  const speechDetectedRef = useRef(false);
  const scenarioModeRef = useRef(scenarioMode);
  const phaseRef = useRef(phase);

  const getTurnKey = (source: string, turnId: number) => `${source}:${turnId}`;

  const appendLog = (message: string) => {
    setLogs((prev) => [message, ...prev].slice(0, 30));
  };
  const clearSystemNotice = () => {
    setSystemNotice(null);
  };
  const showNoSpeechNotice = () => {
    setSystemNotice({
      kind: "no_speech",
      title: "音声が認識されていません。",
      detail: "無音、雑音、または音量不足の可能性があります。",
      guidance: "もう一度 Start Mic を押して、短く区切って話してください。"
    });
  };
  const showMicErrorNotice = (error?: unknown) => {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "マイクの初期化に失敗しました。";
    const insecureContext =
      !window.isSecureContext &&
      window.location.hostname !== "localhost" &&
      window.location.hostname !== "127.0.0.1";
    setSystemNotice({
      kind: "mic_error",
      title: "マイクを開始できませんでした。",
      detail: insecureContext
        ? "このページは安全な接続ではないため、ブラウザがマイク利用を許可していません。"
        : message,
      guidance: insecureContext
        ? "HTTPS または localhost で開き直して、もう一度お試しください。"
        : "ブラウザのマイク権限を確認してから、もう一度 Start Mic を押してください。"
    });
  };
  const showRelayTargetUnclearNotice = (noticePhase?: "pattern1" | "pattern2" | "pattern3") => {
    if (noticePhase === "pattern3") {
      setSystemNotice({
        kind: "relay_target_unclear",
        title: "返答不要の発話として処理されました。",
        detail: "そのまま発言を続けてください。",
        guidance: ""
      });
      return;
    }
    setSystemNotice({
      kind: "relay_target_unclear",
      title: "この発話だけでは次の相手が決まりませんでした。",
      detail: "候補者向けか面接官向けか判断できないか、返答不要の発話として処理されました。",
      guidance: "そのまま続けて、誰に向けた発話か少し分かるように話してください。"
    });
  };

  const resetConversationState = () => {
    setTranscripts([]);
    setScriptHint(null);
    setInterruptPending(false);
    setManualAdvanceReady(false);
    setAwaitingUserTranscript(false);
    setAwaitingAiResponse(false);
    clearSystemNotice();
    setActiveAiStreamingCount(0);
    setPhase("pattern1");
    setCandidateProfile(null);
    setSessionStarted(false);
    setSessionEnded(false);
    setCompletedPracticePhases({
      pattern1: false,
      pattern2: false,
      pattern3: false
    });
    setSessionEvaluationContext(null);
    setEvaluationLoading(false);
    setEvaluationError(null);
    setEvaluationResult(null);
    activeAiTurnKeysRef.current.clear();
    activeTranscriptRef.current = {};
    pendingTranscriptQueueRef.current = {};
    pendingFinalRef.current = {};
    pendingFinalNameRef.current = {};
    audioDoneRef.current = {};
    playbackEndTimeRef.current = {};
    activeTurnRef.current = {};
    finalizedTurnRef.current = {};
    if (awaitingUserTimerRef.current) {
      window.clearTimeout(awaitingUserTimerRef.current);
      awaitingUserTimerRef.current = null;
    }
    Object.values(playbackDoneTimerRef.current).forEach((timerId) => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    });
    playbackDoneTimerRef.current = {};
    Object.values(playbackSafetyTimerRef.current).forEach((timerId) => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    });
    playbackSafetyTimerRef.current = {};
    Object.values(finalizeSafetyTimerRef.current).forEach((timerId) => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    });
    finalizeSafetyTimerRef.current = {};
    Object.values(finalizeTimerRef.current).forEach((timerId) => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    });
    finalizeTimerRef.current = {};
    playbackReportedRef.current = {};
    interruptPendingRef.current = false;
    interruptSilenceFramesRef.current = 0;
    interruptStopRequestedRef.current = false;
  };

  const markAiStreamingStart = (turnKey: string) => {
    if (!activeAiTurnKeysRef.current.has(turnKey)) {
      activeAiTurnKeysRef.current.add(turnKey);
      setActiveAiStreamingCount(activeAiTurnKeysRef.current.size);
    }
  };

  const markAiStreamingDone = (turnKey: string) => {
    if (activeAiTurnKeysRef.current.delete(turnKey)) {
      setActiveAiStreamingCount(activeAiTurnKeysRef.current.size);
    }
  };

  const reportPlaybackDone = (
    sourceKey: string,
    turnId: number,
    turnKey: string
  ) => {
    if (playbackReportedRef.current[turnKey]) return;
    playbackReportedRef.current[turnKey] = true;
    if (playbackDoneTimerRef.current[turnKey]) {
      window.clearTimeout(playbackDoneTimerRef.current[turnKey] ?? 0);
      playbackDoneTimerRef.current[turnKey] = null;
    }
    if (playbackSafetyTimerRef.current[turnKey]) {
      window.clearTimeout(playbackSafetyTimerRef.current[turnKey] ?? 0);
      playbackSafetyTimerRef.current[turnKey] = null;
    }
    sendMessage({ type: "audio_playback_done", target: sourceKey, turnId });
  };

  const forceFinalizeTurn = (turnKey: string) => {
    if (playbackDoneTimerRef.current[turnKey]) {
      window.clearTimeout(playbackDoneTimerRef.current[turnKey] ?? 0);
      playbackDoneTimerRef.current[turnKey] = null;
    }
    if (playbackSafetyTimerRef.current[turnKey]) {
      window.clearTimeout(playbackSafetyTimerRef.current[turnKey] ?? 0);
      playbackSafetyTimerRef.current[turnKey] = null;
    }
    if (finalizeSafetyTimerRef.current[turnKey]) {
      window.clearTimeout(finalizeSafetyTimerRef.current[turnKey] ?? 0);
      finalizeSafetyTimerRef.current[turnKey] = null;
    }
    if (finalizeTimerRef.current[turnKey]) {
      window.clearTimeout(finalizeTimerRef.current[turnKey] ?? 0);
      finalizeTimerRef.current[turnKey] = null;
    }
    const finalText = pendingFinalRef.current[turnKey];
    const finalName = pendingFinalNameRef.current[turnKey] ?? "Speaker";
    const source = turnKey.startsWith("ai_b:") ? "ai_b" : "ai_a";
    const currentId = activeTranscriptRef.current[turnKey];

    if (currentId && finalText) {
      setTranscripts((prev) =>
        prev.map((item) =>
          item.id === currentId ? { ...item, text: finalText, status: "final" } : item
        )
      );
      delete activeTranscriptRef.current[turnKey];
    } else if (finalText) {
      const finalItem: TranscriptItem = {
        id: `${Date.now()}-${turnKey}-${transcriptCounterRef.current++}`,
        source,
        name: finalName,
        text: finalText,
        status: "final",
        phase: phaseRef.current
      };
      setTranscripts((prev) => [...prev, finalItem]);
    }

    pendingFinalRef.current[turnKey] = null;
    pendingTranscriptQueueRef.current[turnKey] = [];
    audioDoneRef.current[turnKey] = false;
    finalizedTurnRef.current[turnKey] = true;
    markAiStreamingDone(turnKey);
  };

  const forceFinalizePendingAiTurns = () => {
    Array.from(activeAiTurnKeysRef.current).forEach((turnKey) => {
      if (!finalizedTurnRef.current[turnKey]) {
        forceFinalizeTurn(turnKey);
      }
    });
  };

  const sendMessage = (payload: object) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  };
  const startSession = () => {
    const nextSessionContext: SessionEvaluationContext = {
      scenarioMode,
      candidateLevel: candidateLanguageLevel,
      industry,
      interviewerDifficulty,
      interviewerLiteracy,
      interviewerPersonality,
      interviewerDialect
    };
    clearSystemNotice();
    resetConversationState();
    setSessionEvaluationContext(nextSessionContext);
    setSessionStarted(true);
    setSessionEnded(false);
    setCompletedPracticePhases({
      pattern1: false,
      pattern2: false,
      pattern3: false
    });
    setManualAdvanceReady(false);
    sendMessage({
      type: "start",
      mode: flowMode,
      scenario: scenarioMode,
      candidateLevel: candidateLanguageLevel,
      industry,
      personality: interviewerPersonality,
      literacy: interviewerLiteracy,
      dialect: interviewerDialect,
      difficulty: interviewerDifficulty,
      note: sceneNote
    });
  };

  const canStartMic =
    wsStatus === WS_STATUS.open &&
    sessionsReady &&
    !sessionEnded &&
    !completedPracticePhases[phase] &&
    !recording &&
    !awaitingUserTranscript &&
    !awaitingAiResponse &&
    activeAiStreamingCount === 0;
  const settingsLocked = sessionStarted && !sessionEnded;
  const canSubmitText =
    textInputEnabled &&
    wsStatus === WS_STATUS.open &&
    sessionsReady &&
    !sessionEnded &&
    !completedPracticePhases[phase] &&
    !recording &&
    !awaitingUserTranscript &&
    !awaitingAiResponse &&
    activeAiStreamingCount === 0 &&
    textInputDraft.trim().length > 0;
  const canExportConversationPdf = transcripts.length > 0;
  const canRequestEvaluation =
    sessionEvaluationContext !== null &&
    (completedPracticePhases[phase] || sessionEnded) &&
    transcripts.some(
      (item) =>
        item.source === "user" &&
        item.status === "final" &&
        item.phase === phase &&
        item.text.trim()
    ) &&
    !recording &&
    !awaitingUserTranscript &&
    !awaitingAiResponse &&
    activeAiStreamingCount === 0 &&
    !evaluationLoading;

  const getEvaluationScoreText = (score: number | null) =>
    score === null ? "未評価" : `${score.toFixed(1)} / 5`;

  const startRecording = async () => {
    if (recordingRef.current) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("このブラウザではマイク入力を利用できません。");
      }
      clearSystemNotice();
      setInterruptPending(false);
      interruptPendingRef.current = false;
      interruptSilenceFramesRef.current = 0;
      interruptStopRequestedRef.current = false;
      detectedSpeechFramesRef.current = 0;
      speechDetectedRef.current = false;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 24000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const audioContext = new AudioContext({ sampleRate: 24000 });
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const zeroGain = audioContext.createGain();
      zeroGain.gain.value = 0;

      processor.onaudioprocess = (event) => {
        if (!recordingRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        let sumSquares = 0;
        for (let i = 0; i < input.length; i += 1) {
          sumSquares += input[i] * input[i];
        }
        const rms = Math.sqrt(sumSquares / input.length);
        if (rms >= 0.014) {
          detectedSpeechFramesRef.current += 1;
          if (detectedSpeechFramesRef.current >= 2) {
            speechDetectedRef.current = true;
          }
        }
        const int16 = float32ToInt16(input);
        const base64 = encodeInt16ToBase64(int16);
        sendMessage({ type: "user_audio", data: base64 });
        if (interruptPendingRef.current) {
          if (rms < 0.012) {
            interruptSilenceFramesRef.current += 1;
          } else {
            interruptSilenceFramesRef.current = 0;
          }
          if (
            interruptSilenceFramesRef.current >= 3 &&
            !interruptStopRequestedRef.current
          ) {
            interruptStopRequestedRef.current = true;
            window.setTimeout(() => {
              if (recordingRef.current) {
                stopRecording("interrupt");
              }
            }, 0);
          }
        }
      };

      source.connect(processor);
      processor.connect(zeroGain);
      zeroGain.connect(audioContext.destination);

      audioContextRef.current = audioContext;
      processorRef.current = processor;
      mediaStreamRef.current = stream;

      recordingRef.current = true;
      sendMessage({ type: "user_speaking" });
      setRecording(true);
      appendLog("Mic streaming on.");
    } catch (error) {
      appendLog(`Mic error: ${(error as Error).message}`);
      showMicErrorNotice(error);
    }
  };

  const stopRecording = (reason: "manual" | "interrupt" = "manual") => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    setInterruptPending(false);
    interruptPendingRef.current = false;
    interruptSilenceFramesRef.current = 0;
    interruptStopRequestedRef.current = false;
    const hasSpeech = speechDetectedRef.current;
    speechDetectedRef.current = false;
    detectedSpeechFramesRef.current = 0;
    if (awaitingUserTimerRef.current) {
      window.clearTimeout(awaitingUserTimerRef.current);
      awaitingUserTimerRef.current = null;
    }
    if (!hasSpeech) {
      sendMessage({ type: "user_audio_clear" });
      sendMessage({ type: "user_done" });
      setAwaitingUserTranscript(false);
      setAwaitingAiResponse(false);
      showNoSpeechNotice();
      setManualAdvanceReady(false);
      appendLog("No speech detected (client VAD).");
    } else {
      sendMessage({ type: "user_audio_commit" });
      sendMessage({ type: "user_done" });
      if (flowMode === "step") {
        setManualAdvanceReady(true);
      }

      setAwaitingUserTranscript(true);
      setAwaitingAiResponse(true);
      awaitingUserTimerRef.current = window.setTimeout(() => {
        setAwaitingUserTranscript(false);
        setAwaitingAiResponse(false);
        showNoSpeechNotice();
        appendLog("No speech detected (client timeout).");
      }, USER_TRANSCRIPT_TIMEOUT_MS);
    }

    processorRef.current?.disconnect();
    processorRef.current = null;

    audioContextRef.current?.close();
    audioContextRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    appendLog(
      reason === "interrupt"
        ? "Mic streaming off (AI cut-in after pause)."
        : "Mic streaming off (audio committed)."
    );
  };

  const requestAdvance = () => {
    sendMessage({ type: "advance" });
    setManualAdvanceReady(false);
  };

  const submitTextInput = () => {
    const normalized = textInputDraft.trim();
    if (!normalized || !canSubmitText) return;
    clearSystemNotice();
    setInterruptPending(false);
    interruptPendingRef.current = false;
    interruptSilenceFramesRef.current = 0;
    interruptStopRequestedRef.current = false;
    setAwaitingUserTranscript(false);
    setAwaitingAiResponse(true);
    sendMessage({ type: "user_text", text: normalized });
    setTextInputDraft("");
    appendLog("Text input submitted.");
  };

  const exportConversationPdf = () => {
    if (!canExportConversationPdf) return;
    window.print();
  };

  const requestInterviewEvaluation = async () => {
    if (!canRequestEvaluation || !sessionEvaluationContext) return;
    setEvaluationLoading(true);
    setEvaluationError(null);
    setEvaluationResult(null);
    try {
      const requestPayload = {
        scenarioMode: phase,
        candidateLevel: sessionEvaluationContext.candidateLevel,
        industry: sessionEvaluationContext.industry,
        interviewerDifficulty: sessionEvaluationContext.interviewerDifficulty,
        interviewerLiteracy: sessionEvaluationContext.interviewerLiteracy,
        interviewerPersonality: sessionEvaluationContext.interviewerPersonality,
        interviewerDialect: sessionEvaluationContext.interviewerDialect,
        transcripts: transcripts
          .filter(
            (item) =>
              item.status === "final" &&
              item.phase === phase &&
              item.text.trim()
          )
          .map((item) => ({
            source: item.source,
            name: item.name,
            text: item.text,
            phase: item.phase
          }))
      };
      let response: Response | null = null;
      let data: InterviewEvaluationResult | { message?: string } | null = null;
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          response = await fetch(getApiUrl("/api/evaluate"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(requestPayload)
          });
          const contentType = response.headers.get("content-type") ?? "";
          data = contentType.includes("application/json")
            ? ((await response.json()) as InterviewEvaluationResult | { message?: string })
            : { message: await response.text() };
          if (response.ok) {
            break;
          }
          lastError = new Error(
            typeof data === "object" && data && "message" in data && data.message
              ? String(data.message)
              : "面接評価の生成に失敗しました。"
          );
        } catch (error) {
          lastError = error as Error;
        }
        if (attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
      }
      if (!response || !response.ok || !data) {
        throw lastError ?? new Error("面接評価の生成に失敗しました。");
      }
      setEvaluationResult(data as InterviewEvaluationResult);
    } catch (error) {
      setEvaluationError((error as Error).message);
      setEvaluationResult(null);
    } finally {
      setEvaluationLoading(false);
    }
  };

  useEffect(() => {
    awaitingUserTranscriptRef.current = awaitingUserTranscript;
  }, [awaitingUserTranscript]);

  useEffect(() => {
    scenarioModeRef.current = scenarioMode;
  }, [scenarioMode]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const appendSystemTranscript = (
    text: string,
    itemPhase: "pattern1" | "pattern2" | "pattern3" = phaseRef.current
  ) => {
    const nextItem: TranscriptItem = {
      id: `${Date.now()}-system-${transcriptCounterRef.current++}`,
      source: "system",
      name: SYSTEM_TRANSCRIPT_NAME,
      text,
      status: "final",
      phase: itemPhase
    };
    setTranscripts((prev) => [...prev, nextItem]);
  };

  const getPhaseLabel = (nextPhase: "pattern1" | "pattern2" | "pattern3") =>
    nextPhase === "pattern1"
      ? "面接前練習"
      : nextPhase === "pattern2"
        ? "面接本番"
        : "面接後ヒアリング";

  const getPhaseActors = (nextPhase: "pattern1" | "pattern2" | "pattern3") =>
    nextPhase === "pattern1"
      ? "営業 + 学生AI"
      : nextPhase === "pattern2"
        ? "営業 + 学生AI + 面接官AI"
        : "営業 + 面接官AI";

  const ensurePlaybackContext = async () => {
    if (!playbackContextRef.current) {
      playbackContextRef.current = new AudioContext({ sampleRate: 24000 });
      nextPlaybackTimeRef.current = playbackContextRef.current.currentTime;
    }
    const ctx = playbackContextRef.current;
    // Browser audio can remain suspended even after AI audio arrives.
    // Keep this explicit resume; removing it can make transcripts appear while playback stays silent.
    if (ctx.state === "suspended") {
      await ctx.resume();
      nextPlaybackTimeRef.current = Math.max(
        nextPlaybackTimeRef.current,
        ctx.currentTime
      );
    }
    return ctx;
  };

  const playAudioChunk = async (
    base64: string,
    speaker: TranscriptDelta["source"],
    turnId: number
  ) => {
    const ctx = await ensurePlaybackContext();
    const int16 = decodeBase64ToInt16(base64);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) {
      float32[i] = int16[i] / 0x8000;
    }

    const buffer = ctx.createBuffer(1, float32.length, ctx.sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startTime = Math.max(ctx.currentTime, nextPlaybackTimeRef.current);
    source.start(startTime);
    const endTime = startTime + buffer.duration;
    nextPlaybackTimeRef.current = endTime;
    const resolvedTurnId =
      Number.isFinite(turnId) && turnId > 0
        ? turnId
        : activeTurnRef.current[speaker] ?? turnId;
    const turnKey = getTurnKey(speaker, resolvedTurnId);
    playbackEndTimeRef.current[turnKey] = endTime;

    const queue = pendingTranscriptQueueRef.current[turnKey];
    if (!queue || queue.length === 0) return;

    const nextDelta = queue.shift();
    if (!nextDelta) return;

    const delayMs = Math.max(0, (startTime - ctx.currentTime) * 1000);
    window.setTimeout(() => {
      if (finalizedTurnRef.current[turnKey]) {
        return;
      }
      setTranscripts((prev) => {
        if (finalizedTurnRef.current[turnKey]) {
          return prev;
        }
        const currentId = activeTranscriptRef.current[turnKey];
        if (!currentId) {
          const nextId = `${Date.now()}-${turnKey}-${transcriptCounterRef.current++}`;
          activeTranscriptRef.current[turnKey] = nextId;
          const nextItem: TranscriptItem = {
            id: nextId,
            source: nextDelta.source,
            name: nextDelta.name,
            text: nextDelta.delta,
            status: "streaming",
            phase: phaseRef.current
          };
          return [
            ...prev,
            nextItem
          ];
        }

        return prev.map((item) =>
          item.id === currentId
            ? { ...item, text: item.text + nextDelta.delta }
            : item
        );
      });
    }, delayMs);
  };

  const scheduleFinalize = (source: TranscriptDelta["source"], turnId: number) => {
    const resolvedTurnId =
      Number.isFinite(turnId) && turnId > 0
        ? turnId
        : activeTurnRef.current[source] ?? turnId;
    const turnKey = getTurnKey(source, resolvedTurnId);
    const finalText = pendingFinalRef.current[turnKey];
    if (!finalText) return;
    if (!audioDoneRef.current[turnKey]) return;
    if (finalizedTurnRef.current[turnKey]) return;
    const ctx = playbackContextRef.current;
    const endTime = playbackEndTimeRef.current[turnKey] ?? 0;
    const finalName = pendingFinalNameRef.current[turnKey] ?? "Speaker";

    const finalize = (text: string, name: string) => {
      if (finalizedTurnRef.current[turnKey]) {
        return;
      }
      setTranscripts((prev) => {
        const currentId = activeTranscriptRef.current[turnKey];
        if (currentId) {
          const updated = prev.map<TranscriptItem>((item) =>
            item.id === currentId
              ? { ...item, text, status: "final" }
              : item
          );
          delete activeTranscriptRef.current[turnKey];
          markAiStreamingDone(turnKey);
          finalizedTurnRef.current[turnKey] = true;
          return updated;
        }

        const finalItem: TranscriptItem = {
          id: `${Date.now()}-${turnKey}-${transcriptCounterRef.current++}`,
          source,
          name,
          text,
          status: "final",
          phase: phaseRef.current
        };
        markAiStreamingDone(turnKey);
        return [...prev, finalItem];
      });

      pendingFinalRef.current[turnKey] = null;
      pendingTranscriptQueueRef.current[turnKey] = [];
      audioDoneRef.current[turnKey] = false;
      finalizedTurnRef.current[turnKey] = true;
      finalizeTimerRef.current[turnKey] = null;
    };

    if (ctx) {
      const delayMs = Math.max(0, (endTime - ctx.currentTime) * 1000);
      if (finalizeTimerRef.current[turnKey]) {
        window.clearTimeout(finalizeTimerRef.current[turnKey] ?? 0);
      }
      finalizeTimerRef.current[turnKey] = window.setTimeout(
        () => finalize(finalText, finalName),
        delayMs
      );
    } else {
      finalize(finalText, finalName);
    }
  };

  useEffect(() => {
    const config = window.APP_CONFIG;
    const firebaseAuth = initFirebase(config?.firebase);
    const supabaseClient = initSupabase(config?.supabase);

    setConfigStatus({
      firebase: Boolean(firebaseAuth),
      supabase: Boolean(supabaseClient)
    });

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setWsStatus(WS_STATUS.open);
      appendLog("WebSocket connected.");
      if (hasConnectedRef.current) {
        resetConversationState();
        setSessionsReady(false);
      }
      hasConnectedRef.current = true;
    });

    ws.addEventListener("close", () => {
      setWsStatus(WS_STATUS.closed);
      setSessionStarted(false);
      setInterruptPending(false);
      setAwaitingAiResponse(false);
      interruptPendingRef.current = false;
      appendLog("WebSocket closed.");
      setManualAdvanceReady(false);
    });

    ws.addEventListener("error", () => {
      setWsStatus(WS_STATUS.error);
      setSessionStarted(false);
      setInterruptPending(false);
      setAwaitingAiResponse(false);
      interruptPendingRef.current = false;
      appendLog("WebSocket error.");
      setManualAdvanceReady(false);
    });

    ws.addEventListener("message", (event) => {
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type === "sessions_ready") {
        setSessionsReady(true);
        appendLog("Sessions ready.");
      }

      if (payload.type === "script_hint") {
        setScriptHint(String(payload.text ?? ""));
      }

      if (payload.type === "candidate_profile") {
        setCandidateProfile(payload.profile as CandidateBrief);
      }

      if (payload.type === "interrupt_pending") {
        setInterruptPending(true);
        interruptPendingRef.current = true;
        interruptSilenceFramesRef.current = 0;
        appendLog("Interviewer is preparing to cut in.");
      }

      if (payload.type === "session_ended") {
        clearSystemNotice();
        setSessionEnded(true);
        setCompletedPracticePhases((prev) => ({
          ...prev,
          [phaseRef.current]: true
        }));
        setAwaitingAiResponse(false);
        appendLog(
          payload.reason === "max_turns"
            ? "Session ended: max turns reached."
            : "Session ended: marker detected."
        );
      }

      if (payload.type === "waiting_for_sessions") {
        setInterruptPending(false);
        setAwaitingAiResponse(false);
        interruptPendingRef.current = false;
        appendLog("Waiting for OpenAI sessions...");
      }

      if (payload.type === "phase_update") {
        clearSystemNotice();
        const nextPhase =
          payload.phase === "pattern3"
            ? "pattern3"
            : payload.phase === "pattern2"
              ? "pattern2"
              : "pattern1";
        const previousPhase = phaseRef.current;
        setPhase(nextPhase);
        appendLog(`Phase switched to ${nextPhase}.`);
        if (
          scenarioModeRef.current === "unified" &&
          (previousPhase !== nextPhase || payload.reason === "start")
        ) {
          appendSystemTranscript(
            `${getPhaseLabel(nextPhase)}（${getPhaseActors(nextPhase)}）`,
            nextPhase
          );
        }
      }

      if (payload.type === "phase_practice_complete") {
        const completedPhase =
          payload.phase === "pattern3"
            ? "pattern3"
            : payload.phase === "pattern2"
              ? "pattern2"
              : "pattern1";
        setCompletedPracticePhases((prev) => ({
          ...prev,
          [completedPhase]: true
        }));
        setAwaitingAiResponse(false);
        appendLog(`Practice completed for ${completedPhase}.`);
      }

      if (payload.type === "human_turn_ready") {
        setAwaitingAiResponse(false);
        forceFinalizePendingAiTurns();
        appendLog("Human turn ready.");
      }

      if (payload.type === "audio") {
        void playAudioChunk(
          payload.data,
          payload.source,
          Number(payload.turnId ?? 0)
        );
      }

      if (payload.type === "audio_start") {
        setAwaitingAiResponse(false);
        const sourceKey = String(payload.source ?? "ai_a");
        const turnId = Number(payload.turnId ?? 0);
        const resolvedTurnId =
          Number.isFinite(turnId) && turnId > 0
            ? turnId
            : activeTurnRef.current[sourceKey] ?? turnId;
        activeTurnRef.current[sourceKey] = resolvedTurnId;
        const turnKey = getTurnKey(sourceKey, resolvedTurnId);
        markAiStreamingStart(turnKey);
        playbackReportedRef.current[turnKey] = false;
        if (playbackDoneTimerRef.current[turnKey]) {
          window.clearTimeout(playbackDoneTimerRef.current[turnKey] ?? 0);
          playbackDoneTimerRef.current[turnKey] = null;
        }
        if (playbackSafetyTimerRef.current[turnKey]) {
          window.clearTimeout(playbackSafetyTimerRef.current[turnKey] ?? 0);
          playbackSafetyTimerRef.current[turnKey] = null;
        }
        if (finalizeSafetyTimerRef.current[turnKey]) {
          window.clearTimeout(finalizeSafetyTimerRef.current[turnKey] ?? 0);
          finalizeSafetyTimerRef.current[turnKey] = null;
        }
        const currentId = activeTranscriptRef.current[turnKey];
        if (!currentId) {
          const nextId = `${Date.now()}-${turnKey}-${transcriptCounterRef.current++}`;
          activeTranscriptRef.current[turnKey] = nextId;
          pendingTranscriptQueueRef.current[turnKey] ??= [];
          finalizedTurnRef.current[turnKey] = false;
          const nextItem: TranscriptItem = {
            id: nextId,
            source: payload.source === "ai_b" ? "ai_b" : "ai_a",
            name: String(payload.name ?? "Speaker"),
            text: "",
            status: "streaming",
            phase: phaseRef.current
          };
          setTranscripts((prev) => [
            ...prev,
            nextItem
          ]);
        }
      }

      if (payload.type === "transcript_delta") {
        const deltaText = String(payload.delta ?? "");
        if (deltaText) {
          const sourceKey = String(payload.source ?? "ai_a");
          const turnId = Number(payload.turnId ?? 0);
          const resolvedTurnId =
            Number.isFinite(turnId) && turnId > 0
              ? turnId
              : activeTurnRef.current[sourceKey] ?? turnId;
          const turnKey = getTurnKey(sourceKey, resolvedTurnId);
          const queue = pendingTranscriptQueueRef.current[turnKey] ?? [];
          pendingTranscriptQueueRef.current[turnKey] = queue;
          queue.push({
            source: payload.source,
            name: payload.name,
            delta: deltaText,
            turnId
          });
        }
      }

      if (payload.type === "transcript_done") {
        const sourceKey = String(payload.source ?? "ai_a");
        const turnId = Number(payload.turnId ?? 0);
        const resolvedTurnId =
          Number.isFinite(turnId) && turnId > 0
            ? turnId
            : activeTurnRef.current[sourceKey] ?? turnId;
        const turnKey = getTurnKey(sourceKey, resolvedTurnId);
        const finalText = String(payload.text ?? "");
        pendingFinalRef.current[turnKey] = finalText;
        pendingFinalNameRef.current[turnKey] = String(
          payload.name ?? pendingFinalNameRef.current[turnKey] ?? "Speaker"
        );
        scheduleFinalize(sourceKey as TranscriptDelta["source"], resolvedTurnId);
        if (finalizeSafetyTimerRef.current[turnKey]) {
          window.clearTimeout(finalizeSafetyTimerRef.current[turnKey] ?? 0);
        }
        finalizeSafetyTimerRef.current[turnKey] = window.setTimeout(() => {
          scheduleFinalize(sourceKey as TranscriptDelta["source"], resolvedTurnId);
        }, 1600);
      }

      if (payload.type === "audio_done") {
        const sourceKey = String(payload.source ?? "ai_a");
        const turnId = Number(payload.turnId ?? 0);
        const resolvedTurnId =
          Number.isFinite(turnId) && turnId > 0
            ? turnId
            : activeTurnRef.current[sourceKey] ?? turnId;
        const turnKey = getTurnKey(sourceKey, resolvedTurnId);
        audioDoneRef.current[turnKey] = true;
        scheduleFinalize(sourceKey as TranscriptDelta["source"], resolvedTurnId);
        if (finalizeSafetyTimerRef.current[turnKey]) {
          window.clearTimeout(finalizeSafetyTimerRef.current[turnKey] ?? 0);
        }
        finalizeSafetyTimerRef.current[turnKey] = window.setTimeout(() => {
          scheduleFinalize(sourceKey as TranscriptDelta["source"], resolvedTurnId);
        }, 1600);
        if (playbackContextRef.current) {
          const ctx = playbackContextRef.current;
          const endTime = playbackEndTimeRef.current[turnKey] ?? ctx.currentTime;
          const delayMs = Math.max(0, (endTime - ctx.currentTime) * 1000);
          if (playbackDoneTimerRef.current[turnKey]) {
            window.clearTimeout(playbackDoneTimerRef.current[turnKey] ?? 0);
          }
          playbackDoneTimerRef.current[turnKey] = window.setTimeout(() => {
            reportPlaybackDone(sourceKey, turnId, turnKey);
          }, delayMs);
          if (playbackSafetyTimerRef.current[turnKey]) {
            window.clearTimeout(playbackSafetyTimerRef.current[turnKey] ?? 0);
          }
          playbackSafetyTimerRef.current[turnKey] = window.setTimeout(() => {
            reportPlaybackDone(sourceKey, turnId, turnKey);
          }, Math.max(delayMs + 500, 1500));
        } else {
          reportPlaybackDone(sourceKey, turnId, turnKey);
        }
      }

      if (payload.type === "user_no_speech") {
        setInterruptPending(false);
        setAwaitingAiResponse(false);
        interruptPendingRef.current = false;
        if (awaitingUserTimerRef.current) {
          window.clearTimeout(awaitingUserTimerRef.current);
          awaitingUserTimerRef.current = null;
        }
        if (!awaitingUserTranscriptRef.current) {
          showNoSpeechNotice();
          appendLog("No speech detected.");
          return;
        }
        setAwaitingUserTranscript(false);
        showNoSpeechNotice();
        setManualAdvanceReady(false);
        appendLog("No speech detected.");
      }

      if (payload.type === "relay_target_unclear") {
        setInterruptPending(false);
        setAwaitingAiResponse(false);
        interruptPendingRef.current = false;
        if (awaitingUserTimerRef.current) {
          window.clearTimeout(awaitingUserTimerRef.current);
          awaitingUserTimerRef.current = null;
        }
        setAwaitingUserTranscript(false);
        setManualAdvanceReady(false);
        showRelayTargetUnclearNotice(
          payload.phase === "pattern1" ||
            payload.phase === "pattern2" ||
            payload.phase === "pattern3"
            ? payload.phase
            : phaseRef.current
        );
        appendLog("Could not determine the target speaker.");
      }

      if (payload.type === "user_transcript") {
        const transcriptText = String(payload.text ?? "");
        setInterruptPending(false);
        interruptPendingRef.current = false;
        if (awaitingUserTimerRef.current) {
          window.clearTimeout(awaitingUserTimerRef.current);
          awaitingUserTimerRef.current = null;
        }
        setAwaitingUserTranscript(false);
        clearSystemNotice();
        const nextItem: TranscriptItem = {
          id: `${Date.now()}-user-${transcriptCounterRef.current++}`,
          source: "user",
          name: "You",
          text: transcriptText,
          status: "final",
          phase: phaseRef.current
        };
        setTranscripts((prev) => [...prev, nextItem]);
      }

      if (payload.type === "error") {
        setInterruptPending(false);
        setAwaitingAiResponse(false);
        interruptPendingRef.current = false;
        appendLog(`Server error: ${payload.message}`);
      }
    });

    return () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    setManualAdvanceReady(false);
  }, [flowMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "interview.candidateLanguageLevel",
        candidateLanguageLevel
      );
    } catch {
      return;
    }
  }, [candidateLanguageLevel]);

  useEffect(() => {
    try {
      window.localStorage.setItem("interview.industry", industry);
    } catch {
      return;
    }
  }, [industry]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "interview.personality",
        interviewerPersonality
      );
    } catch {
      return;
    }
  }, [interviewerPersonality]);

  useEffect(() => {
    try {
      window.localStorage.setItem("interview.literacy", interviewerLiteracy);
    } catch {
      return;
    }
  }, [interviewerLiteracy]);

  useEffect(() => {
    try {
      window.localStorage.setItem("interview.dialect", interviewerDialect);
    } catch {
      return;
    }
  }, [interviewerDialect]);

  useEffect(() => {
    try {
      window.localStorage.setItem("interview.difficulty", interviewerDifficulty);
    } catch {
      return;
    }
  }, [interviewerDifficulty]);

  useEffect(() => {
    try {
      window.localStorage.setItem("interview.sceneNote", sceneNote);
    } catch {
      return;
    }
  }, [sceneNote]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "interview.textInputEnabled",
        String(textInputEnabled)
      );
    } catch {
      return;
    }
  }, [textInputEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem("interview.hintEnabled", String(hintEnabled));
    } catch {
      return;
    }
  }, [hintEnabled]);

  useEffect(() => {
    if (!transcriptWrapRef.current) return;
    transcriptWrapRef.current.scrollTop = transcriptWrapRef.current.scrollHeight;
  }, [transcripts]);

  const renderScriptHint = () => {
    if (!hintEnabled) {
      return (
        <div className="hint-card hint-card-muted">
          <p>会話ヒントはオフです。必要な時だけオンにしてください。</p>
        </div>
      );
    }

    if (!scriptHint) {
      return (
        <div className="hint-card hint-card-muted">
          <p>Start Session 後に、現在の Part と次に話す内容のヒントが表示されます。</p>
        </div>
      );
    }

    const [body, meta] = scriptHint.split(" / ");

    return (
      <div className="hint-card">
        <div className="hint-card-header">
          <span className="hint-phase-pill">{getPhaseLabel(phase)}</span>
          {meta ? <span className="hint-meta-pill">{meta}</span> : null}
        </div>
        <p>{body}</p>
      </div>
    );
  };

  return (
    <div className="app">
      <section className="hero">
        <div>
          <h1>EI & Co. Interview app</h1>
        </div>
        <div className="controls">
          <button
            onClick={startSession}
            disabled={wsStatus !== WS_STATUS.open || settingsLocked}
          >
            Start Session
          </button>
          <div className="mode-toggle" role="group" aria-label="Mode">
            <button
              className={flowMode === "auto" ? "secondary active" : "ghost"}
              onClick={() => setFlowMode("auto")}
              type="button"
              disabled={settingsLocked}
            >
              Auto
            </button>
            <button
              className={flowMode === "step" ? "secondary active" : "ghost"}
              onClick={() => setFlowMode("step")}
              type="button"
              disabled={settingsLocked}
            >
              Step
            </button>
          </div>
          <div className="mode-toggle" role="group" aria-label="Scenario">
            <button
              className={scenarioMode === "unified" ? "secondary active" : "ghost"}
              onClick={() => setScenarioMode("unified")}
              type="button"
              disabled={settingsLocked}
            >
              All
            </button>
            <button
              className={scenarioMode === "pattern1" ? "secondary active" : "ghost"}
              onClick={() => setScenarioMode("pattern1")}
              type="button"
              disabled={settingsLocked}
            >
              P1 Only
            </button>
            <button
              className={scenarioMode === "pattern2" ? "secondary active" : "ghost"}
              onClick={() => setScenarioMode("pattern2")}
              type="button"
              disabled={settingsLocked}
            >
              P2 Only
            </button>
            <button
              className={scenarioMode === "pattern3" ? "secondary active" : "ghost"}
              onClick={() => setScenarioMode("pattern3")}
              type="button"
              disabled={settingsLocked}
            >
              P3 Only
            </button>
          </div>
        </div>
        <div className="flow-overview" aria-label="このアプリの流れ">
          <div className="flow-overview-header">
            <strong>このアプリの流れ</strong>
            <span>通常は 1 → 2 → 3 の順で進みます</span>
          </div>
          <div className="flow-overview-grid">
            <div className="flow-step">
              <span>1</span>
              <strong>面接前練習</strong>
              <p>営業 + 学生AI</p>
            </div>
            <div className="flow-step">
              <span>2</span>
              <strong>面接本番</strong>
              <p>営業 + 学生AI + 面接官AI</p>
            </div>
            <div className="flow-step">
              <span>3</span>
              <strong>面接後ヒアリング</strong>
              <p>営業 + 面接官AI</p>
            </div>
          </div>
        </div>
        <div className="settings-panel" aria-label="求職者設定">
          <div className="settings-panel-header">
            <strong>求職者設定</strong>
            <span>開始前に求職者AIの日本語レベルと業種を選びます</span>
          </div>
          <div className="settings-grid">
            <div className="setting-field">
              <label>日本語レベル</label>
              <div className="mode-toggle" role="group" aria-label="Candidate Japanese">
                <button
                  className={
                    candidateLanguageLevel === "basic" ? "secondary active" : "ghost"
                  }
                  onClick={() => setCandidateLanguageLevel("basic")}
                  type="button"
                  disabled={settingsLocked}
                >
                  初級
                </button>
                <button
                  className={
                    candidateLanguageLevel === "standard"
                      ? "secondary active"
                      : "ghost"
                  }
                  onClick={() => setCandidateLanguageLevel("standard")}
                  type="button"
                  disabled={settingsLocked}
                >
                  中級
                </button>
                <button
                  className={
                    candidateLanguageLevel === "prototype"
                      ? "secondary active"
                      : "ghost"
                  }
                  onClick={() => setCandidateLanguageLevel("prototype")}
                  type="button"
                  disabled={settingsLocked}
                >
                  上級
                </button>
              </div>
            </div>
            <div className="setting-field">
              <label>業種</label>
              <div className="mode-toggle" role="group" aria-label="Industry">
                <button
                  className={industry === "construction" ? "secondary active" : "ghost"}
                  onClick={() => setIndustry("construction")}
                  type="button"
                  disabled={settingsLocked}
                >
                  建築
                </button>
                <button
                  className={industry === "food" ? "secondary active" : "ghost"}
                  onClick={() => setIndustry("food")}
                  type="button"
                  disabled={settingsLocked}
                >
                  飲食
                </button>
                <button
                  className={industry === "manufacturing" ? "secondary active" : "ghost"}
                  onClick={() => setIndustry("manufacturing")}
                  type="button"
                  disabled={settingsLocked}
                >
                  製造
                </button>
                <button
                  className={industry === "hotel" ? "secondary active" : "ghost"}
                  onClick={() => setIndustry("hotel")}
                  type="button"
                  disabled={settingsLocked}
                >
                  宿泊
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="settings-panel" aria-label="面接官設定">
          <div className="settings-panel-header">
            <strong>面接官設定</strong>
            <span>開始前に面接官AIの話し方と難易度を選びます</span>
          </div>
          <div className="settings-grid">
            <div className="setting-field">
              <label>性格（未実装）</label>
              <div className="mode-toggle" role="group" aria-label="Interviewer personality">
                <button
                  className={interviewerPersonality === "balanced" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerPersonality("balanced")}
                  type="button"
                  disabled={settingsLocked}
                >
                  標準
                </button>
                <button
                  className={interviewerPersonality === "meticulous" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerPersonality("meticulous")}
                  type="button"
                  disabled={settingsLocked}
                >
                  細かい
                </button>
                <button
                  className={interviewerPersonality === "rough" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerPersonality("rough")}
                  type="button"
                  disabled={settingsLocked}
                >
                  ガサツ
                </button>
                <button
                  className={interviewerPersonality === "curious" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerPersonality("curious")}
                  type="button"
                  disabled={settingsLocked}
                >
                  質問多め
                </button>
              </div>
            </div>
            <div className="setting-field">
              <label>リテラシー（未実装）</label>
              <div className="mode-toggle" role="group" aria-label="Interviewer literacy">
                <button
                  className={interviewerLiteracy === "low" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerLiteracy("low")}
                  type="button"
                  disabled={settingsLocked}
                >
                  低
                </button>
                <button
                  className={interviewerLiteracy === "medium" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerLiteracy("medium")}
                  type="button"
                  disabled={settingsLocked}
                >
                  中
                </button>
                <button
                  className={interviewerLiteracy === "high" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerLiteracy("high")}
                  type="button"
                  disabled={settingsLocked}
                >
                  高
                </button>
              </div>
            </div>
            <div className="setting-field">
              <label>方言（未実装）</label>
              <div className="mode-toggle" role="group" aria-label="Interviewer dialect">
                <button
                  className={interviewerDialect === "standard" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerDialect("standard")}
                  type="button"
                  disabled={settingsLocked}
                >
                  標準語
                </button>
                <button
                  className={interviewerDialect === "kansai" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerDialect("kansai")}
                  type="button"
                  disabled={settingsLocked}
                >
                  関西弁
                </button>
              </div>
            </div>
            <div className="setting-field">
              <label>難易度</label>
              <div className="mode-toggle" role="group" aria-label="Interviewer difficulty">
                <button
                  className={interviewerDifficulty === "easy" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerDifficulty("easy")}
                  type="button"
                  disabled={settingsLocked}
                >
                  イージー
                </button>
                <button
                  className={interviewerDifficulty === "hard" ? "secondary active" : "ghost"}
                  onClick={() => setInterviewerDifficulty("hard")}
                  type="button"
                  disabled={settingsLocked}
                >
                  ハード
                </button>
              </div>
            </div>
            <div className="setting-field setting-field-note">
              <label htmlFor="scene-note">補足テキスト</label>
              <textarea
                id="scene-note"
                value={sceneNote}
                onChange={(event) => setSceneNote(event.target.value)}
                disabled={settingsLocked}
                placeholder="例: 初めての面接 / 以前外国人雇用でトラブルがあった企業"
                rows={3}
              />
            </div>
          </div>
        </div>
        {settingsLocked && (
          <div className="session-lock-note">
            セッション中は開始前設定を変更できません。変更する場合はセッション終了後に再設定してください。
          </div>
        )}
      </section>

      {candidateProfile && (
        <section className="panel candidate-brief">
          <div className="conversation-header">
            <h2>Candidate Brief</h2>
            <div className="phase-pill">{candidateProfile.industry}</div>
          </div>
          <div className="brief-grid">
            <div className="brief-card">
              <span>基本情報</span>
              <ul>
                <li>氏名: {candidateProfile.name}</li>
                <li>国籍: {candidateProfile.nationality}</li>
                <li>想定職種: {candidateProfile.targetRole}</li>
                <li>日本語レベル: {getCandidateLanguageLevelLabel(candidateProfile.languageLevel)}</li>
              </ul>
            </div>
            <div className="brief-card">
              <span>これまでの経験</span>
              <ul>
                {candidateProfile.experience.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="brief-card">
              <span>強み・補足</span>
              <ul>
                {candidateProfile.strengths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {candidateProfile.note ? <li>{candidateProfile.note}</li> : null}
              </ul>
            </div>
          </div>
        </section>
      )}

      <section className="panel conversation-hint-panel">
        <div className="conversation-header">
          <div className="hint-panel-header">
            <h2>会話ヒント</h2>
            <p>次に話す内容の目安を表示します</p>
          </div>
          <div className="mode-toggle" role="group" aria-label="Hints">
            <button
              className={hintEnabled ? "secondary active" : "ghost"}
              onClick={() => setHintEnabled(true)}
              type="button"
            >
              On
            </button>
            <button
              className={!hintEnabled ? "secondary active" : "ghost"}
              onClick={() => setHintEnabled(false)}
              type="button"
            >
              Off
            </button>
          </div>
        </div>
        {renderScriptHint()}
      </section>

      <section className="panel conversation">
        <div className="conversation-header">
          <h2>Conversation</h2>
          <div className="conversation-actions">
            <button
              className="secondary export-action"
              disabled={!canExportConversationPdf}
              onClick={exportConversationPdf}
              type="button"
            >
              PDF出力
            </button>
            <button
              className="secondary export-action"
              disabled={!canRequestEvaluation}
              onClick={() => {
                void requestInterviewEvaluation();
              }}
              type="button"
            >
              {evaluationLoading ? "評価生成中..." : "面接評価"}
            </button>
            <div className="mode-toggle" role="group" aria-label="Input mode">
              <button
                className={!textInputEnabled ? "secondary active" : "ghost"}
                onClick={() => setTextInputEnabled(false)}
                type="button"
              >
                音声入力
              </button>
              <button
                className={textInputEnabled ? "secondary active" : "ghost"}
                onClick={() => setTextInputEnabled(true)}
                type="button"
              >
                テキスト入力
              </button>
            </div>
          </div>
        </div>
        <div className="transcripts chat" ref={transcriptWrapRef}>
          {transcripts.map((item) => (
            <div
              className={`transcript bubble ${item.source} ${item.status}`}
              key={item.id}
            >
              {item.source === "system" ? (
                <div className="phase-divider-body">
                  <span>{item.name}</span>
                  <p>{item.text}</p>
                </div>
              ) : (
                <>
                  <div className="avatar" aria-hidden="true" />
                  <div className="bubble-body">
                    <span>{item.name}</span>
                    <p>{item.text || (item.status === "streaming" ? "…" : "")}</p>
                  </div>
                </>
              )}
            </div>
          ))}
          {systemNotice && (
            <div className="transcript system system-notice">
              <div className="system-notice-illustration" aria-hidden="true">
                <div className="system-notice-mic" />
                <div className="system-notice-wave wave-1" />
                <div className="system-notice-wave wave-2" />
              </div>
              <div className="system-notice-body">
                <span>system</span>
                <strong>{systemNotice.title}</strong>
                <p>{systemNotice.detail}</p>
                <p>{systemNotice.guidance}</p>
                <button
                  onClick={() => {
                    if (textInputEnabled) {
                      clearSystemNotice();
                      return;
                    }
                    void startRecording();
                  }}
                  disabled={textInputEnabled ? false : !canStartMic}
                  type="button"
                >
                  {textInputEnabled
                    ? "入力を続ける"
                    : systemNotice.kind === "relay_target_unclear"
                      ? "続けて話す"
                      : "もう一度録音する"}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="conversation-controls">
          {textInputEnabled ? (
            <div className="text-input-controls">
              <textarea
                value={textInputDraft}
                onChange={(event) => setTextInputDraft(event.target.value)}
                placeholder="デバッグ用に営業発話を入力して送信します"
                rows={2}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault();
                    submitTextInput();
                  }
                }}
                disabled={
                  !sessionsReady ||
                  sessionEnded ||
                  completedPracticePhases[phase] ||
                  recording
                }
              />
              <button onClick={submitTextInput} disabled={!canSubmitText}>
                テキスト送信
              </button>
            </div>
          ) : (
            <>
              <button onClick={startRecording} disabled={!canStartMic}>
                Start Mic
              </button>
              <button
                className="secondary stop-action"
                onClick={() => stopRecording()}
                disabled={!recording}
              >
                Stop + Commit
              </button>
            </>
          )}
          {flowMode === "step" && (
            <button
              className="secondary"
              onClick={requestAdvance}
              disabled={
                !manualAdvanceReady ||
                !sessionsReady ||
                recording ||
                awaitingUserTranscript ||
                activeAiStreamingCount > 0
              }
            >
              Next Turn
            </button>
          )}
          {phase === "pattern1" && (
            <button
              className="secondary phase-action"
              onClick={() => sendMessage({ type: "set_phase", phase: "pattern2" })}
              disabled={
                scenarioMode !== "unified" ||
                !sessionsReady ||
                recording ||
                awaitingUserTranscript
              }
            >
              面接本番へ進む
            </button>
          )}
          {phase === "pattern2" && (
            <button
              className="secondary phase-action"
              onClick={() => sendMessage({ type: "set_phase", phase: "pattern3" })}
              disabled={
                scenarioMode !== "unified" ||
                !sessionsReady ||
                recording ||
                awaitingUserTranscript
              }
            >
              面接後ヒアリングへ進む
            </button>
          )}
          <button
            className="secondary restart-action"
            onClick={startSession}
            disabled={
              wsStatus !== WS_STATUS.open ||
              recording ||
              awaitingUserTranscript ||
              awaitingAiResponse ||
              activeAiStreamingCount > 0
            }
            type="button"
          >
            同じ設定でもう一度練習する
          </button>
        </div>
      </section>

      {(evaluationLoading || evaluationError || evaluationResult) && (
        <section className="panel evaluation-panel">
          <div className="conversation-header">
            <div className="evaluation-heading">
              <h2>面接評価</h2>
              <p>営業発話を主対象に、会話全体との噛み合いも見て採点します。</p>
            </div>
            {evaluationResult && (
              <div className="evaluation-score-pill">
                総合 {getEvaluationScoreText(evaluationResult.overallScore)}
              </div>
            )}
          </div>

          {evaluationLoading && (
            <div className="evaluation-loading-card" role="status" aria-live="polite">
              <div className="evaluation-spinner" aria-hidden="true" />
              <div className="evaluation-loading-copy">
                <strong>評価を生成しています</strong>
                <p className="evaluation-summary">
                  会話ログをもとに採点中です。結果が出るまでお待ちください。
                </p>
              </div>
            </div>
          )}

          {evaluationError && (
            <p className="evaluation-error">{evaluationError}</p>
          )}

          {evaluationResult && (
            <>
              <div className="evaluation-overview">
                <strong>{evaluationResult.overallLabel}</strong>
                <p>{evaluationResult.overallComment}</p>
              </div>

              <div className="evaluation-grid">
                {(Object.keys(EVALUATION_CATEGORY_LABELS) as EvaluationCategoryKey[])
                  .filter((key) => evaluationResult.categories[key].score !== null)
                  .map((key) => {
                    const category = evaluationResult.categories[key];
                    return (
                      <article className="evaluation-card" key={key}>
                        <span>{EVALUATION_CATEGORY_LABELS[key]}</span>
                        <strong>{getEvaluationScoreText(category.score)}</strong>
                        <p>{category.summary}</p>
                        {category.evidence.length > 0 && (
                          <ul className="evaluation-evidence-list">
                            {category.evidence.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        )}
                      </article>
                    );
                  })}
              </div>

              <div className="evaluation-columns">
                <div className="evaluation-block">
                  <h3>良かった点</h3>
                  <ul>
                    {evaluationResult.goodPoints.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>

                <div className="evaluation-block">
                  <h3>改善点</h3>
                  <ul>
                    {evaluationResult.improvementPoints.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {evaluationResult.conversationIssues.length > 0 && (
                <div className="evaluation-block">
                  <h3>会話上の違和感</h3>
                  <ul>
                    {evaluationResult.conversationIssues.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}

              {evaluationResult.ngFindings.length > 0 && (
                <div className="evaluation-block evaluation-block-danger">
                  <h3>NG表現・危険説明</h3>
                  <ul>
                    {evaluationResult.ngFindings.map((item, index) => (
                      <li key={`${item.phrase}-${index}`}>
                        {item.reason}：{item.phrase}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
};

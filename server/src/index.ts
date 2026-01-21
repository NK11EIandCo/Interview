import express from "express";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";
const MIN_TURNS = 20;
const MAX_TURNS = 40;

if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is not set.");
  process.exit(1);
}

type AiKey = "ai_a" | "ai_b";

const AI_PROFILES: Record<AiKey, { name: string; voice: string; instructions: string }> = {
  ai_a: {
    name: "Interviewer",
    voice: "cedar",
    instructions: `You are a hiring manager at a Japanese care facility.
Ask short, practical questions about experience, motivation, and fit.
Keep the pace brisk. Be direct but fair.
Do not end the interview early. Only wrap up after you have covered all of these topics:
- Past caregiving experience and specific duties
- Motivation for caregiving work
- Japanese language ability / communication
- Shift availability (including night shift)
- Physical stamina / health
- Visa/residence status and possible start date
When you decide to close, end politely with 【面接終了】.`
  },
  ai_b: {
    name: "Candidate",
    voice: "marin",
    instructions: `You are a foreign candidate who is not fluent in Japanese.
Speak in very short, simple fragments. Keep grammar broken and short.
Japanese level is very low (around N5). Make it sound more limited in these ways:
- Omit particles and verb endings often.
- Use wrong word order and wrong verb conjugations.
- Use very simple vocabulary; avoid keigo and formal phrases.
- Mix in occasional English words like "sorry", "yes", "no", "thank you".
- Echo a keyword from the question instead of answering fully.
- If a question is complex, reply with "すみません、わからない" or ask to repeat.
Keep each response to 1-2 short sentences, 5-8 words each.
Tone is simple but polite and modest. Avoid being too casual or playful.
Prefer simple polite endings like 「ありがとう」「お願いします」「失礼します」.`
  }
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
  let lastUserTranscript = "";
  let lastUserTranscriptAt = 0;
  const endMarkers = ["【面接終了】", "【面接中止】"];
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

  const createAiSocket = (key: AiKey) => {
    const profile = AI_PROFILES[key];
    return createRealtimeConnection(profile, {
      onReady: () => {
        sessionReady[key] = true;
        if (pendingStart && sessionReady.ai_a && sessionReady.ai_b) {
          pendingStart = false;
          sendToClient({ type: "sessions_ready" });
          if (autoMode) {
            requestAiResponse("ai_a");
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
        if (key === "ai_a") {
          updateCoverage(finalText);
        }
        if (endMarkers.some((marker) => finalText.includes(marker))) {
          if (totalTurns >= MIN_TURNS && hasAllCoverage()) {
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
      },
      onInputTranscriptDone: (transcript) => {
        if (key !== "ai_a") return;
        const normalized = transcript.trim();
        if (!normalized) return;
        const now = Date.now();
        if (normalized === lastUserTranscript && now - lastUserTranscriptAt < 2000) {
          return;
        }
        lastUserTranscript = normalized;
        lastUserTranscriptAt = now;
        sendToClient({ type: "user_transcript", text: normalized });
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
    };
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "start") {
      autoMode = true;
      sessionEnded = false;
      sessionEndReason = null;
      totalTurns = 0;
      queuedNextKeys = [];
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
        requestAiResponse("ai_a");
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
      return;
    }

    if (message.type === "user_speaking") {
      userSpeaking = true;
      return;
    }

    if (message.type === "user_done") {
      userSpeaking = false;
      if (autoMode && !sessionEnded) {
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

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
  source: "ai_a" | "ai_b" | "user";
  name: string;
  text: string;
  status: "streaming" | "final";
  id: string;
};

type TranscriptDelta = {
  source: "ai_a" | "ai_b";
  name: string;
  delta: string;
  turnId: number;
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

export const App = () => {
  const [wsStatus, setWsStatus] = useState<WsStatus>(WS_STATUS.connecting);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [recording, setRecording] = useState(false);
  const [configStatus, setConfigStatus] = useState({
    firebase: false,
    supabase: false
  });
  const [sessionEnded, setSessionEnded] = useState(false);

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
  const audioDoneRef = useRef<Record<string, boolean>>({});
  const activeTurnRef = useRef<Record<string, number>>({});
  const finalizedTurnRef = useRef<Record<string, boolean>>({});
  const pendingUserTranscriptIdsRef = useRef<string[]>([]);
  const hasConnectedRef = useRef(false);

  const getTurnKey = (source: string, turnId: number) => `${source}:${turnId}`;

  const appendLog = (message: string) => {
    setLogs((prev) => [message, ...prev].slice(0, 30));
  };

  const resetConversationState = () => {
    setTranscripts([]);
    activeTranscriptRef.current = {};
    pendingTranscriptQueueRef.current = {};
    pendingFinalRef.current = {};
    pendingFinalNameRef.current = {};
    audioDoneRef.current = {};
    playbackEndTimeRef.current = {};
    activeTurnRef.current = {};
    finalizedTurnRef.current = {};
    pendingUserTranscriptIdsRef.current = [];
    Object.values(playbackDoneTimerRef.current).forEach((timerId) => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    });
    playbackDoneTimerRef.current = {};
  };

  const sendMessage = (payload: object) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  };

  const startRecording = async () => {
    if (recordingRef.current) return;
    try {
      sendMessage({ type: "user_speaking" });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 24000
        }
      });
      const audioContext = new AudioContext({ sampleRate: 24000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const zeroGain = audioContext.createGain();
      zeroGain.gain.value = 0;

      processor.onaudioprocess = (event) => {
        if (!recordingRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        const int16 = float32ToInt16(input);
        const base64 = encodeInt16ToBase64(int16);
        sendMessage({ type: "user_audio", data: base64 });
      };

      source.connect(processor);
      processor.connect(zeroGain);
      zeroGain.connect(audioContext.destination);

      audioContextRef.current = audioContext;
      processorRef.current = processor;
      mediaStreamRef.current = stream;

      recordingRef.current = true;
      setRecording(true);
      appendLog("Mic streaming on.");
    } catch (error) {
      appendLog(`Mic error: ${(error as Error).message}`);
    }
  };

  const stopRecording = () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    sendMessage({ type: "user_audio_commit" });
    sendMessage({ type: "user_done" });

    const placeholderId = `${Date.now()}-user-${transcriptCounterRef.current++}`;
    pendingUserTranscriptIdsRef.current.push(placeholderId);
    const placeholderItem: TranscriptItem = {
      id: placeholderId,
      source: "user",
      name: "You",
      text: "Transcribing...",
      status: "streaming"
    };
    setTranscripts((prev) => [...prev, placeholderItem]);

    processorRef.current?.disconnect();
    processorRef.current = null;

    audioContextRef.current?.close();
    audioContextRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    appendLog("Mic streaming off (audio committed).");
  };

  const playAudioChunk = (
    base64: string,
    speaker: TranscriptDelta["source"],
    turnId: number
  ) => {
    if (!playbackContextRef.current) {
      playbackContextRef.current = new AudioContext({ sampleRate: 24000 });
      nextPlaybackTimeRef.current = playbackContextRef.current.currentTime;
    }

    const ctx = playbackContextRef.current;
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
      setTranscripts((prev) => {
        const currentId = activeTranscriptRef.current[turnKey];
        if (!currentId) {
          const nextId = `${Date.now()}-${turnKey}-${transcriptCounterRef.current++}`;
          activeTranscriptRef.current[turnKey] = nextId;
          const nextItem: TranscriptItem = {
            id: nextId,
            source: nextDelta.source,
            name: nextDelta.name,
            text: nextDelta.delta,
            status: "streaming"
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
      setTranscripts((prev) => {
        const currentId = activeTranscriptRef.current[turnKey];
        if (currentId) {
          const updated = prev.map<TranscriptItem>((item) =>
            item.id === currentId
              ? { ...item, text, status: "final" }
              : item
          );
          delete activeTranscriptRef.current[turnKey];
          finalizedTurnRef.current[turnKey] = true;
          return updated;
        }

        const finalItem: TranscriptItem = {
          id: `${Date.now()}-${turnKey}-${transcriptCounterRef.current++}`,
          source,
          name,
          text,
          status: "final"
        };
        return [...prev, finalItem];
      });

      pendingFinalRef.current[turnKey] = null;
      pendingTranscriptQueueRef.current[turnKey] = [];
      audioDoneRef.current[turnKey] = false;
      finalizedTurnRef.current[turnKey] = true;
    };

    if (ctx) {
      const delayMs = Math.max(0, (endTime - ctx.currentTime) * 1000);
      window.setTimeout(() => finalize(finalText, finalName), delayMs);
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
      appendLog("WebSocket closed.");
    });

    ws.addEventListener("error", () => {
      setWsStatus(WS_STATUS.error);
      appendLog("WebSocket error.");
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

      if (payload.type === "session_ended") {
        setSessionEnded(true);
        appendLog(
          payload.reason === "max_turns"
            ? "Session ended: max turns reached."
            : "Session ended: marker detected."
        );
      }

      if (payload.type === "waiting_for_sessions") {
        appendLog("Waiting for OpenAI sessions...");
      }

      if (payload.type === "audio") {
        playAudioChunk(
          payload.data,
          payload.source,
          Number(payload.turnId ?? 0)
        );
      }

      if (payload.type === "audio_start") {
        const sourceKey = String(payload.source ?? "ai_a");
        const turnId = Number(payload.turnId ?? 0);
        const resolvedTurnId =
          Number.isFinite(turnId) && turnId > 0
            ? turnId
            : activeTurnRef.current[sourceKey] ?? turnId;
        activeTurnRef.current[sourceKey] = resolvedTurnId;
        const turnKey = getTurnKey(sourceKey, resolvedTurnId);
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
            status: "streaming"
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
        if (playbackContextRef.current) {
          const ctx = playbackContextRef.current;
          const endTime = playbackEndTimeRef.current[turnKey] ?? ctx.currentTime;
          const delayMs = Math.max(0, (endTime - ctx.currentTime) * 1000);
          if (playbackDoneTimerRef.current[turnKey]) {
            window.clearTimeout(playbackDoneTimerRef.current[turnKey] ?? 0);
          }
          playbackDoneTimerRef.current[turnKey] = window.setTimeout(() => {
            sendMessage({ type: "audio_playback_done", target: sourceKey, turnId });
          }, delayMs);
        } else {
          sendMessage({ type: "audio_playback_done", target: sourceKey, turnId });
        }
      }

      if (payload.type === "user_transcript") {
        const transcriptText = String(payload.text ?? "");
        const pendingId = pendingUserTranscriptIdsRef.current.shift();
        if (pendingId) {
          setTranscripts((prev) =>
            prev.map<TranscriptItem>((item) =>
              item.id === pendingId
                ? { ...item, text: transcriptText, status: "final" }
                : item
            )
          );
        } else {
          const nextItem: TranscriptItem = {
            id: `${Date.now()}-user-${transcriptCounterRef.current++}`,
            source: "user",
            name: "You",
            text: transcriptText,
            status: "final"
          };
          setTranscripts((prev) => [...prev, nextItem]);
        }
      }

      if (payload.type === "error") {
        appendLog(`Server error: ${payload.message}`);
      }
    });

    return () => {
      ws.close();
    };
  }, []);


  useEffect(() => {
    if (!transcriptWrapRef.current) return;
    transcriptWrapRef.current.scrollTop = transcriptWrapRef.current.scrollHeight;
  }, [transcripts]);

  return (
    <div className="app">
      <section className="hero">
        <div>
          <p className="eyebrow">ElandCo Interview Lab</p>
          <h1>3-party interview practice for overseas hiring</h1>
        </div>
        <p className="subtitle">
          Low-latency voice practice with interviewer + candidate roles powered by
          OpenAI Realtime.
        </p>
        <div className="controls">
          <button
            onClick={() => {
              setSessionEnded(false);
              sendMessage({ type: "start" });
            }}
            disabled={wsStatus !== WS_STATUS.open}
          >
            Start Session
          </button>
        </div>
      </section>

      <section className="top-row">
        <div className="panel">
          <h2>Status</h2>
          <div className="status">
            <div>WebSocket: {wsStatus}</div>
            <div>OpenAI sessions: {sessionsReady ? "ready" : "not ready"}</div>
            <div>Session: {sessionEnded ? "ended" : "active"}</div>
            <div>Mic: {recording ? "streaming" : "idle"}</div>
            <div>Firebase: {configStatus.firebase ? "ready" : "missing"}</div>
            <div>Supabase: {configStatus.supabase ? "ready" : "missing"}</div>
          </div>
          <div className="controls" style={{ marginTop: 16 }}>
            <button
              onClick={startRecording}
              disabled={!sessionsReady || recording}
            >
              Start Mic
            </button>
            <button
              className="ghost"
              onClick={stopRecording}
              disabled={!recording}
            >
              Stop + Commit
            </button>
          </div>
        </div>

        <div className="panel">
          <h2>Activity Log</h2>
          <div className="log">
            {logs.length === 0 ? "No activity." : logs.join("\n")}
          </div>
        </div>
      </section>

      <section className="panel conversation">
        <h2>Conversation</h2>
        <div className="transcripts chat" ref={transcriptWrapRef}>
          {transcripts.length === 0 && (
            <div className="transcript system">
              <span>system</span>
              No transcripts yet.
            </div>
          )}
          {transcripts.map((item) => (
            <div
              className={`transcript bubble ${item.source} ${item.status}`}
              key={item.id}
            >
              <div className="avatar" aria-hidden="true" />
              <div className="bubble-body">
                <span>{item.name}</span>
                <p>{item.text || "(no transcript)"}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

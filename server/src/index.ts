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
  buildSelectedInterviewerQuestionPlan,
  matchesInterviewQuestionSpec,
  type InterviewQuestionSpec
} from "./interviewQuestionPlan.js";
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
const OPENAI_TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe";
const OPENAI_LONGFORM_TRANSCRIPTION_MODEL =
  process.env.OPENAI_LONGFORM_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe";
const OPENAI_EVALUATION_MODEL =
  process.env.OPENAI_EVALUATION_MODEL ?? OPENAI_ROUTING_MODEL;
const OPENAI_CANDIDATE_PLANNER_MODEL =
  process.env.OPENAI_CANDIDATE_PLANNER_MODEL ?? OPENAI_ROUTING_MODEL;
const OPENAI_INTERVIEWER_PLANNER_MODEL =
  process.env.OPENAI_INTERVIEWER_PLANNER_MODEL ?? OPENAI_ROUTING_MODEL;
const MIN_TURNS = 20;
const MAX_TURNS = 40;
const USER_TRANSCRIPT_TIMEOUT_MS = Number.parseInt(
  process.env.USER_TRANSCRIPT_TIMEOUT_MS ?? "6500",
  10
);
const USER_TRANSCRIPT_LATE_ACCEPT_MS = Number.parseInt(
  process.env.USER_TRANSCRIPT_LATE_ACCEPT_MS ?? "12000",
  10
);
const PATTERN3_VERBAL_OFFER_RATE = 0.5;
// Sales-led flow toggle. Set to false to restore the previous AI-to-AI flow.
const SALES_LED_FLOW = true;
const ENABLE_AI_CUT_IN = false;
const ENABLE_CANDIDATE_RESPONSE_VALIDATION = false;
const ENABLE_CANDIDATE_TURN_PLANNING = true;
const ENABLE_INTERVIEWER_TURN_PLANNING = true;
const PREFER_DEDICATED_TRANSCRIPTION_INPUT = false;

type EvaluationPhase = "pattern1" | "pattern2" | "pattern3";
type EvaluationScenarioMode = "unified" | "pattern1" | "pattern2" | "pattern3";
type EvaluationTranscriptSource = "ai_a" | "ai_b" | "user" | "system";
type EvaluationCategoryKey =
  | "facilitation"
  | "closing"
  | "knowledge"
  | "communication";
type EvaluationTranscriptItem = {
  source: EvaluationTranscriptSource;
  name: string;
  text: string;
  phase: EvaluationPhase;
};
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
  phase: EvaluationPhase | "unknown";
};
type EvaluationResponseBody = {
  overallScore: number | null;
  overallLabel: string;
  overallComment: string;
  categories: Record<EvaluationCategoryKey, EvaluationCategoryResult>;
  goodPoints: string[];
  improvementPoints: string[];
  conversationIssues: string[];
  ngFindings: EvaluationNgFinding[];
};

const EVALUATION_PHASES: EvaluationPhase[] = [
  "pattern1",
  "pattern2",
  "pattern3"
];
const EVALUATION_SCENARIO_MODES: EvaluationScenarioMode[] = [
  "unified",
  "pattern1",
  "pattern2",
  "pattern3"
];
const EVALUATION_SOURCES: EvaluationTranscriptSource[] = [
  "ai_a",
  "ai_b",
  "user",
  "system"
];
const EVALUATION_CATEGORY_LABELS: Record<EvaluationCategoryKey, string> = {
  facilitation: "進行管理",
  closing: "クロージング",
  knowledge: "知識正確性",
  communication: "態度・伝わり方"
};
const EVALUATION_NG_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
  category: EvaluationCategoryKey;
  onlyIndustry?: InterviewIndustry;
}> = [
  {
    pattern: /外人/,
    reason: "差別的・不適切な表現です。",
    category: "communication"
  },
  {
    pattern: /現場仕事だけでも.*バレなきゃ大丈夫/,
    reason: "法的に危険な説明です。",
    category: "knowledge"
  },
  {
    pattern: /最低賃金以下.*問題ない/,
    reason: "法的に危険な説明です。",
    category: "knowledge"
  },
  {
    pattern: /ビザだけ取らせて/,
    reason: "法的に危険な説明です。",
    category: "knowledge"
  },
  {
    pattern: /学生から手数料.*いただいて/,
    reason: "ビジネスモデルの説明が誤っています。",
    category: "knowledge"
  },
  {
    pattern: /やらない業務も記載/,
    reason: "採用理由書に関する危険な虚偽説明です。",
    category: "knowledge"
  },
  {
    pattern: /単純作業だけでも大丈夫/,
    reason: "技人国ビザの説明として法的に誤りです。",
    category: "knowledge"
  },
  {
    pattern: /全ての現場に入れます/,
    reason: "建築業では誤解を招く危険な断定です。",
    category: "knowledge",
    onlyIndustry: "construction"
  },
  {
    pattern: /日本語を教えている学校/,
    reason: "会社説明として不適切です。",
    category: "knowledge"
  },
  {
    pattern: /ビザの申請は私(?:たち|ども)?が行います/,
    reason: "実務体制の説明として不正確です。",
    category: "knowledge"
  },
  {
    pattern: /問題なく日本語がペラペラ/,
    reason: "日本語力の断定が不適切です。",
    category: "communication"
  },
  {
    pattern: /外国人の方はやめない/,
    reason: "離職リスクを断定しており不適切です。",
    category: "communication"
  }
];

const isEvaluationPhase = (value: unknown): value is EvaluationPhase =>
  typeof value === "string" &&
  EVALUATION_PHASES.includes(value as EvaluationPhase);
const isEvaluationScenarioMode = (
  value: unknown
): value is EvaluationScenarioMode =>
  typeof value === "string" &&
  EVALUATION_SCENARIO_MODES.includes(value as EvaluationScenarioMode);
const isEvaluationTranscriptSource = (
  value: unknown
): value is EvaluationTranscriptSource =>
  typeof value === "string" &&
  EVALUATION_SOURCES.includes(value as EvaluationTranscriptSource);
const normalizeEvaluationText = (text: string) =>
  text.replace(/\s+/g, "").trim();
const clipEvaluationText = (text: string, max = 90) =>
  text.length <= max ? text : `${text.slice(0, max)}…`;
const scoreToEvaluationLabel = (score: number | null) => {
  if (score === null) return "N/A";
  if (score >= 4.5) return "Perfect";
  if (score >= 3.5) return "Good";
  if (score >= 2.5) return "Pass";
  if (score >= 1.5) return "Fail";
  return "Bad / NG";
};
const coerceEvaluationScore = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  return Math.max(1, Math.min(5, Math.round(numeric)));
};
const dedupeStrings = (items: string[], limit: number) =>
  [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, limit);
const toEvaluationSpeakerLabel = (item: EvaluationTranscriptItem) => {
  if (item.source === "user") return "営業";
  if (item.source === "ai_b") return "学生";
  if (item.phase === "pattern3") return "企業";
  if (item.phase === "pattern2") return "面接官";
  return "学生";
};
const buildEvaluationTranscriptLines = (items: EvaluationTranscriptItem[]) =>
  items
    .filter((item) => item.source !== "system" && item.text.trim())
    .map(
      (item, index) =>
        `[L${index + 1}][${item.phase}][${toEvaluationSpeakerLabel(item)}] ${item.text.trim()}`
    );
const buildEvaluationSalesLineReferences = (items: EvaluationTranscriptItem[]) =>
  items
    .filter((item) => item.source !== "system" && item.text.trim())
    .flatMap((item, index) =>
      item.source === "user"
        ? [
            {
              line: `L${index + 1}`,
              phase: item.phase,
              text: item.text.trim()
            }
          ]
        : []
    );
const detectEvaluationNgFindings = (
  items: EvaluationTranscriptItem[],
  industry: InterviewIndustry
): EvaluationNgFinding[] => {
  const findings: EvaluationNgFinding[] = [];
  for (const item of items) {
    if (item.source !== "user") continue;
    for (const spec of EVALUATION_NG_PATTERNS) {
      if (spec.onlyIndustry && spec.onlyIndustry !== industry) continue;
      if (!spec.pattern.test(item.text)) continue;
      findings.push({
        phrase: clipEvaluationText(item.text.trim()),
        reason: spec.reason,
        category: spec.category,
        phase: item.phase
      });
    }
  }
  return findings;
};
const buildEvaluationSignals = (
  items: EvaluationTranscriptItem[],
  industry: InterviewIndustry
) => {
  const getNextMeaningfulItem = (startIndex: number) => {
    for (let index = startIndex + 1; index < items.length; index += 1) {
      const candidate = items[index];
      if (candidate.source === "system" || !candidate.text.trim()) continue;
      return { item: candidate, index };
    }
    return null;
  };
  const salesTurns = items.filter(
    (item) => item.source === "user" && item.text.trim()
  );
  const salesTexts = salesTurns.map((item) => item.text);
  const salesNormalized = salesTexts.map(normalizeEvaluationText);
  const pattern3SalesTexts = salesTurns
    .filter((item) => item.phase === "pattern3")
    .map((item) => item.text);
  const pattern3Normalized = pattern3SalesTexts.map(normalizeEvaluationText);
  const pattern1SalesTexts = salesTurns
    .filter((item) => item.phase === "pattern1")
    .map((item) => item.text);
  const pattern1Normalized = pattern1SalesTexts.map(normalizeEvaluationText);
  const pattern2Items = items.filter(
    (item) =>
      item.phase === "pattern2" &&
      item.source !== "system" &&
      item.text.trim()
  );
  const pattern2SalesTexts = salesTurns
    .filter((item) => item.phase === "pattern2")
    .map((item) => item.text);
  const pattern2Normalized = pattern2SalesTexts.map(normalizeEvaluationText);
  const pattern3Items = items.filter(
    (item) =>
      item.phase === "pattern3" &&
      item.source !== "system" &&
      item.text.trim()
  );
  const phasesPresent = [...new Set(items.map((item) => item.phase))].filter(
    isEvaluationPhase
  );
  let currentNonSalesStreak = 0;
  let maxNonSalesStreak = 0;
  for (const item of items) {
    if (item.source === "system") continue;
    if (item.source === "user") {
      currentNonSalesStreak = 0;
      continue;
    }
    currentNonSalesStreak += 1;
    maxNonSalesStreak = Math.max(maxNonSalesStreak, currentNonSalesStreak);
  }
  let pattern2ImmediateSupplement = false;
  let pattern2RelayedQuestionCount = 0;
  let pattern2DirectQuestionCount = 0;
  let pattern2VisaQuestionCount = 0;
  let pattern2ExitedBeforeVisaExplanation = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.phase !== "pattern2" || item.source === "system" || !item.text.trim()) {
      continue;
    }
    if (item.source === "ai_b") {
      const next = getNextMeaningfulItem(index);
      if (
        next &&
        next.item.phase === "pattern2" &&
        next.item.source === "user" &&
        next.item.text.trim().length >= 18
      ) {
        pattern2ImmediateSupplement = true;
      }
    }
    if (item.source !== "ai_a") continue;
    const next = getNextMeaningfulItem(index);
    if (!next || next.item.phase !== "pattern2") continue;
    if (
      /ビザ|許可率|技人国|特定技能|入管/u.test(item.text)
    ) {
      pattern2VisaQuestionCount += 1;
      if (
        next.item.source === "user" &&
        /退出|生徒.*前|学生.*前|不安に感じ|後でご説明|この後にご説明/u.test(
          next.item.text
        )
      ) {
        pattern2ExitedBeforeVisaExplanation = true;
      }
    }
    if (next.item.source === "user") {
      const afterRelay = getNextMeaningfulItem(next.index);
      if (
        afterRelay &&
        afterRelay.item.phase === "pattern2" &&
        afterRelay.item.source === "ai_b"
      ) {
        pattern2RelayedQuestionCount += 1;
      }
      continue;
    }
    if (next.item.source === "ai_b") {
      pattern2DirectQuestionCount += 1;
    }
  }
  const pattern3CompanyTexts = pattern3Items
    .filter((item) => item.source === "ai_a")
    .map((item) => item.text);
  const pattern3CompanyNormalized = pattern3CompanyTexts.map(normalizeEvaluationText);
  const pattern3PendingReview = pattern3CompanyNormalized.some((text) =>
    /社内で検討|改めてご連絡|結果に関しては.*ご連絡|検討します/u.test(text)
  );
  const pattern3PositiveImpression = pattern3CompanyNormalized.some((text) =>
    /印象.*良かった|非常に良い印象|特に.*印象が良かった/u.test(text)
  );
  return {
    phasesPresent,
    salesTurnCount: salesTurns.length,
    maxNonSalesStreak,
    pattern1: {
      practicedAttendance: pattern1Normalized.some((text) =>
        /返事|名前を呼ばれたら|ジョンさん|大きな声/u.test(text)
      ),
      practicedReaction: pattern1Normalized.some((text) =>
        /リアクション|うなず|うんうん|反応/u.test(text)
      ),
      practicedWorkIntent: pattern1Normalized.some((text) =>
        /日本でずっと働きたい/u.test(text)
      ),
      practicedEffortAnswer: pattern1Normalized.some((text) =>
        /お仕事が大変でも大丈夫ですか|大丈夫です|頑張ります/u.test(text)
      ),
      coachedCompanyQuestions: pattern1Normalized.some((text) =>
        /会社へ質問|聞きたいこと|外国人の先輩|入社前に勉強/u.test(text)
      ),
      discouragedConditionQuestions: pattern1Normalized.some((text) =>
        /条件面|給料|給与|ビザ/.test(text) && /質問.*控|聞かない|避け/u.test(text)
      ),
      suggestedConditionQuestions: pattern1Normalized.some((text) =>
        /(給料|給与|ビザ|残業|休日|寮|家賃)/u.test(text) &&
        /質問|聞き/u.test(text)
      ),
      allowedTimeLimitedCommitment: pattern1Normalized.some((text) =>
        /10年働きたい|数年.*働きたい|何年.*働きたい/u.test(text)
      ),
      usedAdvancedBusinessTerms: pattern1SalesTexts.some((text) =>
        /理念|PDCA|コンプライアンス|KPI|ガバナンス|アサイン/u.test(text)
      )
    },
    pattern2: {
      requestedSelfIntroduction: pattern2Normalized.some((text) =>
        /自己紹介.*お願いします|自己紹介から|ひとりずつ自己紹介/u.test(text)
      ),
      gaveImmediateSupplement: pattern2ImmediateSupplement,
      explainedBusinessModel: pattern2Normalized.some(
        (text) =>
          /紹介料/.test(text) &&
          /(教育事業|受講料|授業料|日本語教育|ビジネスマナー教育)/.test(text)
      ),
      requestedCompanyOverview: pattern2Normalized.some((text) =>
        /1日のお仕事の流れ|会社様の雰囲気|お伝えをいただいてもよろしいでしょうか|皆さんにお伝え/u.test(
          text
        )
      ),
      checkedHardWorkCommitment: pattern2Normalized.some((text) =>
        /大変な時もあります|大変な時でも大丈夫|頑張れますか/u.test(text)
      ),
      relayedInterviewerQuestions: pattern2RelayedQuestionCount > 0,
      relayedInterviewerQuestionCount: pattern2RelayedQuestionCount,
      directInterviewerQuestionCount: pattern2DirectQuestionCount,
      promptedStudentExit: pattern2Normalized.some((text) =>
        /退出いただき|退出してください|退出していただき/u.test(text)
      ),
      handledVisaQuestionAfterExit:
        pattern2VisaQuestionCount === 0 || pattern2ExitedBeforeVisaExplanation,
      visaQuestionCount: pattern2VisaQuestionCount,
      usedAdvancedBusinessTerms: pattern2SalesTexts.some((text) =>
        /理念|PDCA|コンプライアンス|KPI|ガバナンス|アサイン/u.test(text)
      )
    },
    pattern3: {
      pendingReview: pattern3PendingReview,
      positiveImpression: pattern3PositiveImpression,
      askedImpression: pattern3Normalized.some((text) =>
        /印象|感想|どうでした|いかがでした/.test(text)
      ),
      acknowledgedCandidatePraise: pattern3Normalized.some((text) =>
        /落ち着いて受け答え|理解が早く|相性良さそう|印象が良かったですね|しっかりして/u.test(
          text
        )
      ),
      mentionedContractFlow: pattern3Normalized.some((text) =>
        /内定通知書|労働条件通知書|雇用契約書|雛形/.test(text)
      ),
      offeredTemplate: pattern3Normalized.some((text) =>
        /雛形|お送りさせていただく|お送りしておきましょう/u.test(text)
      ),
      explainedCannotNotifyBeforeOfferLetter: pattern3Normalized.some((text) =>
        /お送りいただくまで.*伝えできません|内定通知書.*まで.*伝えできません|本人に合格したことはお伝えできません/u.test(
          text
        )
      ),
      mentionedDeadline: pattern3Normalized.some((text) =>
        /本日中|明日中|2〜?3日以内|2-?3日以内|期限|いつまで|返送いただくことは可能/.test(
          text
        )
      ),
      askedTwoToThreeDayDeadline: pattern3Normalized.some((text) =>
        /2〜?3日以内|2-?3日以内/.test(text)
      ),
      askedSameOrNextDayDeadline: pattern3Normalized.some((text) =>
        /本日中|明日中/.test(text)
      ),
      explainedBusinessModel: pattern3Normalized.some(
        (text) =>
          /紹介料/.test(text) &&
          /(受講料|授業料|教育事業|日本語教育|ビジネスマナー教育)/.test(text)
      ),
      explainedGijinkoku: pattern3Normalized.some(
        (text) =>
          /技人国/.test(text) &&
          /(管理業務|キャリアアップ|単純作業|現場作業だけ)/.test(text)
      ),
      askedCareerPathForReasonLetter: pattern3Normalized.some((text) =>
        /採用理由書|キャリアアップの可能性|将来どのようなキャリアアップ/u.test(
          text
        )
      ),
      mentionedRequiredDocs: pattern3Normalized.some((text) =>
        /履歴事項全部証明書|登記簿謄本|法定調書合計表|決算報告書|会社概要|パンフレット|外観写真|事務所内写真|雇用保険適用事業所番号/u.test(
          text
        )
      ),
      mentionedVisaTimeline: pattern3Normalized.some((text) =>
        /1.?2ヶ月|3.?4ヶ月|5.?6ヶ月|1.?3か月|3.?6か月|審査期間/u.test(text)
      ),
      mentionedApprovalRate: pattern3Normalized.some((text) =>
        /70.?80%|70〜80%|許可率/u.test(text)
      )
    },
    ngFindings: detectEvaluationNgFindings(items, industry)
  };
};
const buildEvaluationScope = (
  items: EvaluationTranscriptItem[],
  scenarioMode: EvaluationScenarioMode,
  signals: ReturnType<typeof buildEvaluationSignals>
) => {
  const salesNormalized = items
    .filter((item) => item.source === "user")
    .map((item) => normalizeEvaluationText(item.text));
  const hasPattern1 = signals.phasesPresent.includes("pattern1");
  const hasPattern2 = signals.phasesPresent.includes("pattern2");
  const hasPattern3 = signals.phasesPresent.includes("pattern3");
  const pattern1Only = hasPattern1 && !hasPattern2 && !hasPattern3;
  const pattern2Only = hasPattern2 && !hasPattern1 && !hasPattern3;
  const pattern3Only = hasPattern3 && !hasPattern1 && !hasPattern2;
  const hasKnowledgeTopic = salesNormalized.some((text) =>
    /技人国|特定技能|管理業務|管理費|紹介料|受講料|授業料|ビザ|採用理由書|内定通知書|労働条件通知書|雇用契約書|必要書類/u.test(
      text
    )
  );
  const hasClosingTopic =
    hasPattern3 ||
    salesNormalized.some((text) =>
      /印象|感想|結果|2〜?3日以内|2-?3日以内|本日中|明日中|返送|期限|いつまで/u.test(
        text
      )
    );
  const applicableCategories = new Set<EvaluationCategoryKey>(["communication"]);
  if (hasPattern1 || hasPattern2) {
    applicableCategories.add("facilitation");
  }
  if (hasClosingTopic) {
    applicableCategories.add("closing");
  }
  if (hasKnowledgeTopic) {
    applicableCategories.add("knowledge");
  }
  const nonApplicableCategories = (
    Object.keys(EVALUATION_CATEGORY_LABELS) as EvaluationCategoryKey[]
  ).filter((key) => !applicableCategories.has(key));
  const forbiddenRegexes: RegExp[] = [];
  if (!hasPattern3) {
    forbiddenRegexes.push(
      /ビザ|技人国|特定技能|クロージング|面接後フロー|期日設定|期日|期限|本日中|明日中|内定通知書|労働条件通知書|必要書類|採用理由書|雇用契約書|結果.?連絡/u
    );
  }
  if (pattern1Only) {
    forbiddenRegexes.push(
      /学生からの質問.*回答|質問に対する具体的な回答|会社質問.*回答|知識正確性|制度説明/u
    );
  }
  if (pattern2Only) {
    forbiddenRegexes.push(
      /返事練習|リアクション練習|10年働きたい|日本でずっと働きたい|会社へ質問する内容を考える/u
    );
  }
  if (pattern3Only) {
    forbiddenRegexes.push(
      /出席確認|リアクション練習|自己紹介直後の補足|企業から学生への質問の中継|やさしい日本語化が不足/u
    );
  }
  const promptNotes: string[] = [];
  if (pattern1Only) {
    promptNotes.push(
      "pattern1 only です。評価対象は返事練習、リアクション練習、定型回答練習、学生が会社へ聞く質問の練習に限ってください。"
    );
    promptNotes.push(
      "pattern1 only では、『事前指導』『主導権の維持』『やさしい日本語』『学生に条件面の質問を控えるよう伝えたか』を明示的に見てください。"
    );
    promptNotes.push(
      "pattern1 の『会社へ質問する内容を考える』練習では、営業担当がその質問自体に会社として詳しく回答しなくても減点しないでください。目的は質問内容のコーチングです。"
    );
    promptNotes.push(
      "pattern1 only では、ビザ説明、面接後フロー、期日設定、必要書類、条件通知書、学生質問への会社回答不足を改善点に挙げてはいけません。"
    );
  }
  if (pattern2Only) {
    promptNotes.push(
      "pattern2 only です。評価対象は、営業が面接進行の主導権を維持できているか、学生へのやさしい日本語化、自己紹介直後の補足、企業への仕事内容説明依頼、企業質問の中継、学生退出の進行に限ってください。"
    );
    promptNotes.push(
      "pattern2 only では、part1 の返事練習・リアクション練習・『日本でずっと働きたい』練習や、part3 のクロージング・期日設定・必要書類案内を不足として指摘してはいけません。"
    );
    promptNotes.push(
      "企業が学生へ直接質問した場面では、営業が間に入ってやさしい日本語に言い換えたかを重視してください。学生の日本語レベルが高い場合でも、営業が長く蚊帳の外になる状態は高評価にしないでください。"
    );
    promptNotes.push(
      "企業からビザに関する質問が出た場合は、学生を退出させてから説明に移る判断ができたかだけを見てください。今回 transcript にビザ話題がなければ、その点を不足として書いてはいけません。"
    );
    promptNotes.push(
      "マニュアル通りに成立している定型発話に対して、『もっと具体的に』『もっと詳しく』といった上積み提案だけで改善点を作ってはいけません。改善点は、必須観点の欠落・逸脱・誤進行がある場合に限ってください。"
    );
  }
  if (pattern3Only) {
    promptNotes.push(
      "pattern3 only です。評価対象は、面接後の印象ヒアリング、結果連絡や内定通知書の進め方、期日設定、技人国説明、採用理由書・必要書類・審査期間などの説明に限ってください。"
    );
    promptNotes.push(
      "口頭内定が出ていない流れなら『2〜3日以内の結果連絡』と『内定通知書（労働条件通知書）雛形の先出し』を重視してください。口頭内定が出ている流れなら『候補者への軽い肯定フォロー』と『本日中/明日中の返送期日設定』を重視してください。"
    );
    promptNotes.push(
      "part3 では、今回 transcript に出ていない branch を不足として書いてはいけません。たとえば口頭内定が出ていない会話に対して、本日中返送を求めていないことを減点してはいけません。"
    );
    promptNotes.push(
      "改善点は、マニュアルで明示されている項目だけを扱ってください。主観的な営業トーク改善や独自ノウハウを追加してはいけません。"
    );
  }
  if (!hasPattern3) {
    promptNotes.push(
      "pattern3 が会話に存在しないため、クロージング未実施や期日設定不足を『不足』として書いてはいけません。"
    );
  }
  return {
    hasPattern1,
    hasPattern2,
    hasPattern3,
    pattern1Only,
    pattern2Only,
    pattern3Only,
    applicableCategories: [...applicableCategories],
    nonApplicableCategories,
    forbiddenRegexes,
    promptNotes,
    fallbackOverallComment: pattern1Only
      ? "事前練習の範囲では、進行と伝わり方を中心に評価しました。"
      : "営業発話を中心に、今回実施した練習範囲に限って評価しました。"
  };
};
const filterEvaluationListByScope = (
  items: string[],
  scope: ReturnType<typeof buildEvaluationScope>,
  limit: number
) =>
  dedupeStrings(
    items.filter(
      (item) =>
        item &&
        !scope.forbiddenRegexes.some((pattern) => pattern.test(item))
    ),
    limit
  );
const isActionableImprovementPoint = (text: string) =>
  /^L\d+[：:]/u.test(text) ||
  /^L\d+「.*」[：:]/u.test(text) ||
  /^L\d+\s/u.test(text);
const buildFallbackImprovementPoints = (
  items: EvaluationTranscriptItem[],
  scope: ReturnType<typeof buildEvaluationScope>
) => {
  const salesLines = buildEvaluationSalesLineReferences(items);
  const fallback: string[] = [];

  const exampleQuestionLine = salesLines.find((line) =>
    /いいですね.*外国人の先輩はいますか/u.test(line.text)
  );
  if (exampleQuestionLine) {
    fallback.push(
      `${exampleQuestionLine.line}「${clipEvaluationText(
        exampleQuestionLine.text,
        36
      )}」: 良い質問例を追加する意図は伝わりますが、学生が次に言うべき答えと混ざりやすいです。「いいですね。ほかには『外国人の先輩はいますか？』という聞き方もできます。」のように、例示だと分かる形にするとより自然です。`
    );
  }

  const longExplanationLine = salesLines.find(
    (line) => line.text.length >= 45 && line.phase === "pattern1"
  );
  if (longExplanationLine) {
    fallback.push(
      `${longExplanationLine.line}「${clipEvaluationText(
        longExplanationLine.text,
        36
      )}」: 説明がやや長いので、要点を短く区切ってから練習に入ると学生が反復しやすくなります。先に「次はリアクション練習です。」のように結論を一言置く形が有効です。`
    );
  }

  const transitionLine = salesLines.find((line) =>
    /面接官が入室するので.*面接を始めましょう/u.test(line.text)
  );
  if (transitionLine && scope.pattern1Only) {
    fallback.push(
      `${transitionLine.line}「${clipEvaluationText(
        transitionLine.text,
        36
      )}」: 練習の締めとしては自然ですが、「ここまでの返事と質問をそのまま使いましょう。」を一言足すと、学生が本番で何を再現すべきかがより明確になります。`
    );
  }

  if (scope.pattern1Only) {
    const earliestPattern1Line = salesLines.find((line) => line.phase === "pattern1");
    if (earliestPattern1Line) {
      fallback.push(
        `${earliestPattern1Line.line}「${clipEvaluationText(
          earliestPattern1Line.text,
          36
        )}」: 事前指導として「日本で長く働きたいと答えましょう」「給料やビザなど条件面の質問は先に出さないようにしましょう」を最初に一言入れると、練習の基準がより明確になります。`
      );
    }
  }

  return filterEvaluationListByScope(fallback, scope, 3);
};
const buildPattern1ManualImprovementPoints = (
  items: EvaluationTranscriptItem[],
  signals: ReturnType<typeof buildEvaluationSignals>,
  scope: ReturnType<typeof buildEvaluationScope>
) => {
  if (!scope.pattern1Only) return [] as string[];

  const salesLines = buildEvaluationSalesLineReferences(items).filter(
    (line) => line.phase === "pattern1"
  );
  if (!salesLines.length) return [] as string[];

  const firstLine = salesLines[0];
  const reactionLine =
    salesLines.find((line) => /リアクション|うなず|うんうん|反応/u.test(line.text)) ??
    firstLine;
  const workIntentLine =
    salesLines.find((line) => /日本でずっと働きたい|どれくらい働きたい/u.test(line.text)) ??
    firstLine;
  const effortLine =
    salesLines.find((line) => /大丈夫です|頑張ります|大変でも/u.test(line.text)) ??
    salesLines.find((line) => /質問練習/u.test(line.text)) ??
    workIntentLine;
  const questionLine =
    salesLines.find((line) => /質問がありますか|聞きたいこと|質問しましょう/u.test(line.text)) ??
    salesLines[salesLines.length - 1] ??
    firstLine;

  const improvements: string[] = [];

  if (!/手をあげ|手を上げ/u.test(firstLine.text)) {
    improvements.push(
      `${firstLine.line}「${clipEvaluationText(
        firstLine.text,
        36
      )}」: 出席確認では、返事だけでなく「手を上げて返事してください」まで明示すると、練習の意図がより伝わります。企業が本人を見つけやすくなる理由も一言添えると、より実践的です。`
    );
  }

  if (signals.pattern1.practicedReaction && !/印象|アピール|不安|理解している/u.test(reactionLine.text)) {
    improvements.push(
      `${reactionLine.line}「${clipEvaluationText(
        reactionLine.text,
        36
      )}」: リアクション練習はできていますが、「相槌があると日本語を理解している印象になる」「無反応だと企業が不安になる」まで添えると、指導の意図がより伝わりやすくなります。`
    );
  }

  if (signals.pattern1.practicedWorkIntent && !/10年|ずっと働きたい.*答えましょう/u.test(workIntentLine.text)) {
    improvements.push(
      `${workIntentLine.line}「${clipEvaluationText(
        workIntentLine.text,
        36
      )}」: 「日本でずっと働きたいです」の練習はできていますが、「10年働きたい」は避けることも合わせて伝えると、回答の意図までより明確に教えられます。`
    );
  }

  if (!signals.pattern1.practicedEffortAnswer) {
    improvements.push(
      `${effortLine.line}「${clipEvaluationText(
        effortLine.text,
        36
      )}」: 「お仕事が大変でも大丈夫ですか」「大丈夫です！頑張ります！」の練習が入っていないため、ここも反復練習として加えると、本番で返答しやすくなります。`
    );
  }

  if (
    signals.pattern1.coachedCompanyQuestions &&
    !/外国人の先輩|将来リーダー|入社前に勉強|仕事の時に大切/u.test(questionLine.text)
  ) {
    improvements.push(
      `${questionLine.line}「${clipEvaluationText(
        questionLine.text,
        36
      )}」: 質問練習では、良い質問例をもう少し具体的に示すと学生が再現しやすくなります。「外国人の先輩はいますか」「入社前に勉強することはありますか」などを明示すると効果的です。`
    );
  }

  if (!signals.pattern1.discouragedConditionQuestions) {
    improvements.push(
      `${questionLine.line}「${clipEvaluationText(
        questionLine.text,
        36
      )}」: 「給料・ビザ・引っ越し補助など条件面の質問はしない」と明確に伝えることが重要です。避けるべき質問例まで口頭で示すと、学生が注意点を理解しやすくなります。`
    );
  }

  return filterEvaluationListByScope(improvements, scope, 5);
};
const buildPattern2ManualImprovementPoints = (
  items: EvaluationTranscriptItem[],
  signals: ReturnType<typeof buildEvaluationSignals>,
  scope: ReturnType<typeof buildEvaluationScope>
) => {
  if (!scope.pattern2Only) return [] as string[];

  const salesLines = buildEvaluationSalesLineReferences(items).filter(
    (line) => line.phase === "pattern2"
  );
  if (!salesLines.length) return [] as string[];

  const firstLine = salesLines[0];
  const selfIntroLine =
    salesLines.find((line) => /自己紹介/u.test(line.text)) ?? firstLine;
  const companyOverviewLine =
    salesLines.find(
      (line) => /1日のお仕事の流れ|会社様の雰囲気|お伝えをいただいて/u.test(line.text)
    ) ?? selfIntroLine;
  const hardWorkLine =
    salesLines.find((line) => /大変な時もあります|頑張れますか/u.test(line.text)) ??
    companyOverviewLine;
  const exitLine =
    salesLines.find((line) => /退出/u.test(line.text)) ??
    salesLines[salesLines.length - 1] ??
    firstLine;
  const advancedTermsLine = salesLines.find((line) =>
    /理念|PDCA|コンプライアンス|KPI|ガバナンス|アサイン/u.test(line.text)
  );
  const improvements: string[] = [];

  if (
    signals.pattern2.requestedSelfIntroduction &&
    !signals.pattern2.gaveImmediateSupplement
  ) {
    improvements.push(
      `${selfIntroLine.line}「${clipEvaluationText(
        selfIntroLine.text,
        36
      )}」: 学生の自己紹介後に営業からの補足説明がすぐ入っていないため、主導権が企業側へ移りやすくなります。自己紹介直後に、担当目線の強みと本人の意欲を短く補足してから次へつなぐ形にすると進行が安定します。`
    );
  }

  if (!signals.pattern2.requestedCompanyOverview) {
    improvements.push(
      `${companyOverviewLine.line}「${clipEvaluationText(
        companyOverviewLine.text,
        36
      )}」: 企業説明へのつなぎがやや弱くなっています。事前に仕事内容・給料・勤務地・勤務時間は共有済みであることを伝えたうえで、「1日のお仕事の流れや会社の雰囲気を皆さんへお話しいただけますか」と依頼すると、流れがより自然にまとまります。`
    );
  }

  if (!signals.pattern2.checkedHardWorkCommitment) {
    improvements.push(
      `${hardWorkLine.line}「${clipEvaluationText(
        hardWorkLine.text,
        36
      )}」: 企業説明後の「大変な時でも大丈夫ですか」「頑張れますか」という確認が入っていません。学生の意思をその場で確認してから企業へ返すと、安心感と進行の主導権を両立できます。`
    );
  }

  if (signals.pattern2.directInterviewerQuestionCount > 0) {
    improvements.push(
      `${companyOverviewLine.line}「${clipEvaluationText(
        companyOverviewLine.text,
        36
      )}」: 企業と学生の直接やり取りが発生しています。企業からの質問には営業が間に入り、学生が理解しやすい短い日本語に言い換えてから回答を促すと、進行がより安定します。`
    );
  }

  if (
    signals.pattern2.visaQuestionCount > 0 &&
    !signals.pattern2.handledVisaQuestionAfterExit
  ) {
    improvements.push(
      `${exitLine.line}「${clipEvaluationText(
        exitLine.text,
        36
      )}」: ビザに関する質問が学生の前で出た場合は、その場で回答せず、まず学生に退出いただいてから説明へ移る必要があります。「生徒の前だと不安に感じてしまうので、この後ご説明してもよろしいでしょうか」と切り分ける言い方が適切です。`
    );
  }

  if (advancedTermsLine) {
    improvements.push(
      `${advancedTermsLine.line}「${clipEvaluationText(
        advancedTermsLine.text,
        36
      )}」: 学生に向ける場面で難しい用語が入ると理解しづらくなります。企業の質問を中継するときは、短くやさしい日本語に置き換えてから伝えると、通訳としての役割がより明確になります。`
    );
  }

  if (!signals.pattern2.promptedStudentExit) {
    improvements.push(
      `${exitLine.line}「${clipEvaluationText(
        exitLine.text,
        36
      )}」: 面接の締めでは、学生に退出いただいたうえで企業とのヒアリングへ移る案内があると流れが明確になります。「それでは生徒さんには退出いただき、この後少しヒアリングのお時間をいただいてもよろしいでしょうか」とつなぐ形が自然です。`
    );
  }

  return filterEvaluationListByScope(improvements, scope, 5);
};
const buildPattern3ManualImprovementPoints = (
  items: EvaluationTranscriptItem[],
  signals: ReturnType<typeof buildEvaluationSignals>,
  scope: ReturnType<typeof buildEvaluationScope>
) => {
  if (!scope.pattern3Only) return [] as string[];

  const salesLines = buildEvaluationSalesLineReferences(items).filter(
    (line) => line.phase === "pattern3"
  );
  if (!salesLines.length) return [] as string[];

  const firstLine = salesLines[0];
  const impressionLine =
    salesLines.find((line) => /印象|感想|いかがでした/u.test(line.text)) ?? firstLine;
  const contractLine =
    salesLines.find((line) => /内定通知書|労働条件通知書|雛形|雇用契約書/u.test(line.text)) ??
    impressionLine;
  const gijinkokuLine =
    salesLines.find((line) => /技人国|管理業務|キャリアアップ|単純作業/u.test(line.text)) ??
    contractLine;
  const docsLine =
    salesLines.find(
      (line) =>
        /履歴事項全部証明書|登記簿謄本|法定調書|決算報告書|外観写真|雇用保険適用事業所番号/u.test(
          line.text
        )
    ) ?? gijinkokuLine;
  const deadlineLine =
    salesLines.find((line) => /2〜?3日以内|2-?3日以内|本日中|明日中|返送/u.test(line.text)) ??
    contractLine;
  const noticeLine =
    salesLines.find((line) => /本人に合格したことはお伝えできません|伝えできません/u.test(line.text)) ??
    contractLine;
  const timelineLine =
    salesLines.find((line) => /ヶ月|か月|審査期間|70.?80%|許可率/u.test(line.text)) ??
    docsLine;

  const improvements: string[] = [];

  if (!signals.pattern3.askedImpression) {
    improvements.push(
      `${impressionLine.line}「${clipEvaluationText(
        impressionLine.text,
        36
      )}」: 面接後ヒアリングの冒頭では、まず企業全体の印象を確認したい場面です。「本日ご面接いただいた皆さまの全体的な印象はいかがでしたでしょうか」と先に聞くと、温度感を自然に把握しやすくなります。`
    );
  }

  if (signals.pattern3.pendingReview && !signals.pattern3.askedTwoToThreeDayDeadline) {
    improvements.push(
      `${deadlineLine.line}「${clipEvaluationText(
        deadlineLine.text,
        36
      )}」: 口頭内定が出ていない流れでは、「2〜3日以内に結果のご連絡をいただくことは可能でしょうか」と具体的に期限を切ることが重要です。「なるべく早く」だけだと、次の動きが曖昧になりやすくなります。`
    );
  }

  if (signals.pattern3.pendingReview && !signals.pattern3.offeredTemplate) {
    improvements.push(
      `${contractLine.line}「${clipEvaluationText(
        contractLine.text,
        36
      )}」: 口頭内定が出ていない場合でも、内定通知書（労働条件通知書）の雛形は先に送る運用が必要です。「弊社に雛形がございますので、お送りさせていただくことも可能ですがいかがでしょうか」と一言入れると、回収遅れを防ぎやすくなります。`
    );
  }

  if (signals.pattern3.positiveImpression && !signals.pattern3.acknowledgedCandidatePraise) {
    improvements.push(
      `${impressionLine.line}「${clipEvaluationText(
        impressionLine.text,
        36
      )}」: 企業が良い印象を示した場面では、挙がった候補者を営業側が軽く肯定して後押しできると、クロージングがより自然になります。「〇〇さんは落ち着いて受け答えされていましたね」のように短く言語化すると伝わりやすいです。`
    );
  }

  if (signals.pattern3.positiveImpression && !signals.pattern3.askedSameOrNextDayDeadline) {
    improvements.push(
      `${deadlineLine.line}「${clipEvaluationText(
        deadlineLine.text,
        36
      )}」: 口頭内定が出ている流れでは、「本日中に返送いただくことは可能でしょうか」「午後面接なら明日中でお願いできますか」と、営業側から具体日程を切ることが大切です。「いつ頃まで」だけだと、回収時期がぼやけやすくなります。`
    );
  }

  if (!signals.pattern3.explainedGijinkoku) {
    improvements.push(
      `${gijinkokuLine.line}「${clipEvaluationText(
        gijinkokuLine.text,
        36
      )}」: 技人国ビザの説明では、「単純作業や現場作業だけは不可」「将来的に管理業務のキャリアパスが必要」という要点を明確に伝える必要があります。管理業務の具体例まで添えると、制度説明として十分になります。`
    );
  } else if (!signals.pattern3.askedCareerPathForReasonLetter) {
    improvements.push(
      `${gijinkokuLine.line}「${clipEvaluationText(
        gijinkokuLine.text,
        36
      )}」: 技人国の説明後は、採用理由書の作成に向けて「御社で将来どのようなキャリアアップの可能性があるか」を確認できると、その後の書類準備へつなげやすくなります。`
    );
  }

  if (!signals.pattern3.explainedCannotNotifyBeforeOfferLetter) {
    improvements.push(
      `${noticeLine.line}「${clipEvaluationText(
        noticeLine.text,
        36
      )}」: 内定通知書（労働条件通知書）を受領するまでは、本人に合格と伝えられない点を明示する必要があります。「書面をいただくまでは本人へ合格をお伝えできません」とはっきり伝えると、回収の優先度が上がります。`
    );
  }

  if (!signals.pattern3.mentionedRequiredDocs) {
    improvements.push(
      `${docsLine.line}「${clipEvaluationText(
        docsLine.text,
        36
      )}」: 必要書類の案内が不足しています。少なくとも、登記簿謄本、法定調書合計表、決算報告書、会社概要、雇用契約書、写真類、雇用保険適用事業所番号などを案内できると、説明がより十分になります。`
    );
  }

  if (!signals.pattern3.mentionedVisaTimeline || !signals.pattern3.mentionedApprovalRate) {
    improvements.push(
      `${timelineLine.line}「${clipEvaluationText(
        timelineLine.text,
        36
      )}」: 申請後の見通しとして、審査期間と許可率の案内があるとより十分です。国内外でのおおよその期間と、「許可率は70〜80%程度で100%ではない」点まで伝えると、リスク説明として適切です。`
    );
  }

  return filterEvaluationListByScope(improvements, scope, 5);
};
const buildDefaultEvaluationCategories = (): Record<
  EvaluationCategoryKey,
  EvaluationCategoryResult
> => ({
  facilitation: {
    score: null,
    label: "N/A",
    summary: "該当する発話が不足しているため未評価です。",
    evidence: []
  },
  closing: {
    score: null,
    label: "N/A",
    summary: "該当する発話が不足しているため未評価です。",
    evidence: []
  },
  knowledge: {
    score: null,
    label: "N/A",
    summary: "該当する発話が不足しているため未評価です。",
    evidence: []
  },
  communication: {
    score: null,
    label: "N/A",
    summary: "該当する発話が不足しているため未評価です。",
    evidence: []
  }
});

if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is not set.");
  process.exit(1);
}

type AiKey = "ai_a" | "ai_b";
type RelayTarget = AiKey | "none";
type PlannerConfidence = "high" | "medium" | "low";
type Pattern3Decision = "pending_review" | "verbal_offer";

type AiProfile = { name: string; voice: string; instructions: string };
type RealtimeSessionUpdate = {
  type: "session.update";
  session: Record<string, unknown>;
};
type CandidateTurnPlan = {
  utterance: string;
  confidence: PlannerConfidence;
  exact: boolean;
  reason?: string;
};
type InterviewerTurnPlan = {
  utterance: string;
  confidence: PlannerConfidence;
  exact: boolean;
  reason?: string;
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

const buildSessionUpdate = (profile: AiProfile): RealtimeSessionUpdate => ({
  type: "session.update",
  session: {
    type: "realtime",
    instructions: profile.instructions,
    // Realtime GA shape. Do not move these fields back to the old beta layout:
    // session.voice / mixed ["text","audio"] output_modalities caused session.update
    // failures, which left sessionsReady false and disabled Start Mic.
    audio: {
      input: {
        format: {
          type: "audio/pcm",
          rate: 24000
        },
        noise_reduction: {
          type: "near_field"
        },
        transcription: {
          model: OPENAI_TRANSCRIPTION_MODEL
        },
        turn_detection: null
      },
      output: {
        voice: profile.voice,
        format: {
          type: "audio/pcm",
          rate: 24000
        }
      }
    },
    output_modalities: ["audio"]
  }
});

const createRealtimeConnection = (
  getSessionUpdate: () => RealtimeSessionUpdate,
  handlers: RealtimeHandlers
) => {
  const ws = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    }
  });

  ws.on("open", () => {
    ws.send(JSON.stringify(getSessionUpdate()));
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

    if (
      event.type === "session.created" ||
      event.type === "session.updated" ||
      event.type === "transcription_session.created" ||
      event.type === "transcription_session.updated"
    ) {
      handlers.onReady();
      return;
    }

    // Realtime GA uses response.output_audio* / response.output_audio_transcript*.
    // Keep both GA and older aliases here; narrowing this broke AI speech playback/text.
    if (
      event.type === "response.audio.delta" ||
      event.type === "response.output_audio.delta"
    ) {
      handlers.onAudioDelta(String(event.delta ?? ""));
      return;
    }

    if (
      event.type === "response.audio.done" ||
      event.type === "response.output_audio.done"
    ) {
      handlers.onAudioDone();
      return;
    }

    if (
      event.type === "response.audio_transcript.delta" ||
      event.type === "response.output_audio_transcript.delta"
    ) {
      handlers.onTranscriptDelta(String(event.delta ?? ""));
      return;
    }

    if (
      event.type === "response.audio_transcript.done" ||
      event.type === "response.output_audio_transcript.done"
    ) {
      handlers.onTranscriptDone(String(event.transcript ?? ""));
      return;
    }

    if (typeof event.type === "string" && event.type.includes("input_audio_transcription")) {
      const transcript =
        typeof event.transcript === "string"
          ? event.transcript
          : typeof event.text === "string"
            ? event.text
            : typeof event.delta === "string"
              ? event.delta
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
      console.error("[OpenAI] Error payload:", JSON.stringify(event));
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

app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    origin &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(origin)
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

const clientRoot = path.resolve(__dirname, "..", "..", "frontend", "dist");
app.use(express.static(clientRoot));
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/evaluate", async (req, res) => {
  const body = req.body as {
    scenarioMode?: unknown;
    candidateLevel?: unknown;
    industry?: unknown;
    interviewerDifficulty?: unknown;
    interviewerLiteracy?: unknown;
    interviewerPersonality?: unknown;
    interviewerDialect?: unknown;
    transcripts?: unknown;
  };

  const scenarioMode = isEvaluationScenarioMode(body.scenarioMode)
    ? body.scenarioMode
    : "unified";
  const candidateLevel =
    body.candidateLevel === "basic" ||
    body.candidateLevel === "standard" ||
    body.candidateLevel === "prototype"
      ? body.candidateLevel
      : "basic";
  const industry =
    body.industry === "construction" ||
    body.industry === "food" ||
    body.industry === "manufacturing" ||
    body.industry === "hotel" ||
    body.industry === "care"
      ? body.industry
      : "construction";
  const interviewerDifficulty =
    body.interviewerDifficulty === "easy" || body.interviewerDifficulty === "hard"
      ? body.interviewerDifficulty
      : "easy";
  const interviewerLiteracy =
    body.interviewerLiteracy === "low" ||
    body.interviewerLiteracy === "medium" ||
    body.interviewerLiteracy === "high"
      ? body.interviewerLiteracy
      : "medium";
  const interviewerPersonality =
    body.interviewerPersonality === "balanced" ||
    body.interviewerPersonality === "meticulous" ||
    body.interviewerPersonality === "rough" ||
    body.interviewerPersonality === "curious"
      ? body.interviewerPersonality
      : "balanced";
  const interviewerDialect =
    body.interviewerDialect === "standard" || body.interviewerDialect === "kansai"
      ? body.interviewerDialect
      : "standard";

  const transcripts = Array.isArray(body.transcripts)
    ? body.transcripts
        .map((item): EvaluationTranscriptItem | null => {
          if (!item || typeof item !== "object") return null;
          const candidate = item as Record<string, unknown>;
          if (
            !isEvaluationTranscriptSource(candidate.source) ||
            !isEvaluationPhase(candidate.phase) ||
            typeof candidate.text !== "string"
          ) {
            return null;
          }
          const text = candidate.text.trim();
          if (!text) return null;
          return {
            source: candidate.source,
            phase: candidate.phase,
            name:
              typeof candidate.name === "string" && candidate.name.trim()
                ? candidate.name.trim()
                : toEvaluationSpeakerLabel({
                    source: candidate.source,
                    phase: candidate.phase,
                    name: "",
                    text
                  }),
            text: text.slice(0, 1400)
          };
        })
        .filter((item): item is EvaluationTranscriptItem => Boolean(item))
    : [];

  if (!transcripts.length) {
    res.status(400).json({ message: "評価対象の会話ログがありません。" });
    return;
  }

  const salesTurns = transcripts.filter(
    (item) => item.source === "user" && item.text.trim()
  );
  if (!salesTurns.length) {
    res.status(400).json({ message: "営業発話がないため評価できません。" });
    return;
  }

  const evaluationSignals = buildEvaluationSignals(transcripts, industry);
  const evaluationScope = buildEvaluationScope(
    transcripts,
    scenarioMode,
    evaluationSignals
  );
  const pattern1ManualImprovementPoints = buildPattern1ManualImprovementPoints(
    transcripts,
    evaluationSignals,
    evaluationScope
  );
  const pattern2ManualImprovementPoints = buildPattern2ManualImprovementPoints(
    transcripts,
    evaluationSignals,
    evaluationScope
  );
  const pattern3ManualImprovementPoints = buildPattern3ManualImprovementPoints(
    transcripts,
    evaluationSignals,
    evaluationScope
  );
  const transcriptLines = buildEvaluationTranscriptLines(transcripts);
  const salesLineReferences = buildEvaluationSalesLineReferences(transcripts);
  const defaultCategories = buildDefaultEvaluationCategories();
  try {
    const evaluationRequestBody = {
      model: OPENAI_EVALUATION_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "あなたは外国人面接練習アプリ専用の厳格な評価者です。評価対象は営業担当の発話だけです。学生・面接官・企業の発話は、営業の説明が噛み合っているか、質問意図に答えられているか、伝わり方に問題があるかを判断する根拠としてだけ使ってください。今回 transcript に出ていない phase や話題を『不足』として指摘してはいけません。評価は今回実際に練習した範囲だけに限定してください。ASR 誤りには寛容に対応してください。相手が『承知しました』と返していても、営業側の説明が不十分・不正確なら高得点にしないでください。スコア定義は 5=Perfect, 4=Good, 3=Pass, 2=Fail, 1=Bad/NG です。根拠が薄いカテゴリは score を null にしてください。法的に危険な誤りや NG ワードがある場合は、関連カテゴリを 1 点相当に寄せてください。特に pattern1 only では、『事前指導』『主導権の維持』『やさしい日本語』『条件面の質問を控えさせる指導』を明示的に評価してください。Return strict JSON with keys categories, good_points, improvement_points, conversation_issues, overall_comment. categories must have facilitation, closing, knowledge, communication. Each category must have score (number 1-5 or null), summary (short Japanese), evidence (array of up to 2 short Japanese strings). The summary for each scored category must explain why that score was given. The evidence items should be short concrete reasons or cited moments, ideally with line numbers when possible. good_points should have 2-4 items and only mention topics that actually appeared in this transcript. improvement_points should have 2-4 items, and every item must cite one sales line by line number first, such as `L3「〜」: ...`. Each improvement must explain both what was weak in that exact utterance and how to say or structure it better. Do not give abstract advice without line references. conversation_issues should have 0-3 items and focus only on会話の噛み合わなさ・言い回しの不自然さ・省略 within the practiced scope."
        },
        {
          role: "user",
          content: JSON.stringify({
            appContext: {
              scenarioMode,
              candidateLevel,
              industry: getIndustryScenario(industry).label,
              interviewerDifficulty,
              interviewerLiteracy,
              interviewerPersonality,
              interviewerDialect
            },
            scoringRubric: {
              overallPolicy:
                "マニュアルの一言一句通りでなくても、成果として相手が納得できる説明なら高評価。",
              categories: {
                facilitation:
                  "主導権の維持、学生へのやさしい日本語化、進行のリード。主に pattern1/pattern2 を見る。",
                closing:
                  "感想ヒアリング、合格後フロー提示、期日設定。主に pattern3 を見る。",
                knowledge:
                  "無料紹介の理由、技人国ビザ、特定技能との差分などの説明正確性。主に pattern3 を見る。pattern2 only では、事業紹介を実施した場合の『無料紹介の理由』だけを見て、技人国ビザのリスク説明不足を指摘してはいけない。",
                communication:
                  "相手理解に合わせた説明、日本語の自然さ、根拠ある安心感、傾聴と共感。全体を見る."
              }
            },
            phaseSpecificRubric: {
              pattern1:
                "pattern1 では、進行管理と態度・伝わり方を中心に採点する。必須観点は ①出席確認（できれば手を上げる指示まで） ②リアクション練習とその理由説明 ③『日本でずっと働きたいです』の練習と『10年働きたい』を避ける注意 ④『大丈夫です！頑張ります！』の練習 ⑥良い質問の練習と、給料・ビザなど条件面の質問を避ける指導。⑤会社説明は今回省略してよい。特に (1) 学生へ望ましい回答を教えられているか、(2) 条件面の質問を控えるよう事前指導できているか、(3) 営業が練習を主導し各練習を整理して進めているか、(4) 学生向けにやさしい日本語で短く説明できているか、を明示的に見る。5点はこの必須観点が高水準で揃っている状態。3点は主要な定型回答練習はできているが、重要練習や注意喚起が一部抜けている状態。2点以下は期限付き回答の容認、条件面質問の放置、難しい用語の多用、学生が理解しにくい長い説明などが見られる状態。改善点では、必須観点のうち今回練習できていない項目があれば必ず具体的に指摘すること。",
              pattern2:
                "pattern2 では、進行管理と態度・伝わり方を中心に採点する。必須観点は ①営業が自己紹介開始を案内できているか ②学生の自己紹介直後に担当目線の補足や本人の意欲の代弁をすぐ入れて主導権を維持できているか ③企業へ仕事内容・1日の流れ・雰囲気の説明を依頼できているか ④企業から学生への質問に営業が必ず間に入り、やさしい日本語へ言い換えて中継できているか ⑤企業説明後に『大変な時でも大丈夫ですか』『頑張れますか』の確認ができているか ⑥ビザ話題が出た場合に学生を退出させてから説明へ切り替えられるか。5点は、営業が終始主導権を持ち、学生にも企業にも分かりやすくつないでいる状態。3点は、進行自体は成立しているが、補足説明・質問中継・やさしい日本語化のいずれかが弱い状態。2点以下は、企業と学生の直接会話を放置する、自己紹介後の補足がなく主導権を失う、難しい言葉のまま学生へ振る、ビザ話題を学生前で処理するなど、マニュアルから外れる状態。定型として成立している発話に対して、『もっと具体的に』『もっと詳しく』といった上積み提案だけで改善点を作ってはいけません。改善点は、必須観点の欠落・逸脱・誤進行がある sales line に限り、どの line をどう直すべきかを具体的に示すこと。",
              pattern3:
                "pattern3 では、クロージング・知識正確性・態度/伝わり方を中心に採点する。必須観点は、会話の branch に応じて判定する。口頭内定が出ていない流れでは ①最初に全体的な印象を聞けているか ②『2〜3日以内に結果連絡をいただけるか』と具体期日を切れているか ③口頭内定前でも内定通知書（労働条件通知書）の雛形送付を提案できているか ④内定通知書受領までは本人に合格と伝えられないことを明示できているか、を重視する。口頭内定が出ている流れでは ①企業が挙げた候補者を軽く肯定して後押しできているか ②本日中または明日中の返送期日を営業側から具体的に切れているか、を重視する。共通観点として ③技人国ビザについて『単純作業だけは不可』『将来的な管理業務のキャリアパスが必要』を正確に説明できているか ④採用理由書のため将来のキャリアアップ可能性を確認できているか ⑤必要書類、審査期間、許可率などの案内が適切か、をみる。5点は、branch に応じた必須事項を押さえ、制度説明にも誤りがなく、回収・次工程まで明確に進められている状態。3点は、大枠は正しいが、期限設定・雛形送付・本人通知不可の明示など重要要素が一部弱い状態。2点以下は、曖昧な期日で終える、技人国説明が不正確、書面回収前に合格連絡できるように聞こえる、などマニュアルから外れる状態。改善点では、どの sales line をどう言い換えればよかったかまで具体的に示すこと。"
            },
            groundTruth: {
              gijinkoku:
                "学歴要件を満たした高度人材向け。更新制（1年・3年・5年）で更新継続により長期就労可。管理費不要。単純作業だけは不可で、将来的な管理業務のキャリアパスが必要。",
              tokutei:
                "原則最長5年。支援機関や監理団体が入り、月々の管理費が発生する。",
              businessModel:
                "教育事業の受講料・授業料で収益化しているため、企業への紹介料は無料。"
            },
            scopeControl: {
              phasesPresent: evaluationSignals.phasesPresent,
              applicableCategories: evaluationScope.applicableCategories,
              nonApplicableCategories: evaluationScope.nonApplicableCategories,
              notes: evaluationScope.promptNotes
            },
            machineSignals: evaluationSignals,
            salesLineReferences,
            transcript: transcriptLines
          })
        }
      ]
    };

    let response: Response | null = null;
    let lastEvaluationError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);
      try {
        response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`
          },
          signal: controller.signal,
          body: JSON.stringify(evaluationRequestBody)
        });
        if (response.ok) {
          clearTimeout(timeoutId);
          break;
        }
        lastEvaluationError = new Error(`OpenAI evaluation status ${response.status}`);
        const errorText = await response.text();
        console.error(`[EvaluationAPI] OpenAI error attempt ${attempt}:`, errorText);
      } catch (error) {
        lastEvaluationError = error;
        console.error(`[EvaluationAPI] fetch attempt ${attempt} failed:`, error);
      } finally {
        clearTimeout(timeoutId);
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    if (!response || !response.ok) {
      console.error("[EvaluationAPI] final error:", lastEvaluationError);
      res.status(502).json({ message: "評価生成に失敗しました。" });
      return;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      res.status(502).json({ message: "評価結果の取得に失敗しました。" });
      return;
    }

    const parsed = JSON.parse(content) as {
      categories?: Partial<
        Record<
          EvaluationCategoryKey,
          {
            score?: unknown;
            summary?: unknown;
            evidence?: unknown;
          }
        >
      >;
      good_points?: unknown;
      improvement_points?: unknown;
      conversation_issues?: unknown;
      overall_comment?: unknown;
    };

    const categories = buildDefaultEvaluationCategories();
    for (const key of Object.keys(categories) as EvaluationCategoryKey[]) {
      if (evaluationScope.nonApplicableCategories.includes(key)) {
        categories[key] = {
          score: null,
          label: "N/A",
          summary: "今回の練習範囲では未評価です。",
          evidence: []
        };
        continue;
      }
      const candidate = parsed.categories?.[key];
      const score = coerceEvaluationScore(candidate?.score);
      const summary =
        typeof candidate?.summary === "string" && candidate.summary.trim()
          ? candidate.summary.trim()
          : categories[key].summary;
      const evidence = Array.isArray(candidate?.evidence)
        ? dedupeStrings(
            candidate.evidence.filter((item): item is string => typeof item === "string"),
            2
          )
        : [];
      categories[key] = {
        score,
        label: scoreToEvaluationLabel(score),
        summary,
        evidence
      };
    }

    for (const finding of evaluationSignals.ngFindings) {
      const current = categories[finding.category];
      categories[finding.category] = {
        score: 1,
        label: scoreToEvaluationLabel(1),
        summary: `${current.summary} NG表現または危険説明が含まれています。`.trim(),
        evidence: dedupeStrings(
          [...current.evidence, `${finding.phase}: ${finding.phrase}`],
          2
        )
      };
    }

    const scoredValues = (Object.keys(categories) as EvaluationCategoryKey[])
      .map((key) => categories[key].score)
      .filter((value): value is number => value !== null);
    const overallScore = scoredValues.length
      ? Math.round((scoredValues.reduce((sum, value) => sum + value, 0) / scoredValues.length) * 10) / 10
      : null;
    const parsedOverallComment =
      typeof parsed.overall_comment === "string"
        ? parsed.overall_comment.trim()
        : "";

    const aiImprovementPoints = Array.isArray(parsed.improvement_points)
      ? filterEvaluationListByScope(
          parsed.improvement_points.filter(
            (item): item is string =>
              typeof item === "string" && isActionableImprovementPoint(item)
          ),
          evaluationScope,
          5
        )
      : [];

    const responseBody: EvaluationResponseBody = {
      overallScore,
      overallLabel: scoreToEvaluationLabel(overallScore),
      overallComment:
        parsedOverallComment &&
        !evaluationScope.forbiddenRegexes.some((pattern) =>
          pattern.test(parsedOverallComment)
        )
          ? parsedOverallComment
          : evaluationScope.fallbackOverallComment,
      categories,
      goodPoints: Array.isArray(parsed.good_points)
        ? filterEvaluationListByScope(
            parsed.good_points.filter((item): item is string => typeof item === "string"),
            evaluationScope,
            4
          )
        : [],
      improvementPoints: aiImprovementPoints,
      conversationIssues: Array.isArray(parsed.conversation_issues)
        ? filterEvaluationListByScope(
            parsed.conversation_issues.filter(
              (item): item is string => typeof item === "string"
            ),
            evaluationScope,
            3
          )
        : [],
      ngFindings: evaluationSignals.ngFindings
    };

    if (evaluationScope.pattern2Only) {
      const pattern2SalesLines = salesLineReferences.filter(
        (line) => line.phase === "pattern2"
      );
      const businessModelLine =
        pattern2SalesLines.find((line) =>
          /紹介料|教育事業|受講料|授業料/u.test(line.text)
        ) ?? null;
      const relayLine =
        pattern2SalesLines.find((line) =>
          /ジョンさん、|皆さん、|大丈夫ですか|働きたいですか|何ですか/u.test(line.text)
        ) ?? null;
      const hasObjectiveCommunicationIssue =
        evaluationSignals.pattern2.usedAdvancedBusinessTerms ||
        evaluationSignals.pattern2.directInterviewerQuestionCount > 0;
      const satisfiedFacilitationChecklist =
        evaluationSignals.pattern2.requestedSelfIntroduction &&
        evaluationSignals.pattern2.gaveImmediateSupplement &&
        evaluationSignals.pattern2.requestedCompanyOverview &&
        evaluationSignals.pattern2.checkedHardWorkCommitment &&
        evaluationSignals.pattern2.promptedStudentExit &&
        evaluationSignals.pattern2.directInterviewerQuestionCount === 0 &&
        evaluationSignals.pattern2.handledVisaQuestionAfterExit;

      responseBody.conversationIssues = [];

      if (evaluationSignals.pattern2.explainedBusinessModel) {
        responseBody.categories.knowledge = {
          score: Math.max(responseBody.categories.knowledge.score ?? 4, 4),
          label: scoreToEvaluationLabel(
            Math.max(responseBody.categories.knowledge.score ?? 4, 4)
          ),
          summary:
            "無料紹介の理由を教育事業ベースで説明できており、事業紹介としての正確性は概ね良好です。",
          evidence: businessModelLine
            ? [
                `${businessModelLine.line}「${clipEvaluationText(
                  businessModelLine.text,
                  34
                )}」`
              ]
            : []
        };
      } else {
        responseBody.categories.knowledge = {
          score: null,
          label: "N/A",
          summary: "今回の練習範囲では未評価です。",
          evidence: []
        };
      }

      if (!hasObjectiveCommunicationIssue) {
        const communicationScore = Math.max(
          responseBody.categories.communication.score ?? 4,
          4
        );
        responseBody.categories.communication = {
          score: communicationScore,
          label: scoreToEvaluationLabel(communicationScore),
          summary:
            "営業が企業の質問や意図を学生へ中継できており、伝わり方は概ね良好です。",
          evidence: relayLine
            ? [
                `${relayLine.line}「${clipEvaluationText(relayLine.text, 34)}」`
              ]
            : []
        };
      }

      if (satisfiedFacilitationChecklist) {
        responseBody.categories.facilitation = {
          score: 5,
          label: scoreToEvaluationLabel(5),
          summary:
            "営業が面接の主導権を維持し、自己紹介、補足、企業説明依頼、学生確認、退出まで安定して進行できています。",
          evidence: dedupeStrings(
            [
              pattern2SalesLines[0]
                ? `${pattern2SalesLines[0].line}「${clipEvaluationText(
                    pattern2SalesLines[0].text,
                    34
                  )}」`
                : "",
              relayLine
                ? `${relayLine.line}「${clipEvaluationText(relayLine.text, 34)}」`
                : ""
            ],
            2
          )
        };
      }

      if (satisfiedFacilitationChecklist && !hasObjectiveCommunicationIssue) {
        responseBody.overallComment =
          "営業が主導権を維持し、企業質問の中継や学生への確認も安定して行えていました。今回の練習で重視したいポイントはしっかり押さえられています。";
      }
    }

    const rescoredValues = (Object.keys(responseBody.categories) as EvaluationCategoryKey[])
      .map((key) => responseBody.categories[key].score)
      .filter((value): value is number => value !== null);
    responseBody.overallScore = rescoredValues.length
      ? Math.round(
          (rescoredValues.reduce((sum, value) => sum + value, 0) / rescoredValues.length) *
            10
        ) / 10
      : null;
    responseBody.overallLabel = scoreToEvaluationLabel(responseBody.overallScore);

    responseBody.improvementPoints = dedupeStrings(
      [
        ...pattern1ManualImprovementPoints,
        ...pattern2ManualImprovementPoints,
        ...pattern3ManualImprovementPoints,
        ...(evaluationScope.pattern2Only ? [] : responseBody.improvementPoints)
      ],
      5
    );

    if (responseBody.improvementPoints.length === 0) {
      if (evaluationScope.pattern2Only) {
        responseBody.improvementPoints = [];
      } else {
        responseBody.improvementPoints = buildFallbackImprovementPoints(
          transcripts,
          evaluationScope
        );
      }
    }

    if (
      evaluationScope.pattern2Only &&
      responseBody.improvementPoints.length === 0 &&
      responseBody.conversationIssues.length === 0
    ) {
      if (responseBody.categories.communication.score !== null) {
        responseBody.categories.communication = {
          ...responseBody.categories.communication,
          score: 5,
          label: scoreToEvaluationLabel(5),
          summary:
            "企業の質問や意図を学生へ安定して中継できており、伝わり方も良好です。"
        };
      }
      if (responseBody.categories.knowledge.score !== null) {
        responseBody.categories.knowledge = {
          ...responseBody.categories.knowledge,
          score: 5,
          label: scoreToEvaluationLabel(5),
          summary:
            "無料紹介の理由を正確に説明できており、事業紹介として十分な内容です。"
        };
      }
      const finalPattern2Scores = (Object.keys(
        responseBody.categories
      ) as EvaluationCategoryKey[])
        .map((key) => responseBody.categories[key].score)
        .filter((value): value is number => value !== null);
      responseBody.overallScore = finalPattern2Scores.length
        ? Math.round(
            (finalPattern2Scores.reduce((sum, value) => sum + value, 0) /
              finalPattern2Scores.length) *
              10
          ) / 10
        : null;
      responseBody.overallLabel = scoreToEvaluationLabel(responseBody.overallScore);
      responseBody.overallComment =
        "営業が主導権を維持し、自己紹介、補足、企業説明依頼、質問中継、学生確認、退出まで安定して進行できていました。今回の練習で重視したいポイントはしっかり押さえられています。";
    }

    res.json(responseBody);
  } catch (error) {
    console.error("[EvaluationAPI] error:", error);
    res.status(500).json({ message: "面接評価の生成中にエラーが発生しました。" });
  }
});

wss.on("connection", (clientSocket) => {
  console.log("[Client] WebSocket connected");
  let sessionReady: Record<AiKey, boolean> = {
    ai_a: false,
    ai_b: false
  };
  let transcriptionSessionReady = false;
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
  let interviewIndustry: InterviewIndustry = "construction";
  let pattern3Decision: Pattern3Decision = "pending_review";
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
  let pendingTranscriptionRefresh = false;
  let waitingForSessionRefresh = false;
  let sessionRefreshWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let interruptPending = false;
  let pendingInterruptTarget: AiKey | null = null;
  let pendingInterruptPrompt: string | null = null;
  let interruptCooldownUntil = 0;
  let waitingForHuman = false;
  let manualAdvanceReady = false;
  const clearSessionRefreshWatchdog = () => {
    if (!sessionRefreshWatchdogTimer) return;
    clearTimeout(sessionRefreshWatchdogTimer);
    sessionRefreshWatchdogTimer = null;
  };
  const scheduleSessionRefreshWatchdog = (reason: "start" | "refresh") => {
    clearSessionRefreshWatchdog();
    sessionRefreshWatchdogTimer = setTimeout(() => {
      if (!waitingForSessionRefresh) return;
      console.warn(
        `[SessionRefreshWatchdog] forcing ready after timeout reason=${reason} pending=${JSON.stringify(
          pendingSessionRefresh
        )} transcriptionPending=${pendingTranscriptionRefresh}`
      );
      pendingSessionRefresh = {
        ai_a: false,
        ai_b: false
      };
      pendingTranscriptionRefresh = false;
      maybeStartPendingSession();
    }, 2500);
  };
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
  type CandidateRelayMessage = {
    mode: CandidateResponseMode;
    normalizedPrompt: string;
    instructions: string[];
    text: string;
  };
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
  type Pattern3Section =
    | "opening"
    | "result_followup"
    | "visa"
    | "contract"
    | "documents"
    | "timeline"
    | "deadline"
    | "closing";
  type Pattern3TurnIntent =
    | "opening_impression"
    | "result_followup"
    | "visa_permission"
    | "visa_explanation"
    | "contract_permission"
    | "contract_explanation"
    | "documents_permission"
    | "documents_explanation"
    | "timeline_permission"
    | "timeline_explanation"
    | "deadline_request"
    | "closing"
    | "other";
  let introPhase: IntroPhase = "complete";
  let pattern3Section: Pattern3Section = "opening";
  let companyGreetingPromptPending = false;
  let companyIntroAckPromptPending = false;
  let studentIntroApprovalPromptPending = false;
  let companyCandidateAckPromptPending = false;
  let companyOverviewPromptPending = false;
  let pendingPattern3StudentExit = false;
  let pendingPattern2StudentExit = false;
  let pendingPattern3ExitApprovalReply = false;
  let pendingPattern2ClosureExpected = false;
  let pendingPattern3AnsweredQuestionId: string | null = null;
  let pendingPattern3IssuedQuestionId: string | null = null;
  let pattern3FinalQuestionLoopActive = false;
  let pattern3ExplicitMandatoryQuestionIds: Record<string, true> = {};
  let pattern3ExplicitExtraQuestionIds: Record<string, true> = {};
  let pattern2StartTimingAsked = false;
  let pattern2VisaHandoffAsked = false;
  let pendingCandidateRetry = false;
  let pendingCandidateResponseMode: CandidateResponseMode | null = null;
  let studentIntroPromptPending = false;
  const endMarkers = ["【面接終了】", "【面接中止】"];
  let lastPhaseNotified: Phase | null = null;
  let completedPracticePhases: Record<Phase, boolean> = {
    pattern1: false,
    pattern2: false,
    pattern3: false
  };
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
  let pattern2SelectedQuestions: InterviewQuestionSpec[] = [];
  let pattern3SelectedQuestions: InterviewQuestionSpec[] = [];
  let askedInterviewerQuestionIds: Record<string, boolean> = {};
  let pendingSalesReplyQuestionId: string | null = null;
  let lastSelectedCandidateQuestionId: string | null = null;
  let pendingCandidateCompanyQuestionRelay = false;
  let candidateCompanyQuestionLoopActive = false;
  type CandidateCompanyQuestionKey = "foreign_senior" | "pre_join_study";
  let askedCandidateCompanyQuestionKeys: Record<CandidateCompanyQuestionKey, boolean> = {
    foreign_senior: false,
    pre_join_study: false
  };
  let lastPattern2QuestionOrigin: "selected" | "base" | null = null;
  let conversationHistory: ConversationHistoryEntry[] = [];
  let bufferedCandidateTurn: CandidateBufferedTurn | null = null;
  let activeBufferedCandidateTurnId: number | null = null;
  let bufferedCandidateAudioDoneFallbackTimer: ReturnType<typeof setTimeout> | null =
    null;
  let bufferedCandidatePlaybackDoneFallbackTimer: ReturnType<
    typeof setTimeout
  > | null = null;
  let lastCandidateRelayContext:
    | {
        salesText: string;
        normalizedPrompt: string;
        mode: CandidateResponseMode;
        instructions: string[];
        selectedQuestionId: string | null;
      }
    | null = null;
  let candidateValidationRetriedForCurrentPrompt = false;
  let followUpTopicUsage: Record<string, true> = {};
  const MAX_HISTORY_ENTRIES = 12;
  const BUFFERED_CANDIDATE_AUDIO_DONE_FALLBACK_MS = 1400;
  const getBufferedCandidatePlaybackFallbackMs = (text: string) =>
    Math.max(1200, Math.min(5000, text.length * 140));
  const clearBufferedCandidateAudioDoneFallback = () => {
    if (bufferedCandidateAudioDoneFallbackTimer) {
      clearTimeout(bufferedCandidateAudioDoneFallbackTimer);
      bufferedCandidateAudioDoneFallbackTimer = null;
    }
  };
  const clearBufferedCandidatePlaybackDoneFallback = () => {
    if (bufferedCandidatePlaybackDoneFallbackTimer) {
      clearTimeout(bufferedCandidatePlaybackDoneFallbackTimer);
      bufferedCandidatePlaybackDoneFallbackTimer = null;
    }
  };
  const clearBufferedCandidateTurnFallbacks = () => {
    clearBufferedCandidateAudioDoneFallback();
    clearBufferedCandidatePlaybackDoneFallback();
  };
  const coverageLabels: Record<CoverageKey, string> = {
    experience: "経験・業務",
    motivation: "動機・理由",
    language: "日本語力",
    shift: "シフト・夜勤",
    stamina: "体力・健康",
    visa: "在留/開始時期"
  };
  const containsNormalizedKeyword = (text: string, keyword: string) =>
    text.includes(keyword.replace(/\s+/g, ""));
  const containsAnyNormalizedKeywords = (text: string, keywords: string[]) =>
    keywords.some((keyword) => keyword && containsNormalizedKeyword(text, keyword));
  const updateCoverage = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return;
    const scenario = getIndustryScenario(interviewIndustry);
    const scenarioExperienceKeywords = [
      ...scenario.introKeywords,
      ...scenario.experienceKeywords
    ];
    if (
      !coverage.experience &&
      (/経験|前職|業務|仕事|働い|勤務/.test(normalized) ||
        containsAnyNormalizedKeywords(normalized, scenarioExperienceKeywords))
    ) {
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
  const getPreferredTranscriptionModel = () =>
    phase === "pattern3"
      ? OPENAI_LONGFORM_TRANSCRIPTION_MODEL
      : OPENAI_TRANSCRIPTION_MODEL;
  const buildTranscriptionGlossary = () => {
    const scenario = getCurrentIndustryScenario();
    const candidateName =
      confirmedCandidateName ??
      expectedCandidateName ??
      scenario.candidateProfile.name;
    const phaseTerms =
      phase === "pattern3"
        ? [
            "技人国",
            "在留資格変更許可申請",
            "内定通知書",
            "労働条件通知書",
            "必要書類",
            "履歴事項全部証明書",
            "法定調書",
            "決算報告書",
            "雇用保険",
            "雛形",
            "許可率",
            "採用理由書"
          ]
        : phase === "pattern2"
          ? [
              "自己紹介",
              "面接",
              "採用担当",
              "勤務開始",
              "夜勤",
              "シフト",
              "体力"
            ]
          : ["事前練習", "面接前練習", "返事", "自己紹介"];
    const terms = [
      "ヒトキワ",
      "株式会社ヒトキワ",
      "中島",
      "田中",
      candidateName,
      scenario.label,
      scenario.candidateProfile.targetRole,
      ...scenario.introKeywords,
      ...scenario.experienceKeywords,
      ...phaseTerms
    ];
    return [...new Set(terms.map((term) => term.trim()).filter(Boolean))].slice(
      0,
      28
    );
  };
  const buildTranscriptionPrompt = () => {
    const scenario = getCurrentIndustryScenario();
    const phaseSummary =
      phase === "pattern3"
        ? "This section often contains longer explanations about visa changes, required documents, approval timing, labor conditions, and templates."
        : phase === "pattern2"
          ? "This section is a live job interview with a sales representative, candidate, and interviewer."
          : "This section is pre-interview practice with drills and short fixed answers.";
    const glossary = buildTranscriptionGlossary().join("、");
    return [
      "Transcribe the sales representative's spoken Japanese faithfully as Japanese text.",
      "Do not summarize, paraphrase, translate, or clean up into subtitles.",
      "Do not invent unrelated closing phrases such as 「ご視聴ありがとうございました」, 「チャンネル登録」, or similar broadcast text.",
      "Keep company names, visa/document terms, and candidate names as accurately as possible.",
      `Industry context: ${scenario.label}.`,
      phaseSummary,
      `Prefer these terms when they match the audio: ${glossary}.`
    ].join(" ");
  };
  const buildTranscriptionSessionUpdate = (): RealtimeSessionUpdate => ({
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: 24000
          },
          noise_reduction: {
            type: "near_field"
          },
          transcription: {
            model: getPreferredTranscriptionModel(),
            language: "ja",
            prompt: buildTranscriptionPrompt()
          },
          turn_detection: null
        }
      },
      include: ["item.input_audio_transcription.logprobs"]
    }
  });
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
    key === "ai_b" &&
    SALES_LED_FLOW &&
    phase !== "pattern3" &&
    (candidateCompanyQuestionLoopActive ||
      ENABLE_CANDIDATE_RESPONSE_VALIDATION ||
      Boolean(
        getSelectedCandidateQuestionProfile(
          getSelectedCandidateQuestionIdForValidation()
        )
      ));
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
  const buildTranscriptNormalizationEntries = (): Array<{
    pattern: RegExp;
    replacement: string;
  }> => {
    const scenario = getCurrentIndustryScenario();
    const candidateName = getCurrentCandidateName() ?? scenario.candidateProfile.name;
    const entries: Array<{ pattern: RegExp; replacement: string }> = [
      { pattern: /株式会社\s*(?:ひときわ|ヒトキワ)/gu, replacement: "株式会社ヒトキワ" },
      { pattern: /ひときわ/gu, replacement: "ヒトキワ" },
      { pattern: /ぎじんこく|ギジンコク|議事国/gu, replacement: "技人国" },
      { pattern: /とくていぎのう|トクテイギノウ/gu, replacement: "特定技能" },
      { pattern: /じぜんれんしゅう|事前れんしゅう/gu, replacement: "事前練習" },
      { pattern: /めんせつまえれんしゅう|面接前れんしゅう/gu, replacement: "面接前練習" },
      { pattern: /りあくしょん/gu, replacement: "リアクション" },
      { pattern: /じこしょうかい/gu, replacement: "自己紹介" },
      { pattern: /さいようりゆうしょ/gu, replacement: "採用理由書" },
      { pattern: /ないていつうちしょ/gu, replacement: "内定通知書" },
      { pattern: /ろうどうじょうけんつうちしょ/gu, replacement: "労働条件通知書" },
      { pattern: /こようけいやくしょ/gu, replacement: "雇用契約書" },
      { pattern: /ぎょうせいしょし/gu, replacement: "行政書士" },
      { pattern: /なかじま|中嶋/gu, replacement: "中島" },
      { pattern: /たなか/gu, replacement: "田中" },
      { pattern: /ぐーなび|グーナビ/gu, replacement: "グーナビ" }
    ];

    if (scenario.id === "construction") {
      entries.push(
        { pattern: /けんちく/gu, replacement: "建築" },
        { pattern: /げんば/gu, replacement: "現場" },
        { pattern: /しざい(?:うんぱん|はこび)/gu, replacement: "資材運搬" },
        { pattern: /こうぐ/gu, replacement: "工具" }
      );
    }

    if (candidateName) {
      const escapedName = escapeRegex(candidateName);
      entries.unshift(
        {
          pattern: new RegExp(`${escapedName}(?:ソン|そん)`, "gu"),
          replacement: candidateName
        },
        {
          pattern: new RegExp(`${escapedName}\\s*さん`, "gu"),
          replacement: `${candidateName}さん`
        }
      );
      if (candidateName === "ジョン") {
        entries.unshift(
          { pattern: /ジョンソン|ジョーン|ジョオン/gu, replacement: "ジョン" }
        );
      }
    }

    return entries;
  };
  const normalizeKnownTranscriptTerms = (text: string) =>
    buildTranscriptNormalizationEntries().reduce(
      (normalized, entry) => normalized.replace(entry.pattern, entry.replacement),
      text
    );
  const detectInterviewIntent = (text: string): InterviewIntent => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return "other";
    const scenario = getIndustryScenario(interviewIndustry);
    const scenarioExperienceKeywords = [
      ...scenario.introKeywords,
      ...scenario.experienceKeywords
    ];
    if (!/[?？]|教えて|聞かせて|伺|確認|できますか|いかが|でしょうか/.test(normalized)) {
      return "other";
    }
    if (
      /経験|前職|業務|担当|どんな仕事|何をして|どのような仕事/.test(normalized) ||
      containsAnyNormalizedKeywords(normalized, scenarioExperienceKeywords)
    ) {
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
    const selectedQuestionResult = classifyCandidateAnswerBySelectedQuestion(
      getSelectedCandidateQuestionIdForValidation(),
      text
    );
    if (
      selectedQuestionResult.assessment &&
      selectedQuestionResult.confidence !== "low"
    ) {
      return selectedQuestionResult;
    }
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
    const selectedQuestionResult = classifyCandidateAnswerBySelectedQuestion(
      getSelectedCandidateQuestionIdForValidation(),
      answerText
    );
    if (
      selectedQuestionResult.assessment &&
      selectedQuestionResult.confidence !== "low"
    ) {
      return selectedQuestionResult.assessment;
    }
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
  const initializeSelectedInterviewerQuestions = () => {
    const selection = buildSelectedInterviewerQuestionPlan(
      interviewerSettings.difficulty,
      interviewIndustry
    );
    pattern2SelectedQuestions = selection.pattern2;
    pattern3SelectedQuestions = selection.pattern3;
    askedInterviewerQuestionIds = {};
    pendingSalesReplyQuestionId = null;
    lastSelectedCandidateQuestionId = null;
    candidateCompanyQuestionLoopActive = false;
    askedCandidateCompanyQuestionKeys = {
      foreign_senior: false,
      pre_join_study: false
    };
    lastPattern2QuestionOrigin = null;
  };
  const hasAskedInterviewerQuestion = (questionId: string) =>
    Boolean(askedInterviewerQuestionIds[questionId]);
  const hasStartedBasePattern2QuestionFlow = () =>
    lastInterviewerIntent !== null ||
    coverage.experience ||
    coverage.motivation ||
    coverage.language ||
    coverage.shift ||
    coverage.stamina;
  const isStrictSelectedQuestionMode = () =>
    phase === "pattern2" || phase === "pattern3";
  const hasCompletedCorePattern2Coverage = () =>
    coverage.experience &&
    coverage.motivation &&
    coverage.language &&
    coverage.shift &&
    coverage.stamina;
  const getPhaseSelectedInterviewerQuestions = (currentPhase: Phase) =>
    currentPhase === "pattern2"
      ? pattern2SelectedQuestions
      : currentPhase === "pattern3"
        ? pattern3SelectedQuestions
        : [];
  const getSelectedInterviewerQuestionById = (questionId: string | null) => {
    if (!questionId) return null;
    return [...pattern2SelectedQuestions, ...pattern3SelectedQuestions].find(
      (question) => question.id === questionId
    ) ?? null;
  };
  type SelectedCandidateQuestionProfile = {
    focusSummary: string;
    cueLines: string[];
    fallbackAnswer: string;
    fitPatterns?: RegExp[];
    minLength?: number;
    acceptShort?: boolean;
    requiresQuestion?: boolean;
  };
  const buildSelectedQuestionProfile = (
    focusSummary: string,
    cueLines: string[],
    fallbackAnswer: string,
    options?: {
      fitPatterns?: RegExp[];
      minLength?: number;
      acceptShort?: boolean;
      requiresQuestion?: boolean;
    }
  ): SelectedCandidateQuestionProfile => ({
    focusSummary,
    cueLines,
    fallbackAnswer,
    fitPatterns: options?.fitPatterns ?? [],
    minLength: options?.minLength ?? 12,
    acceptShort: options?.acceptShort ?? false,
    requiresQuestion: options?.requiresQuestion ?? false
  });
  const BASIC_SELECTED_QUESTION_PROFILE_OVERRIDES: Partial<
    Record<string, Partial<SelectedCandidateQuestionProfile>>
  > = {
    mandatory_start_timing: {
      cueLines: ["今は、いつから働けるかだけ短く答える。例: 「来月から、働けます」"],
      fallbackAnswer: "来月から、働けます。",
      minLength: 8,
      acceptShort: true
    },
    common_japan_duration: {
      cueLines: ["今は、日本で長く働きたい気持ちだけ短く言う。"],
      fallbackAnswer: "日本で、長く働きたいです。",
      minLength: 8,
      acceptShort: true
    },
    common_hard_work: {
      cueLines: ["今は「大丈夫です」「頑張ります」に近い意味で短く答える。"],
      fallbackAnswer: "大丈夫です。頑張ります。",
      minLength: 6,
      acceptShort: true
    },
    common_why_company: {
      cueLines: ["会社や仕事に興味がある理由を、短く1つだけ言う。"],
      fallbackAnswer: "この会社の仕事、興味あります。",
      minLength: 8,
      acceptShort: true
    },
    common_work_values: {
      cueLines: ["真面目、時間守る、協力する、のような短い言い方でよい。"],
      fallbackAnswer: "時間守ること。協力すること、大切です。",
      minLength: 8,
      acceptShort: true
    },
    common_challenge_overcome: {
      cueLines: ["大変だったこと1つと、どう乗り越えたかを短く2つに分けて言う。"],
      fallbackAnswer: "日本語、大変でした。でも毎日、勉強しました。",
      minLength: 10,
      acceptShort: true
    },
    common_busy_time: {
      cueLines: ["忙しい時は、落ち着く・協力する、を短く言う。"],
      fallbackAnswer: "忙しい時、落ち着きます。まわりと協力します。",
      minLength: 8,
      acceptShort: true
    },
    common_teamwork: {
      cueLines: ["あいさつ、報告、相談、協力、のような短い言い方でよい。"],
      fallbackAnswer: "あいさつ。報告。協力、大切です。",
      minLength: 8,
      acceptShort: true
    },
    common_strengths_weaknesses: {
      cueLines: ["長所1つ、短所1つを、短い文で言う。"],
      fallbackAnswer: "長所、まじめです。短所、経験まだ少ないです。",
      minLength: 10,
      acceptShort: true
    },
    common_when_unsure: {
      cueLines: ["分からない時は、すぐ先輩や上司に聞く、と短く言う。"],
      fallbackAnswer: "わからない時、すぐ先輩に聞きます。",
      minLength: 8,
      acceptShort: true
    },
    common_biggest_effort: {
      cueLines: ["一番頑張ったことを1つだけ短く言う。"],
      fallbackAnswer: "前の仕事、毎日頑張りました。",
      minLength: 8,
      acceptShort: true
    },
    common_hardest_experience: {
      cueLines: ["つらかったことを1つ言い、短く乗り越えた一言を足してよい。"],
      fallbackAnswer: "日本語、難しかったです。でも少し慣れました。",
      minLength: 10,
      acceptShort: true
    },
    common_future_dream: {
      cueLines: ["将来どうなりたいかを短く言う。"],
      fallbackAnswer: "将来、日本で長く働きたいです。",
      minLength: 8,
      acceptShort: true
    },
    common_weekend_holiday: {
      cueLines: ["土日や祝日に働けるか、短く答える。"],
      fallbackAnswer: "はい、土日も大丈夫です。",
      minLength: 6,
      acceptShort: true
    },
    common_early_or_night: {
      cueLines: ["朝早い仕事や夜勤が大丈夫か、短く答える。"],
      fallbackAnswer: "はい、朝早い仕事、夜も大丈夫です。",
      minLength: 8,
      acceptShort: true
    },
    common_relocation: {
      cueLines: ["引っ越しできるか、短く答える。"],
      fallbackAnswer: "はい、引っ越しも大丈夫です。",
      minLength: 6,
      acceptShort: true
    },
    common_last_question: {
      cueLines: ["最後は会社への質問を1つだけ言う。短く、やさしい質問にする。"],
      minLength: 8,
      acceptShort: true
    },
    food_customer_service_experience: {
      cueLines: ["接客経験があるか、短く答える。"],
      fallbackAnswer: "はい、接客、少しあります。",
      minLength: 6,
      acceptShort: true
    },
    food_standing_work: {
      cueLines: ["立ち仕事が大丈夫か、短く答える。"],
      fallbackAnswer: "はい、立ち仕事、大丈夫です。",
      minLength: 6,
      acceptShort: true
    },
    food_struggle_in_japan: {
      cueLines: ["日本で苦労したことを1つだけ短く言う。"],
      fallbackAnswer: "日本語、少し大変でした。",
      minLength: 8,
      acceptShort: true
    },
    food_mistake_response: {
      cueLines: ["ミスした時は、すぐ報告すると短く言う。"],
      fallbackAnswer: "すぐ報告します。確認します。",
      minLength: 8,
      acceptShort: true
    },
    lodging_failure_response: {
      cueLines: ["失敗した時は、すぐ報告すると短く言う。"],
      fallbackAnswer: "すぐ報告します。確認します。",
      minLength: 8,
      acceptShort: true
    },
    manufacturing_why_this_work: {
      cueLines: ["製造の仕事を選んだ理由を短く言う。"],
      fallbackAnswer: "もの作る仕事、好きです。",
      minLength: 8,
      acceptShort: true
    },
    manufacturing_physical_work: {
      cueLines: ["体を使う仕事が大丈夫か、短く答える。"],
      fallbackAnswer: "体使う仕事、大丈夫です。",
      minLength: 6,
      acceptShort: true
    },
    manufacturing_how_long_continue: {
      cueLines: ["この仕事を長く続けたい気持ちを短く言う。"],
      fallbackAnswer: "日本で長く続けたいです。",
      minLength: 8,
      acceptShort: true
    },
    manufacturing_dirty_work: {
      cueLines: ["汚れる仕事が大丈夫か、短く答える。"],
      fallbackAnswer: "はい、汚れる仕事も大丈夫です。",
      minLength: 6,
      acceptShort: true
    },
    construction_business_trip: {
      cueLines: ["出張が大丈夫か、短く答える。"],
      fallbackAnswer: "はい、出張も大丈夫です。",
      minLength: 6,
      acceptShort: true
    },
    construction_weather: {
      cueLines: ["暑い時、寒い時も大丈夫か、短く答える。"],
      fallbackAnswer: "暑い時、寒い時も大丈夫です。",
      minLength: 8,
      acceptShort: true
    },
    construction_heavy_items: {
      cueLines: ["重いものが大丈夫か、短く答える。"],
      fallbackAnswer: "はい、重いものも大丈夫です。",
      minLength: 6,
      acceptShort: true
    },
    construction_early_gathering: {
      cueLines: ["朝早い集合が平気か、短く答える。"],
      fallbackAnswer: "はい、朝早いのも大丈夫です。",
      minLength: 6,
      acceptShort: true
    },
    construction_driver_license: {
      cueLines: ["免許の有無だけ短く答える。"],
      fallbackAnswer: "はい、免許あります。",
      minLength: 5,
      acceptShort: true
    },
    lodging_why_japan: {
      cueLines: ["日本で働きたい理由を短く言う。"],
      fallbackAnswer: "日本で働きたいです。経験したいです。",
      minLength: 8,
      acceptShort: true
    },
    lodging_service_struggle: {
      cueLines: ["接客で大変だったことを1つだけ短く言う。"],
      fallbackAnswer: "日本語で説明、少し難しかったです。",
      minLength: 8,
      acceptShort: true
    },
    lodging_customer_mix: {
      cueLines: ["日本のお客様も外国人のお客様も対応できるか、短く答える。"],
      fallbackAnswer: "はい、どちらも対応できます。",
      minLength: 6,
      acceptShort: true
    }
  };
  const applyCandidateLevelToSelectedQuestionProfile = (
    questionId: string | null,
    profile: SelectedCandidateQuestionProfile | null
  ) => {
    if (!profile || candidateLanguageLevel !== "basic") {
      return profile;
    }
    const override = questionId
      ? BASIC_SELECTED_QUESTION_PROFILE_OVERRIDES[questionId] ?? null
      : null;
    return {
      ...profile,
      ...override,
      cueLines: override?.cueLines ?? [
        "初級なので、1文か短い2フレーズまで。助詞が抜けてもよい。流暢に言いすぎない。",
        ...profile.cueLines
      ],
      fallbackAnswer: override?.fallbackAnswer ?? profile.fallbackAnswer,
      fitPatterns: override?.fitPatterns ?? profile.fitPatterns,
      minLength: override?.minLength ?? Math.min(profile.minLength ?? 12, 8),
      acceptShort: override?.acceptShort ?? true,
      requiresQuestion: override?.requiresQuestion ?? profile.requiresQuestion
    };
  };
  const getSelectedCandidateQuestionSpec = (questionId: string | null) => {
    const question = getSelectedInterviewerQuestionById(questionId);
    return question && question.target === "candidate" ? question : null;
  };
  const getSelectedCandidateQuestionIdForPrompting = () => {
    const currentSelectedQuestionId =
      lastSelectedCandidateQuestionId ?? lastCandidateRelayContext?.selectedQuestionId;
    if (
      currentSelectedQuestionId === "common_last_question" &&
      !candidateCompanyQuestionLoopActive &&
      !pendingCandidateCompanyQuestionRelay
    ) {
      return null;
    }
    return currentSelectedQuestionId ?? (candidateCompanyQuestionLoopActive ? "common_last_question" : null);
  };
  const getSelectedCandidateQuestionIdForValidation = () =>
    lastCandidateRelayContext?.selectedQuestionId ??
    lastSelectedCandidateQuestionId ??
    (candidateCompanyQuestionLoopActive ? "common_last_question" : null);
  const getSelectedCandidateQuestionProfileBase = (
    questionId: string | null
  ): SelectedCandidateQuestionProfile | null => {
    switch (questionId) {
      case "mandatory_start_timing":
        return buildSelectedQuestionProfile(
          "いつから働けるか、開始時期を短く答える。",
          ["今はいつから働けるかだけを短く答える。例: 「来月から働けます」"],
          "来月から働けます。",
          {
            fitPatterns: [/すぐ|来週|来月|再来月|いつでも|働け|開始|入社/u],
            acceptShort: true
          }
        );
      case "common_japan_duration":
        return buildSelectedQuestionProfile(
          "日本でどのくらい働きたいか、長く働きたい気持ちを短く答える。",
          ["「日本で長く働きたいです」に近い意味で短く答える。"],
          "日本で長く働きたいです。",
          {
            fitPatterns: [/長く|ずっと|日本で.*働きたい|続けたい|頑張りたい/u]
          }
        );
      case "common_hard_work":
        return buildSelectedQuestionProfile(
          "仕事が大変でも大丈夫か、頑張れるかを短く答える。",
          ["「大丈夫です」「頑張れます」に近い意味で短く答える。"],
          "大丈夫です。頑張れます。",
          {
            fitPatterns: [/大丈夫|頑張|平気|問題ない|できます/u],
            acceptShort: true
          }
        );
      case "common_why_company":
        return buildSelectedQuestionProfile(
          "なぜこの会社で働きたいか、その理由を短く答える。",
          ["会社の仕事内容、雰囲気、学べることなど、理由を1つ短く言う。"],
          "仕事内容に興味があって、この会社で頑張りたいと思いました。",
          {
            fitPatterns: [/仕事内容|会社|雰囲気|学びたい|成長|魅力|興味|頑張りたい/u]
          }
        );
      case "common_work_values":
        return buildSelectedQuestionProfile(
          "仕事で大切にしたいことを短く答える。",
          ["真面目さ、協力、時間を守ること、報告相談などを短く言う。"],
          "真面目に働くことと、まわりの人と協力することを大切にしたいです。",
          {
            fitPatterns: [/真面目|協力|時間|約束|責任|安全|丁寧|報告|相談/u]
          }
        );
      case "common_challenge_overcome":
        return buildSelectedQuestionProfile(
          "大変だったこと1つと、それをどう乗り越えたかを短く答える。",
          ["「大変だったこと」+「どう乗り越えたか」を2つに分けて短く答える。"],
          "日本語が大変でした。でも毎日少しずつ勉強して乗り越えました。",
          {
            fitPatterns: [/大変|難し|日本語|慣れ|勉強|相談|乗り越え|頑張/u],
            minLength: 16
          }
        );
      case "common_busy_time":
        return buildSelectedQuestionProfile(
          "忙しいときにどう動くかを短く答える。",
          ["落ち着く、優先順位を考える、周りと協力する、を短く言う。"],
          "忙しいときは落ち着いて、優先順位を考えて動きます。",
          {
            fitPatterns: [/落ち着|優先|順番|協力|報告|相談|確認|急い/u]
          }
        );
      case "common_teamwork":
        return buildSelectedQuestionProfile(
          "チームで働くときに大切なことを短く答える。",
          ["協力、報告、相談、コミュニケーションを大切にすることを言う。"],
          "報告と相談をしっかりして、みんなで協力することが大切だと思います。",
          {
            fitPatterns: [/協力|報告|相談|連絡|助け合|コミュニケーション|チーム/u]
          }
        );
      case "common_strengths_weaknesses":
        return buildSelectedQuestionProfile(
          "良いところ1つと、苦手なところ1つを短く答える。",
          ["長所と短所の両方を入れる。例: 「長所は真面目です。短所は経験が少ないことです」"],
          "長所は真面目なところです。短所はまだ経験が少ないところです。",
          {
            fitPatterns: [/長所|短所|真面目|明るい|責任感|苦手|経験が少ない|緊張|心配/u],
            minLength: 18
          }
        );
      case "common_when_unsure":
        return buildSelectedQuestionProfile(
          "分からないことがあったとき、どうするかを短く答える。",
          ["そのままにしないで、先輩や上司に聞くことを短く言う。"],
          "分からないことがあったら、そのままにしないで先輩に聞きます。",
          {
            fitPatterns: [/聞き|確認|先輩|上司|質問|相談/u]
          }
        );
      case "common_biggest_effort":
        return buildSelectedQuestionProfile(
          "今までで一番頑張ったことを1つ短く答える。",
          ["仕事や学校で一番力を入れたことを1つだけ言う。"],
          "前の仕事で毎日真面目に続けたことが一番頑張ったことです。",
          {
            fitPatterns: [/一番|頑張|力を入れ|毎日|続け|努力/u]
          }
        );
      case "common_hardest_experience":
        return buildSelectedQuestionProfile(
          "今までで一番つらかったことを短く答える。",
          ["つらかったことを1つ言い、その後に少し前向きな一言を添えてよい。"],
          "日本語が難しかったことが一番つらかったです。でも少しずつ慣れました。",
          {
            fitPatterns: [/つら|大変|難し|日本語|忙し|慣れ|頑張/u]
          }
        );
      case "common_future_dream":
        return buildSelectedQuestionProfile(
          "将来どうなりたいか、夢を短く答える。",
          ["日本で長く働きたい、成長したい、信頼されたい、などを短く言う。"],
          "将来は日本で長く働いて、信頼される人になりたいです。",
          {
            fitPatterns: [/将来|夢|なりたい|働きたい|成長|リーダー|信頼/u]
          }
        );
      case "common_weekend_holiday":
        return buildSelectedQuestionProfile(
          "土日や祝日に働けるかを短く答える。",
          ["土日や祝日の勤務ができるかを短く答える。"],
          "はい、土日や祝日も働けます。",
          {
            fitPatterns: [/土日|祝日|大丈夫|働け|可能/u],
            acceptShort: true
          }
        );
      case "common_early_or_night":
        return buildSelectedQuestionProfile(
          "朝早い仕事や夜勤ができるかを短く答える。",
          ["朝早い勤務や夜勤が大丈夫かを短く答える。"],
          "はい、朝早い仕事や夜勤も大丈夫です。",
          {
            fitPatterns: [/朝|夜勤|夜|早い|大丈夫|可能|働け/u],
            acceptShort: true
          }
        );
      case "common_relocation":
        return buildSelectedQuestionProfile(
          "引っ越しができるかを短く答える。",
          ["必要なら引っ越しできるかを短く答える。"],
          "はい、必要なら引っ越しもできます。",
          {
            fitPatterns: [/引っ越|大丈夫|できます|可能/u],
            acceptShort: true
          }
        );
      case "common_last_question":
        const remainingCompanyQuestions = getRemainingCandidateCompanyQuestionOptions();
        if (remainingCompanyQuestions.length === 0) {
          return buildSelectedQuestionProfile(
            "会社への質問はもうないと短く答える。",
            [
              "もう会社への質問はないと短く答える。",
              "「もうないです。」か「大丈夫です。」のように短く言う。"
            ],
            "もうないです。",
            {
              fitPatterns: [/もうない|ありません|大丈夫です|ないです/u],
              acceptShort: true
            }
          );
        }
        return buildSelectedQuestionProfile(
          `会社への質問は「${remainingCompanyQuestions.map((option) => option.text).join("」か「")}」の中から1つだけ言う。`,
          [
            "最後は会社への質問を1つだけ言う。",
            `使ってよい質問は「${remainingCompanyQuestions.map((option) => option.text).join("」か「")}」だけ。言い換えずにそのまま言う。`,
            "給料・引っ越し・ビザは避ける。"
          ],
          remainingCompanyQuestions[0]?.text ?? "外国人の先輩はいますか？",
          {
            fitPatterns: remainingCompanyQuestions
              .map((option) =>
                option.key === "foreign_senior"
                  ? /外国人.*先輩.*います/u
                  : /入社前.*勉強.*あります/u
              ),
            acceptShort: true,
            requiresQuestion: true
          }
        );
      case "food_customer_service_experience":
        return buildSelectedQuestionProfile(
          "接客経験があるか、どんな接客かを短く答える。",
          ["接客経験がある場合は「少しあります」と短く答えてよい。"],
          "はい、接客の経験は少しあります。",
          {
            fitPatterns: [/接客|ホール|お客様|案内|注文/u],
            acceptShort: true
          }
        );
      case "food_standing_work":
        return buildSelectedQuestionProfile(
          "立ち仕事が大丈夫かを短く答える。",
          ["立ち仕事が大丈夫かを短く答える。"],
          "はい、立ち仕事も大丈夫です。",
          {
            fitPatterns: [/立ち仕事|大丈夫|問題ない|平気/u],
            acceptShort: true
          }
        );
      case "food_struggle_in_japan":
        return buildSelectedQuestionProfile(
          "日本に来て苦労したことを短く答える。",
          ["日本語や生活で大変だったことを1つ短く言う。"],
          "日本語が難しかったです。でも少しずつ慣れました。",
          {
            fitPatterns: [/日本語|生活|大変|苦労|慣れ|勉強/u]
          }
        );
      case "food_mistake_response":
      case "lodging_failure_response":
        return buildSelectedQuestionProfile(
          "ミスや失敗をしたとき、どう対応するかを短く答える。",
          ["すぐ報告する、確認する、同じミスをしないように気をつける、を短く言う。"],
          "すぐに報告して、同じミスをしないように気をつけます。",
          {
            fitPatterns: [/報告|相談|確認|気をつけ|同じミス|失敗/u]
          }
        );
      case "manufacturing_why_this_work":
        return buildSelectedQuestionProfile(
          "なぜ製造の仕事を選んだか、その理由を短く答える。",
          ["ものづくりや工場の仕事に興味がある理由を短く言う。"],
          "ものを作る仕事に興味があって、やってみたいと思いました。",
          {
            fitPatterns: [/製造|ものづくり|工場|作る|興味/u]
          }
        );
      case "manufacturing_physical_work":
        return buildSelectedQuestionProfile(
          "体力を使う仕事が大丈夫かを短く答える。",
          ["体を使う仕事でも大丈夫かを短く答える。"],
          "体を使う仕事でも大丈夫です。頑張れます。",
          {
            fitPatterns: [/体力|体を使う|大丈夫|頑張/u],
            acceptShort: true
          }
        );
      case "manufacturing_how_long_continue":
        return buildSelectedQuestionProfile(
          "日本でこの仕事をどのくらい続けたいかを短く答える。",
          ["日本で長く続けたい気持ちを短く言う。"],
          "日本で長くこの仕事を続けたいです。",
          {
            fitPatterns: [/長く|ずっと|続けたい|日本で/u]
          }
        );
      case "manufacturing_dirty_work":
        return buildSelectedQuestionProfile(
          "汚れる仕事が大丈夫かを短く答える。",
          ["汚れる仕事が大丈夫かを短く答える。"],
          "はい、汚れる仕事も大丈夫です。",
          {
            fitPatterns: [/汚れ|大丈夫|問題ない|平気/u],
            acceptShort: true
          }
        );
      case "construction_business_trip":
        return buildSelectedQuestionProfile(
          "県外への出張が大丈夫かを短く答える。",
          ["県外への出張が大丈夫かを短く答える。"],
          "はい、県外への出張も大丈夫です。",
          {
            fitPatterns: [/出張|県外|大丈夫|行け|可能/u],
            acceptShort: true
          }
        );
      case "construction_weather":
        return buildSelectedQuestionProfile(
          "暑さ寒さのある現場仕事が大丈夫かを短く答える。",
          ["夏の暑さや冬の寒さがあっても大丈夫かを短く答える。"],
          "はい、暑い時も寒い時も頑張れます。",
          {
            fitPatterns: [/暑い|寒い|大丈夫|頑張|平気/u],
            acceptShort: true
          }
        );
      case "construction_heavy_items":
        return buildSelectedQuestionProfile(
          "重いものを持つ仕事ができるかを短く答える。",
          ["重いものを持つ仕事が大丈夫かを短く答える。"],
          "はい、重いものを持つ仕事も大丈夫です。",
          {
            fitPatterns: [/重い|持つ|大丈夫|できます/u],
            acceptShort: true
          }
        );
      case "construction_early_gathering":
        return buildSelectedQuestionProfile(
          "朝の集合が早くても平気かを短く答える。",
          ["朝が早い集合に対応できるかを短く答える。"],
          "はい、朝早い集合も平気です。",
          {
            fitPatterns: [/朝|早い|平気|大丈夫/u],
            acceptShort: true
          }
        );
      case "construction_driver_license":
        return buildSelectedQuestionProfile(
          "車の免許を持っているかを短く答える。",
          ["免許の有無を短く答える。"],
          "はい、車の免許は持っています。",
          {
            fitPatterns: [/免許|持って|あります|ありません|ない/u],
            acceptShort: true
          }
        );
      case "lodging_why_japan":
        return buildSelectedQuestionProfile(
          "なぜ日本で働きたいか、その理由を短く答える。",
          ["日本で働きたい理由を1つ短く言う。"],
          "日本で働きながら経験を積みたいと思ったからです。",
          {
            fitPatterns: [/日本で働きたい|日本|経験|勉強|生活/u]
          }
        );
      case "lodging_service_struggle":
        return buildSelectedQuestionProfile(
          "日本で接客するときに苦労したことを短く答える。",
          ["接客や日本語で大変だったことを1つ短く言う。"],
          "日本語でお客様に説明することが少し難しかったです。でも少しずつ慣れました。",
          {
            fitPatterns: [/接客|日本語|苦労|大変|慣れ|お客様/u]
          }
        );
      case "lodging_customer_mix":
        return buildSelectedQuestionProfile(
          "日本人のお客様にも外国人のお客様にも対応できるかを短く答える。",
          ["どちらのお客様にも対応できるかを短く答える。"],
          "はい、日本のお客様にも外国人のお客様にも対応できます。",
          {
            fitPatterns: [/日本のお客様|外国人のお客様|どちら|対応|大丈夫|できます/u],
            acceptShort: true
          }
        );
      default:
        return null;
    }
  };
  const getSelectedCandidateQuestionProfile = (
    questionId: string | null
  ): SelectedCandidateQuestionProfile | null =>
    applyCandidateLevelToSelectedQuestionProfile(
      questionId,
      getSelectedCandidateQuestionProfileBase(questionId)
    );
  const isCandidateAcknowledgeOnlyAnswer = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    return /^(はい|はいです|はいわかりました|はい、わかりました|わかりました|ありがとうございます|はいありがとうございます|承知しました)[。．!！]*$/u.test(
      normalized
    );
  };
  const classifyCandidateAnswerBySelectedQuestion = (
    questionId: string | null,
    text: string
  ): {
    assessment: CandidateAnswerAssessment | null;
    confidence: "high" | "medium" | "low";
  } => {
    const profile = getSelectedCandidateQuestionProfile(questionId);
    if (!profile) {
      return { assessment: null, confidence: "low" };
    }
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) {
      return { assessment: "mismatch", confidence: "high" };
    }
    if (
      hasCandidateConfusionSignal(normalized) &&
      !hasCandidateSubstantiveContent(normalized)
    ) {
      return { assessment: "mismatch", confidence: "high" };
    }
    if (isCandidateAcknowledgeOnlyAnswer(normalized)) {
      return { assessment: "mismatch", confidence: "high" };
    }
    if (
      candidateLanguageLevel === "basic" &&
      isTooFluentForBasicCandidateAnswer(text)
    ) {
      return { assessment: "mismatch", confidence: "high" };
    }
    if (profile.requiresQuestion) {
      const isQuestion = /[?？]|何|どう|ですか|ますか|でしょうか/u.test(text);
      if (!isQuestion) {
        return normalized.length >= 12
          ? { assessment: "partial", confidence: "medium" }
          : { assessment: "mismatch", confidence: "high" };
      }
      const matchedPattern = (profile.fitPatterns ?? []).some((pattern) =>
        pattern.test(normalized)
      );
      if (matchedPattern) {
        return { assessment: "fit", confidence: "high" };
      }
      if ((profile.fitPatterns ?? []).length > 0) {
        return { assessment: "mismatch", confidence: "high" };
      }
      return { assessment: "fit", confidence: "high" };
    }
    const matchedPattern = (profile.fitPatterns ?? []).some((pattern) =>
      pattern.test(normalized)
    );
    if (matchedPattern) {
      return {
        assessment:
          profile.acceptShort || normalized.length >= (profile.minLength ?? 12)
            ? "fit"
            : "partial",
        confidence: "high"
      };
    }
    if (normalized.length >= (profile.minLength ?? 12)) {
      return { assessment: "partial", confidence: "medium" };
    }
    return { assessment: "mismatch", confidence: "high" };
  };
  const getNextSelectedInterviewerQuestionByWindow = (
    window:
      | "candidate_insert"
      | "late_candidate"
      | "pattern3_result_followup"
      | "pattern3_visa"
      | "pattern3_contract"
      | "pattern3_documents"
      | "pattern3_timeline"
  ) =>
    getPhaseSelectedInterviewerQuestions(phase).find(
      (question) =>
        !hasAskedInterviewerQuestion(question.id) && question.window === window
    ) ?? null;
  const PATTERN3_SECTION_ORDER: Pattern3Section[] = [
    "opening",
    "result_followup",
    "visa",
    "contract",
    "documents",
    "timeline",
    "deadline",
    "closing"
  ];
  const getPattern3SectionRank = (section: Pattern3Section) =>
    PATTERN3_SECTION_ORDER.indexOf(section);
  const getPattern3SectionForQuestionWindow = (
    window: InterviewQuestionSpec["window"]
  ): Pattern3Section | null => {
    switch (window) {
      case "pattern3_result_followup":
        return "result_followup";
      case "pattern3_visa":
        return "visa";
      case "pattern3_contract":
        return "contract";
      case "pattern3_documents":
        return "documents";
      case "pattern3_timeline":
        return "timeline";
      default:
        return null;
    }
  };
  const getPendingPattern3SelectedQuestions = () =>
    pattern3SelectedQuestions.filter((question) => !hasAskedInterviewerQuestion(question.id));
  const isPattern3ExtraQuestion = (question: InterviewQuestionSpec) =>
    question.phase === "pattern3" && question.target === "sales" && !question.mandatory;
  const getPendingMandatoryPattern3Questions = () =>
    pattern3SelectedQuestions.filter(
      (question) => question.mandatory && !hasAskedInterviewerQuestion(question.id)
    );
  const getPendingExtraPattern3Questions = () =>
    pattern3SelectedQuestions.filter(
      (question) => isPattern3ExtraQuestion(question) && !hasAskedInterviewerQuestion(question.id)
    );
  const getPattern3ExplicitMandatoryQuestionCount = () =>
    Object.keys(pattern3ExplicitMandatoryQuestionIds).length;
  const getPattern3ExplicitExtraQuestionCount = () =>
    Object.keys(pattern3ExplicitExtraQuestionIds).length;
  const markPattern3QuestionIssued = (question: InterviewQuestionSpec) => {
    pendingPattern3IssuedQuestionId = question.id;
    askedInterviewerQuestionIds[question.id] = true;
    if (question.phase === "pattern3" && question.target === "sales" && question.mandatory) {
      pattern3ExplicitMandatoryQuestionIds[question.id] = true;
    }
    if (isPattern3ExtraQuestion(question)) {
      pattern3ExplicitExtraQuestionIds[question.id] = true;
    }
  };
  const getPattern3SelectedQuestionPlanOrder = (question: InterviewQuestionSpec) =>
    Math.max(
      0,
      pattern3SelectedQuestions.findIndex((candidate) => candidate.id === question.id)
    );
  const getNextPendingMandatoryPattern3Question = (
    currentSection: Pattern3Section
  ) => {
    const currentRank = getPattern3SectionRank(currentSection);
    const pendingMandatoryQuestions = getPendingMandatoryPattern3Questions();
    const exactMatch =
      pendingMandatoryQuestions.find(
        (question) =>
          getPattern3SectionForQuestionWindow(question.window) === currentSection
      ) ?? null;
    if (exactMatch) return exactMatch;
    const overdueMatch =
      pendingMandatoryQuestions.find((question) => {
        const questionSection = getPattern3SectionForQuestionWindow(question.window);
        return (
          questionSection !== null &&
          getPattern3SectionRank(questionSection) < currentRank
        );
      }) ?? null;
    if (overdueMatch) return overdueMatch;
    return (
      pendingMandatoryQuestions.find((question) => {
        const questionSection = getPattern3SectionForQuestionWindow(question.window);
        return (
          questionSection !== null &&
          getPattern3SectionRank(questionSection) >= currentRank
        );
      }) ?? null
    );
  };
  const getNextPendingHardPattern3ExtraQuestion = (
    currentSection: Pattern3Section
  ) => {
    if (currentSection === "opening") return null;
    const currentRank = getPattern3SectionRank(currentSection);
    const pendingExtraQuestions = getPendingExtraPattern3Questions();
    const sortByPlanOrder = (questions: InterviewQuestionSpec[]) =>
      [...questions].sort(
        (left, right) =>
          getPattern3SelectedQuestionPlanOrder(left) -
          getPattern3SelectedQuestionPlanOrder(right)
      );
    const exactMatch = sortByPlanOrder(
      pendingExtraQuestions.filter(
        (question) =>
          getPattern3SectionForQuestionWindow(question.window) === currentSection
      )
    )[0] ?? null;
    if (exactMatch) return exactMatch;
    const overdueMatch = sortByPlanOrder(
      pendingExtraQuestions.filter((question) => {
        const questionSection = getPattern3SectionForQuestionWindow(question.window);
        return (
          questionSection !== null &&
          getPattern3SectionRank(questionSection) < currentRank
        );
      })
    )[0] ?? null;
    if (overdueMatch) return overdueMatch;
    return null;
  };
  const getNextPendingPattern3LoopQuestion = (
    currentSection: Pattern3Section
  ) => {
    if (interviewerSettings.difficulty !== "hard") {
      return getNextPendingMandatoryPattern3Question(currentSection);
    }
    const pendingQuestions = getPendingPattern3SelectedQuestions();
    if (!pendingQuestions.length) return null;
    return [...pendingQuestions].sort((left, right) => {
      if (left.mandatory !== right.mandatory) {
        return left.mandatory ? -1 : 1;
      }
      const leftSection = getPattern3SectionForQuestionWindow(left.window);
      const rightSection = getPattern3SectionForQuestionWindow(right.window);
      const leftRank =
        leftSection === null ? Number.MAX_SAFE_INTEGER : getPattern3SectionRank(leftSection);
      const rightRank =
        rightSection === null ? Number.MAX_SAFE_INTEGER : getPattern3SectionRank(rightSection);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return (
        getPattern3SelectedQuestionPlanOrder(left) -
        getPattern3SelectedQuestionPlanOrder(right)
      );
    })[0] ?? null;
  };
  const PATTERN3_BRIDGE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
    { label: "関連して", pattern: /関連して/u },
    { label: "ちなみに", pattern: /ちなみに/u },
    { label: "一点確認ですが", pattern: /一点確認ですが/u },
    { label: "確認ですが", pattern: /確認ですが/u },
    { label: "あと一点", pattern: /あと一点/u },
    { label: "もう一点だけ", pattern: /もう一点だけ/u },
    { label: "念のため", pattern: /念のため/u },
    { label: "差し支えなければ", pattern: /差し支えなければ/u }
  ];
  const detectPattern3BridgeLabel = (text: string) =>
    PATTERN3_BRIDGE_PATTERNS.find(({ pattern }) => pattern.test(text))?.label ?? null;
  const getRecentPattern3QuestionBridgeAvoidanceHint = () => {
    const recentInterviewerTexts = [...conversationHistory]
      .reverse()
      .filter((entry) => entry.speaker === "interviewer" && entry.phase === "pattern3")
      .slice(0, 3)
      .map((entry) => entry.text);
    if (!recentInterviewerTexts.length) return "";
    const recentLabels = recentInterviewerTexts
      .map((text) => detectPattern3BridgeLabel(text))
      .filter((label): label is string => Boolean(label));
    if (!recentLabels.length) {
      return "You do not need to force a bridge every time; after a short acknowledgement, it is also fine to ask the next question directly.";
    }
    const latestLabel = recentLabels[0];
    const repeatedLatestCount = recentLabels.filter((label) => label === latestLabel).length;
    if (repeatedLatestCount >= 2) {
      return `The recent company-side questions already repeated the bridge phrase 「${latestLabel}」. This turn should not use another stock bridge phrase at all. After a short acknowledgement, ask the next question directly in a natural sentence.`;
    }
    const uniqueRecentLabels = [...new Set(recentLabels)].map((label) => `「${label}」`);
    return `The immediately previous company-side question already used the bridge phrase 「${latestLabel}」. Do not reuse it in this turn. Also avoid quickly repeating recently used bridges such as ${uniqueRecentLabels.join("、")}. After a short acknowledgement, either ask the next question directly or switch to a clearly different natural opener.`;
  };
  const getPattern3RemainingQuestionCountAfterCurrent = (
    question: InterviewQuestionSpec
  ) => {
    const pendingCount = getPendingPattern3SelectedQuestions().length;
    return hasAskedInterviewerQuestion(question.id)
      ? pendingCount
      : Math.max(0, pendingCount - 1);
  };
  const getPattern3QuestionBridgeHint = (
    question: InterviewQuestionSpec,
    context: "normal" | "loop"
  ) => {
    const remainingAfterCurrent = getPattern3RemainingQuestionCountAfterCurrent(question);
    const isFinalQueuedQuestion = remainingAfterCurrent === 0;
    const oneMoreHint = isFinalQueuedQuestion
      ? "Because this is effectively the last queued question, wording like 「最後に一点だけ」 or 「もう一点だけ」 is acceptable if it sounds natural."
      : "Do not use wording that implies there is only one question left, such as 「もう一点だけ」 or 「あと一点」, because more questions may still follow.";
    if (context === "loop") {
      if (question.window === "pattern3_contract") {
        return `Use a short natural bridge such as 「住まいの点で確認ですが、」, 「住まいの点で一点確認ですが、」, or no bridge after a short acknowledgement. ${oneMoreHint} ${getRecentPattern3QuestionBridgeAvoidanceHint()}`;
      }
      if (question.window === "pattern3_timeline") {
        return `Use a short natural bridge such as 「念のため確認ですが、」, 「確認ですが、」, or no bridge after a short acknowledgement. ${oneMoreHint} ${getRecentPattern3QuestionBridgeAvoidanceHint()}`;
      }
      if (question.window === "pattern3_visa") {
        return `Use a short natural bridge such as 「ちなみに、」, 「確認ですが、」, or no bridge after a short acknowledgement. ${oneMoreHint} ${getRecentPattern3QuestionBridgeAvoidanceHint()}`;
      }
      return `Use a short natural bridge such as 「ちなみに、」, 「差し支えなければ、」, 「確認ですが、」, or no bridge after a short acknowledgement. ${oneMoreHint} ${getRecentPattern3QuestionBridgeAvoidanceHint()}`;
    }
    if (question.window === "pattern3_contract") {
      return `Connect it naturally with a bridge like 「住まいの点で一点確認ですが、」, 「住まいの点で確認ですが、」, or by asking directly after a short acknowledgement. ${oneMoreHint} ${getRecentPattern3QuestionBridgeAvoidanceHint()}`;
    }
    if (question.window === "pattern3_timeline") {
      return `Connect it naturally with a bridge like 「念のため、」, 「確認ですが、」, or by asking directly after a short acknowledgement. ${oneMoreHint} ${getRecentPattern3QuestionBridgeAvoidanceHint()}`;
    }
    if (question.window === "pattern3_visa") {
      return `Connect it naturally with a bridge like 「ちなみに、」, 「一点確認ですが、」, or by asking directly after a short acknowledgement. ${oneMoreHint} ${getRecentPattern3QuestionBridgeAvoidanceHint()}`;
    }
    if (question.window === "pattern3_documents") {
      return `Connect it naturally with a bridge like 「流れに沿って一点確認ですが、」, 「ちなみに、」, or by asking directly after a short acknowledgement. ${oneMoreHint} ${getRecentPattern3QuestionBridgeAvoidanceHint()}`;
    }
    return `Connect it naturally with a short bridge such as 「一点確認ですが、」, 「ちなみに、」, 「差し支えなければ、」, or by asking directly after a short acknowledgement. ${oneMoreHint} ${getRecentPattern3QuestionBridgeAvoidanceHint()}`;
  };
  const pickWeightedRandom = <T>(items: T[], getWeight: (item: T) => number) => {
    const weightedItems = items
      .map((item) => ({ item, weight: Math.max(0, getWeight(item)) }))
      .filter((entry) => entry.weight > 0);
    if (!weightedItems.length) return null;
    const totalWeight = weightedItems.reduce((sum, entry) => sum + entry.weight, 0);
    let threshold = Math.random() * totalWeight;
    for (const entry of weightedItems) {
      threshold -= entry.weight;
      if (threshold <= 0) {
        return entry.item;
      }
    }
    return weightedItems[weightedItems.length - 1]?.item ?? null;
  };
  const getPattern3QuestionAffinityWeight = (
    question: InterviewQuestionSpec,
    currentSection: Pattern3Section
  ) => {
    const questionSection = getPattern3SectionForQuestionWindow(question.window);
    if (!questionSection) return 1;
    const distance = Math.abs(
      getPattern3SectionRank(questionSection) - getPattern3SectionRank(currentSection)
    );
    if (distance === 0) return 5;
    if (distance === 1) return 3;
    if (distance === 2) return 2;
    return 1;
  };
  const pickRandomPattern3SelectedInterviewerQuestion = (
    currentSection: Pattern3Section,
    intent: Pattern3TurnIntent
  ) => {
    const pendingQuestions = getPendingPattern3SelectedQuestions();
    if (!pendingQuestions.length) return null;
    const hasPendingMandatory = pendingQuestions.some((question) => question.mandatory);
    return pickWeightedRandom(pendingQuestions, (question) => {
      if (intent === "closing" && !question.mandatory) {
        return 0;
      }
      let weight = 1;
      weight += getPattern3QuestionAffinityWeight(question, currentSection);
      if (question.mandatory) {
        weight += hasPendingMandatory ? 6 : 3;
      }
      if (intent === "opening_impression" && question.window === "pattern3_result_followup") {
        weight += 4;
      }
      if (intent === "result_followup" && question.window === "pattern3_result_followup") {
        weight += 3;
      }
      if (
        (intent === "visa_permission" || intent === "visa_explanation") &&
        question.window === "pattern3_visa"
      ) {
        weight += 3;
      }
      if (
        (intent === "contract_permission" || intent === "contract_explanation") &&
        question.window === "pattern3_contract"
      ) {
        weight += 3;
      }
      if (
        (intent === "documents_permission" || intent === "documents_explanation") &&
        question.window === "pattern3_documents"
      ) {
        weight += 3;
      }
      if (
        (intent === "documents_permission" || intent === "documents_explanation") &&
        question.window === "pattern3_timeline"
      ) {
        weight += 2;
      }
      if (
        (intent === "timeline_permission" || intent === "timeline_explanation") &&
        question.window === "pattern3_timeline"
      ) {
        weight += 3;
      }
      if (intent === "deadline_request" && question.mandatory) {
        weight += 4;
      }
      if (intent === "closing" && question.mandatory) {
        weight += 7;
      }
      return weight;
    });
  };
  const shouldAppendRandomPattern3Question = (
    classification: {
      intent: Pattern3TurnIntent;
      section: Pattern3Section;
      shouldAnswerOnly: boolean;
      shouldAppendQuestion: boolean;
      confidence: "high" | "medium" | "low";
    },
    nextQuestion: InterviewQuestionSpec | null
  ) => {
    if (!nextQuestion) return false;
    if (
      interviewerSettings.difficulty === "hard" &&
      isPattern3ExtraQuestion(nextQuestion) &&
      getPattern3ExplicitExtraQuestionCount() < 2 &&
      classification.intent !== "closing" &&
      classification.intent !== "visa_permission" &&
      classification.intent !== "contract_permission" &&
      classification.intent !== "documents_permission" &&
      classification.intent !== "timeline_permission"
    ) {
      return true;
    }
    if (
      interviewerSettings.difficulty === "easy" &&
      nextQuestion.mandatory &&
      getPattern3ExplicitMandatoryQuestionCount() < 2 &&
      classification.intent !== "closing" &&
      classification.intent !== "visa_permission" &&
      classification.intent !== "contract_permission" &&
      classification.intent !== "documents_permission" &&
      classification.intent !== "timeline_permission"
    ) {
      return true;
    }
    if (
      classification.intent === "visa_permission" ||
      classification.intent === "contract_permission" ||
      classification.intent === "documents_permission" ||
      classification.intent === "timeline_permission"
    ) {
      return false;
    }
    if (!classification.shouldAppendQuestion) {
      return false;
    }
    const pendingQuestions = getPendingPattern3SelectedQuestions();
    const pendingMandatoryCount = pendingQuestions.filter((question) => question.mandatory).length;
    if (classification.intent === "closing") {
      return nextQuestion.mandatory;
    }
    let probability = 0.22;
    switch (classification.intent) {
      case "opening_impression":
      case "result_followup":
        probability = 0.38;
        break;
      case "visa_explanation":
      case "contract_explanation":
      case "documents_explanation":
      case "timeline_explanation":
        probability = 0.28;
        break;
      case "deadline_request":
        probability = 0.3;
        break;
      case "other":
        probability = 0.18;
        break;
      default:
        probability = 0.24;
        break;
    }
    if (interviewerSettings.difficulty === "hard") {
      probability += 0.15;
    }
    if (pendingMandatoryCount > 0) {
      probability += 0.05;
    }
    if (nextQuestion.mandatory) {
      probability += 0.05;
    }
    if (
      classification.section === "documents" &&
      nextQuestion.window === "pattern3_timeline"
    ) {
      probability += 0.08;
    }
    if (
      classification.section === "result_followup" &&
      nextQuestion.window !== "pattern3_result_followup"
    ) {
      probability -= 0.04;
    }
    probability = Math.min(0.7, Math.max(0.08, probability));
    return Math.random() < probability;
  };
  const getNextPattern3SelectedInterviewerQuestion = (
    currentSection: Pattern3Section
  ) => {
    const currentRank = getPattern3SectionRank(currentSection);
    const pendingQuestions = pattern3SelectedQuestions.filter(
      (question) => !hasAskedInterviewerQuestion(question.id)
    );
    const exactMandatoryMatch =
      pendingQuestions.find(
        (question) =>
          question.mandatory &&
          getPattern3SectionForQuestionWindow(question.window) === currentSection
      ) ?? null;
    if (exactMandatoryMatch) return exactMandatoryMatch;
    const overdueMandatoryMatch =
      pendingQuestions.find((question) => {
        const questionSection = getPattern3SectionForQuestionWindow(question.window);
        return (
          question.mandatory &&
          questionSection !== null &&
          getPattern3SectionRank(questionSection) < currentRank
        );
      }) ?? null;
    if (overdueMandatoryMatch) return overdueMandatoryMatch;
    const exactOptionalMatch =
      pendingQuestions.find(
        (question) =>
          !question.mandatory &&
          getPattern3SectionForQuestionWindow(question.window) === currentSection
      ) ?? null;
    if (exactOptionalMatch) return exactOptionalMatch;
    return (
      pendingQuestions.find((question) => {
        const questionSection = getPattern3SectionForQuestionWindow(question.window);
        return (
          questionSection !== null &&
          getPattern3SectionRank(questionSection) <= currentRank
        );
      }) ?? null
    );
  };
  const canAskSelectedCandidateInsertQuestion = () =>
    phase === "pattern2" &&
    introPhase === "complete" &&
    (isStrictSelectedQuestionMode()
      ? true
      : hasStartedBasePattern2QuestionFlow() &&
        lastPattern2QuestionOrigin === "base" &&
        !pattern2StartTimingAsked);
  const canAskSelectedLateCandidateQuestion = () =>
    phase === "pattern2" &&
    introPhase === "complete" &&
    (isStrictSelectedQuestionMode()
      ? !getNextSelectedInterviewerQuestionByWindow("candidate_insert")
      : hasCompletedCorePattern2Coverage() &&
        lastPattern2QuestionOrigin === "base");
  const getNextSelectedInterviewerQuestion = () =>
    phase === "pattern2"
      ? introPhase !== "complete"
        ? null
        : getNextSelectedInterviewerQuestionByWindow("candidate_insert") &&
            canAskSelectedCandidateInsertQuestion()
          ? getNextSelectedInterviewerQuestionByWindow("candidate_insert")
      : getNextSelectedInterviewerQuestionByWindow("late_candidate") &&
              canAskSelectedLateCandidateQuestion()
            ? getNextSelectedInterviewerQuestionByWindow("late_candidate")
            : null
      : null;
  const listPendingSelectedInterviewerQuestions = (currentPhase: Phase) =>
    getPhaseSelectedInterviewerQuestions(currentPhase)
      .filter((question) => !hasAskedInterviewerQuestion(question.id))
      .map((question) => question.prompt);
  const buildSelectedInterviewerQuestionGuidance = (
    question: InterviewQuestionSpec
  ) =>
    question.target === "sales"
      ? `This session has a selected question plan. Ask the sales representative this one short Japanese question now and stop after it. Do not answer it yourself and do not add a different topic in this turn: 「${question.prompt}」.`
      : `This session has a selected question plan. Ask the candidate this one short Japanese question now and stop after it. The sales representative will paraphrase it. Keep the wording very close to: 「${question.prompt}」.`;
  const markPattern3QuestionTopicsCoveredBySalesText = (text: string) => {
    if (phase !== "pattern3") return;
    const normalized = normalizeText(text);
    if (!normalized) return;
    // Mandatory pattern3 questions must be asked explicitly by the company side.
    // Do not auto-consume them just because the sales representative touched the topic.
    void normalized;
  };
  const markInterviewerQuestionsAsked = (text: string) => {
    let matchedQuestion: InterviewQuestionSpec | null = null;
    for (const question of [
      ...pattern2SelectedQuestions,
      ...pattern3SelectedQuestions
    ]) {
      if (
        !hasAskedInterviewerQuestion(question.id) &&
        matchesInterviewQuestionSpec(question, text)
      ) {
        askedInterviewerQuestionIds[question.id] = true;
        if (question.target === "sales") {
          pendingSalesReplyQuestionId = question.id;
        }
        matchedQuestion = question;
      }
    }
    if (matchedQuestion && phase === "pattern2") {
      lastPattern2QuestionOrigin = "selected";
    }
    return matchedQuestion;
  };
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
      (topic) => !followUpTopicUsage[getFollowUpTopicUsageKey(intent, topic.key)]
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
    if (interviewerSettings.difficulty === "hard") {
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
    if (followUpTopicUsage[genericKey]) {
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
    const usageKey = getFollowUpTopicUsageKey(intent, topicKey);
    followUpTopicUsage[usageKey] = true;
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
    if (
      /ご視聴ありがとうございました|ご清聴ありがとうございました|チャンネル登録|高評価/.test(
        normalized
      )
    ) {
      return true;
    }
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
    if (looksLikePattern2ClosureApprovalIntent(text)) return false;

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
  const isStrongPattern2InterviewClosureApprovalRequest = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    const candidateName = normalizeText(getCurrentCandidateName() ?? "");
    const candidateNamePattern = candidateName
      ? `|${escapeRegex(candidateName)}さん?`
      : "";
    const hasStudentExit =
      new RegExp(
        `(学生|生徒|候補者|本人${candidateNamePattern}).*(退室|退出|退席)`
      ).test(normalized) ||
      new RegExp(
        `(退室|退出|退席).*(学生|生徒|候補者|本人${candidateNamePattern})`
      ).test(normalized);
    const hasInterviewClosing =
      /(面接|ご面接).*(終了|以上|終わり|終わりに|終了として)/.test(normalized) ||
      /質問.*以上/.test(normalized) ||
      /(これで|ここで).*(終了|以上)/.test(normalized);
    const hasPermissionAsk =
      /よろしいでしょうか|よろしいですか|いいですか|可能でしょうか|してもよろしい|いただく形でよろしい/.test(
        normalized
      ) || /もよろしいでしょうか|もよろしいですか/.test(normalized);
    return hasStudentExit && hasInterviewClosing && hasPermissionAsk;
  };
  const shouldConsiderPattern2InterviewClosureApprovalWithAi = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    const hasStudentExit = /(学生|生徒|候補者|本人|さん).*(退室|退出|退席)|(退室|退出|退席).*(学生|生徒|候補者|本人|さん)/.test(
      normalized
    );
    const hasInterviewClosing =
      /(面接|ご面接).*(終了|以上|終わり|締め|終わりに|終了として)/.test(normalized) ||
      /質問.*以上/.test(normalized) ||
      /(これで|ここで).*(終了|以上)/.test(normalized);
    const hasPermissionAsk =
      /よろしいでしょうか|よろしいですか|いいですか|可能でしょうか|してもよろしい|いただく形でよろしい/.test(
        normalized
      ) || /もよろしいでしょうか|もよろしいですか/.test(normalized);
    return (
      (hasStudentExit && hasPermissionAsk) ||
      (hasInterviewClosing && hasPermissionAsk) ||
      (hasStudentExit && hasInterviewClosing)
    );
  };
  const looksLikePattern2ClosureApprovalIntent = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (!normalized) return false;
    const hasStudentExit =
      /(学生|生徒|候補者|本人|さん).*(退室|退出|退席)|(退室|退出|退席).*(学生|生徒|候補者|本人|さん)/.test(
        normalized
      ) ||
      /(ご退出|退出していただ|退出してもら|退出いただ|退室していただ|退席していただ)/.test(
        normalized
      );
    const hasInterviewClosing =
      /(面接|ご面接).*(終了|以上|終わり|締め|終わりに|終了として)/.test(normalized) ||
      /質問.*以上/.test(normalized) ||
      /(これで|ここで).*(終了|以上)/.test(normalized);
    const hasPermissionAsk =
      /よろしいでしょうか|よろしいですか|いいですか|可能でしょうか|してもよろしい|いただく形でよろしい/.test(
        normalized
      ) || /もよろしいでしょうか|もよろしいですか/.test(normalized);
    return hasPermissionAsk && (hasStudentExit || hasInterviewClosing);
  };
  const classifyPattern2InterviewClosureApprovalWithAi = async (
    text: string
  ): Promise<{ isRequest: boolean; confidence: "high" | "medium" | "low" }> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1400);
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
                "You classify whether the sales representative's latest Japanese utterance is asking the company-side interviewer for permission to end the candidate-facing part of the interview and have the student/candidate leave before moving to the next discussion. Return strict JSON with keys isRequest and confidence. isRequest must be true or false. confidence must be high, medium, or low. Choose true when the sales representative is effectively saying things like 'the interview is over', 'the candidate/student should leave', and asking 'is that okay?'. Use meaning, not exact keywords. Do not require the interviewer's name to be mentioned. Choose false for normal candidate questions, company questions, acknowledgements, or actual exit instructions that are no longer asking permission."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase,
                introPhase,
                candidateName: getCurrentCandidateName(),
                utterance: text,
                recentHistory: getRecentConversationHistory().slice(-6)
              })
            }
          ]
        })
      });
      if (!response.ok) {
        return { isRequest: false, confidence: "low" };
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as {
        isRequest?: boolean;
        confidence?: "high" | "medium" | "low";
      };
      const confidence =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "low";
      console.log(
        `[Pattern2ClosureApprovalAI] isRequest=${Boolean(parsed.isRequest)} confidence=${confidence} text="${text}"`
      );
      return { isRequest: Boolean(parsed.isRequest), confidence };
    } catch {
      return { isRequest: false, confidence: "low" };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const resolvePattern2ExitApprovalRequest = async (text: string) => {
    if (pendingPattern2ClosureExpected && looksLikePattern2ClosureApprovalIntent(text)) {
      return true;
    }
    if (shouldRequestPattern3ExitApproval(text)) return true;
    if (isStrongPattern2InterviewClosureApprovalRequest(text)) return true;
    if (!shouldConsiderPattern2InterviewClosureApprovalWithAi(text)) return false;
    const aiResult = await classifyPattern2InterviewClosureApprovalWithAi(text);
    return aiResult.isRequest && aiResult.confidence !== "low";
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
  const isPattern3OfferDocumentDecisionPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized || !isPattern3OfferDocumentPrompt(normalized)) return false;
    if (hasPattern3SubstantiveExplanationBody(normalized, "contract")) {
      return false;
    }
    return containsAny(normalized, [
      /いかがでしょうか/,
      /どちらが良いでしょうか/,
      /どちらがよろしいでしょうか/,
      /お送り.*可能/,
      /お送りさせていただく/,
      /送ってもよろしい/,
      /送付.*可能/
    ]);
  };
  const isPattern3LaborConditionFieldRequest = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    const signals = [
      /会社名/u,
      /代表取締役|代表者/u,
      /給料|給与/u,
      /勤務地/u,
      /勤務時間/u,
      /締日|締め日/u,
      /支払日|支給日/u
    ];
    const matchCount = signals.filter((pattern) => pattern.test(normalized)).length;
    return (
      matchCount >= 4 ||
      ((/内容確認|確認させてください|確認させていただ|順に確認/u.test(normalized) ||
        /順にお伝え|順に共有/u.test(normalized)) &&
        matchCount >= 3)
    );
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
  const isPattern3VisaGrowthConfirmationPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return (
      containsAny(normalized, [
        /申請上重要/u,
        /その点はいかがでしょうか/u,
        /将来的なキャリアアップの可能性/u,
        /日本人社員の方と同様/u
      ]) &&
      containsAny(normalized, [
        /キャリアアップ/u,
        /管理業務/u,
        /現場業務/u,
        /人材管理/u,
        /後輩指導/u,
        /シフト補助/u
      ])
    );
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
  const isPattern3FinalQuestionPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /最後に.*ご質問/,
      /最後に.*質問/,
      /ご質問はございますでしょうか/,
      /何かご質問.*ございますでしょうか/,
      /ご不明点.*ございますでしょうか/,
      /最後に.*確認したいこと/
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
  const isPattern3PermissionStylePrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /よろしいでしょうか/,
      /よろしいですか/,
      /問題ないでしょうか/,
      /問題ないですか/,
      /可能でしょうか/,
      /可能ですか/
    ]);
  };
  const isPattern3ExplanationPermissionPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return (
      isPattern3PermissionStylePrompt(normalized) &&
      containsAny(normalized, [
        /ご説明/,
        /ご案内/,
        /お伝え/,
        /お話/,
        /進めさせていただ/,
        /ヒアリング/,
        /確認させていただ/
      ])
    );
  };
  const isPattern3ExplanationLeadInPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /まず初めに.*ご説明/,
      /次に.*ご説明/,
      /まず初めに.*ご案内/,
      /次に.*ご案内/,
      /ご説明を改めてさせていただきます/,
      /ご説明させていただきます/,
      /ご案内させていただきます/,
      /お伝えさせていただきます/,
      /ご説明を進めさせていただきます/,
      /ご案内を進めさせていただきます/,
      /ヒアリングを始めます/,
      /ヒアリングを開始/,
      /このあと.*ご説明/,
      /ここから.*ご説明/,
      /ここから.*ご案内/
    ]);
  };
  const hasPattern3MultiSentenceBody = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    const sentenceCount = (normalized.match(/。/g) ?? []).length;
    return sentenceCount >= 2 || normalized.includes("\n");
  };
  const hasPattern3SubstantiveExplanationBody = (
    text: string,
    section: Pattern3Section
  ) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    const genericBody =
      normalized.length >= 90 &&
      hasPattern3MultiSentenceBody(normalized) &&
      containsAny(normalized, [
        /必要がございます/,
        /必要があります/,
        /流れになります/,
        /ご用意いただく/,
        /提出/,
        /申請上重要/,
        /段階的に/,
        /1年目/,
        /2年目/,
        /双方の書類/,
        /行政書士/,
        /入国管理局/
      ]);
    if (genericBody) return true;
    switch (section) {
      case "visa":
        return (
          containsAny(normalized, [/単純作業/, /現場作業だけ/, /管理業務/, /段階的に/, /1年目/, /2年目/]) &&
          hasPattern3MultiSentenceBody(normalized)
        );
      case "contract":
        return containsAny(normalized, [
          /労働条件通知書/,
          /雇用契約書/,
          /氏名欄/,
          /アルファベット/,
          /押印/,
          /スキャンデータ/,
          /返送/
        ]);
      case "documents":
        return containsAny(normalized, [
          /企業様には/,
          /履歴事項全部証明書/,
          /法定調書合計表/,
          /決算報告書/,
          /会社概要/,
          /雇用保険適用事業所番号/,
          /双方の書類/
        ]);
      case "timeline":
        return containsAny(normalized, [
          /1.?2ヶ月/,
          /3.?4ヶ月/,
          /5.?6ヶ月/,
          /許可率/,
          /70.?80%/,
          /100%許可/,
          /採用枠/
        ]);
      default:
        return false;
    }
  };
  const isPattern3StructuredSectionIntent = (intent: Pattern3TurnIntent) =>
    intent === "visa_permission" ||
    intent === "visa_explanation" ||
    intent === "contract_permission" ||
    intent === "contract_explanation" ||
    intent === "documents_permission" ||
    intent === "documents_explanation" ||
    intent === "timeline_permission" ||
    intent === "timeline_explanation";
  const detectPattern3SectionFromSalesText = (
    text: string
  ): Pattern3Section | null => {
    if (isPattern3ClosingPrompt(text)) return "closing";
    if (isPattern3DeadlinePrompt(text)) return "deadline";
    if (isPattern3VisaOutcomePrompt(text)) return "timeline";
    if (isPattern3RequiredDocsPrompt(text)) return "documents";
    if (isPattern3LaborConditionFieldRequest(text)) return "contract";
    if (isPattern3OfferDocumentPrompt(text)) return "contract";
    if (isPattern3VisaExplanationPrompt(text) || isPattern3CareerPathPrompt(text)) {
      return "visa";
    }
    if (isPattern3ResultTimingPrompt(text)) return "result_followup";
    if (isPattern3ImpressionPrompt(text)) return "opening";
    return null;
  };
  const updatePattern3Section = (salesText: string) => {
    if (phase !== "pattern3") return pattern3Section;
    const detectedSection = detectPattern3SectionFromSalesText(salesText);
    if (!detectedSection) return pattern3Section;
    if (getPattern3SectionRank(detectedSection) >= getPattern3SectionRank(pattern3Section)) {
      pattern3Section = detectedSection;
    }
    return pattern3Section;
  };
  const inferPattern3SectionFromIntent = (
    intent: Pattern3TurnIntent
  ): Pattern3Section => {
    switch (intent) {
      case "opening_impression":
        return "opening";
      case "result_followup":
        return "result_followup";
      case "visa_permission":
      case "visa_explanation":
        return "visa";
      case "contract_permission":
      case "contract_explanation":
        return "contract";
      case "documents_permission":
      case "documents_explanation":
        return "documents";
      case "timeline_permission":
      case "timeline_explanation":
        return "timeline";
      case "deadline_request":
        return "deadline";
      case "closing":
        return "closing";
      default:
        return pattern3Section;
    }
  };
  const fallbackPattern3TurnClassification = (
    salesText: string
  ): {
    intent: Pattern3TurnIntent;
    section: Pattern3Section;
    shouldAnswerOnly: boolean;
    shouldAppendQuestion: boolean;
    confidence: "high" | "medium" | "low";
  } => {
    const normalized = normalizeText(salesText);
    if (!normalized) {
      return {
        intent: "other",
        section: pattern3Section,
        shouldAnswerOnly: true,
        shouldAppendQuestion: false,
        confidence: "low"
      };
    }
    if (isPattern3ClosingPrompt(normalized)) {
      return {
        intent: "closing",
        section: "closing",
        shouldAnswerOnly: true,
        shouldAppendQuestion: false,
        confidence: "high"
      };
    }
    if (isPattern3DeadlinePrompt(normalized)) {
      return {
        intent: "deadline_request",
        section: "deadline",
        shouldAnswerOnly: true,
        shouldAppendQuestion: false,
        confidence: "high"
      };
    }
    if (isPattern3ExplanationPermissionPrompt(normalized)) {
      if (isPattern3RequiredDocsPrompt(normalized)) {
        return {
          intent: "documents_permission",
          section: "documents",
          shouldAnswerOnly: true,
          shouldAppendQuestion: false,
          confidence: "medium"
        };
      }
      if (isPattern3OfferDocumentPrompt(normalized)) {
        return {
          intent: "contract_permission",
          section: "contract",
          shouldAnswerOnly: true,
          shouldAppendQuestion: false,
          confidence: "medium"
        };
      }
      if (isPattern3VisaOutcomePrompt(normalized)) {
        return {
          intent: "timeline_permission",
          section: "timeline",
          shouldAnswerOnly: true,
          shouldAppendQuestion: false,
          confidence: "medium"
        };
      }
      if (isPattern3VisaExplanationPrompt(normalized) || isPattern3CareerPathPrompt(normalized)) {
        return {
          intent: "visa_permission",
          section: "visa",
          shouldAnswerOnly: true,
          shouldAppendQuestion: false,
          confidence: "medium"
        };
      }
    }
    if (isPattern3ExplanationLeadInPrompt(normalized)) {
      if (isPattern3RequiredDocsPrompt(normalized)) {
        return {
          intent: "documents_permission",
          section: "documents",
          shouldAnswerOnly: true,
          shouldAppendQuestion: false,
          confidence: "high"
        };
      }
      if (isPattern3OfferDocumentPrompt(normalized)) {
        return {
          intent: "contract_permission",
          section: "contract",
          shouldAnswerOnly: true,
          shouldAppendQuestion: false,
          confidence: "high"
        };
      }
      if (isPattern3VisaOutcomePrompt(normalized)) {
        return {
          intent: "timeline_permission",
          section: "timeline",
          shouldAnswerOnly: true,
          shouldAppendQuestion: false,
          confidence: "high"
        };
      }
      if (
        isPattern3VisaExplanationPrompt(normalized) ||
        isPattern3CareerPathPrompt(normalized)
      ) {
        return {
          intent: "visa_permission",
          section: "visa",
          shouldAnswerOnly: true,
          shouldAppendQuestion: false,
          confidence: "high"
        };
      }
    }
    if (isPattern3RequiredDocsPrompt(normalized)) {
      return {
        intent: "documents_explanation",
        section: "documents",
        shouldAnswerOnly: true,
        shouldAppendQuestion: false,
        confidence: "high"
      };
    }
    if (isPattern3LaborConditionFieldRequest(normalized)) {
      return {
        intent: "contract_explanation",
        section: "contract",
        shouldAnswerOnly: true,
        shouldAppendQuestion: false,
        confidence: "high"
      };
    }
    if (isPattern3OfferDocumentPrompt(normalized)) {
      return {
        intent: "contract_explanation",
        section: "contract",
        shouldAnswerOnly: true,
        shouldAppendQuestion: false,
        confidence: "high"
      };
    }
    if (isPattern3VisaOutcomePrompt(normalized)) {
      return {
        intent: "timeline_explanation",
        section: "timeline",
        shouldAnswerOnly: true,
        shouldAppendQuestion: false,
        confidence: "high"
      };
    }
    if (isPattern3VisaExplanationPrompt(normalized) || isPattern3CareerPathPrompt(normalized)) {
      return {
        intent: "visa_explanation",
        section: "visa",
        shouldAnswerOnly: true,
        shouldAppendQuestion: false,
        confidence: "high"
      };
    }
    if (isPattern3ResultTimingPrompt(normalized)) {
      return {
        intent: "result_followup",
        section: "result_followup",
        shouldAnswerOnly: true,
        shouldAppendQuestion: false,
        confidence: "high"
      };
    }
    if (isPattern3ImpressionPrompt(normalized)) {
      return {
        intent: "opening_impression",
        section: "opening",
        shouldAnswerOnly: true,
        shouldAppendQuestion: false,
        confidence: "high"
      };
    }
    return {
      intent: "other",
      section: pattern3Section,
      shouldAnswerOnly: true,
      shouldAppendQuestion: false,
      confidence: "low"
    };
  };
  const classifyPattern3TurnWithAi = async (salesText: string) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1600);
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
                "You classify the sales representative's latest Japanese utterance in pattern3, the post-interview closing conversation between the company and the sales representative. Return strict JSON with keys intent, section, shouldAnswerOnly, shouldAppendQuestion, confidence. intent must be one of: opening_impression, result_followup, visa_permission, visa_explanation, contract_permission, contract_explanation, documents_permission, documents_explanation, timeline_permission, timeline_explanation, deadline_request, closing, other. section must be one of: opening, result_followup, visa, contract, documents, timeline, deadline, closing. shouldAnswerOnly must be true when the company should first answer the sales representative's current point directly and briefly. shouldAppendQuestion must be true only when it would still be acceptable, after that short answer, for the company to proactively insert one brief reverse question, even if the timing is a little forceful. confidence must be high, medium, or low. If the sales representative is only announcing that they are about to explain or guide the next topic, classify it as the corresponding *_permission intent even if they did not explicitly say よろしいでしょうか."
            },
            {
              role: "user",
              content: JSON.stringify({
                currentSection: pattern3Section,
                pendingPattern3Questions: listPendingSelectedInterviewerQuestions("pattern3"),
                salesText
              })
            }
          ]
        })
      });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;
      const parsed = JSON.parse(content) as {
        intent?: Pattern3TurnIntent;
        section?: Pattern3Section;
        shouldAnswerOnly?: boolean;
        shouldAppendQuestion?: boolean;
        confidence?: "high" | "medium" | "low";
      };
      if (
        !parsed.intent ||
        !parsed.section ||
        (parsed.confidence !== "high" &&
          parsed.confidence !== "medium" &&
          parsed.confidence !== "low")
      ) {
        return null;
      }
      console.log(
        `[Pattern3IntentAI] intent=${parsed.intent} section=${parsed.section} answerOnly=${Boolean(parsed.shouldAnswerOnly)} appendQuestion=${Boolean(parsed.shouldAppendQuestion)} confidence=${parsed.confidence} text="${salesText}"`
      );
      return {
        intent: parsed.intent,
        section: parsed.section,
        shouldAnswerOnly: Boolean(parsed.shouldAnswerOnly),
        shouldAppendQuestion: Boolean(parsed.shouldAppendQuestion),
        confidence: parsed.confidence
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const resolvePattern3TurnClassification = async (salesText: string) => {
    const coercePattern3Classification = (
      base: {
        intent: Pattern3TurnIntent;
        section: Pattern3Section;
        shouldAnswerOnly: boolean;
        shouldAppendQuestion: boolean;
        confidence: "high" | "medium" | "low";
      }
    ) => {
      if (base.intent === "closing") {
        const explicitSection = detectPattern3SectionFromSalesText(salesText);
        if (explicitSection && explicitSection !== "closing") {
          const overriddenIntent: Pattern3TurnIntent =
            explicitSection === "opening"
              ? "opening_impression"
              : explicitSection === "result_followup"
                ? "result_followup"
                : explicitSection === "visa"
                  ? "visa_explanation"
                  : explicitSection === "contract"
                    ? "contract_explanation"
                    : explicitSection === "documents"
                      ? "documents_explanation"
                      : explicitSection === "timeline"
                        ? "timeline_explanation"
                        : "deadline_request";
          return {
            ...base,
            intent: overriddenIntent,
            section: explicitSection,
            shouldAnswerOnly: true,
            shouldAppendQuestion: false
          };
        }
      }
      if (
        (base.intent === "visa_permission" ||
          base.intent === "contract_permission" ||
          base.intent === "documents_permission" ||
          base.intent === "timeline_permission") &&
        hasPattern3SubstantiveExplanationBody(salesText, base.section)
      ) {
        const explanationIntent: Pattern3TurnIntent =
          base.intent === "visa_permission"
            ? "visa_explanation"
            : base.intent === "contract_permission"
              ? "contract_explanation"
              : base.intent === "documents_permission"
                ? "documents_explanation"
                : "timeline_explanation";
        return {
          ...base,
          intent: explanationIntent,
          shouldAnswerOnly: true,
          shouldAppendQuestion: false
        };
      }
      return base;
    };
    const resolvePattern3Section = (
      base: {
        intent: Pattern3TurnIntent;
        section: Pattern3Section;
        shouldAnswerOnly: boolean;
        shouldAppendQuestion: boolean;
        confidence: "high" | "medium" | "low";
      }
    ) => {
      if (
        isPattern3StructuredSectionIntent(base.intent) &&
        (base.intent.endsWith("_permission") ||
          hasPattern3SubstantiveExplanationBody(salesText, base.section))
      ) {
        pattern3Section = base.section;
        return {
          ...base,
          section: base.section
        };
      }
      const resolvedSection =
        getPattern3SectionRank(base.section) >= getPattern3SectionRank(pattern3Section)
          ? base.section
          : pattern3Section;
      pattern3Section = resolvedSection;
      return {
        ...base,
        section: resolvedSection
      };
    };
    const aiResult = await classifyPattern3TurnWithAi(salesText);
    if (aiResult && aiResult.confidence !== "low") {
      return resolvePattern3Section(
        coercePattern3Classification({
          ...aiResult,
          section: aiResult.section
        })
      );
    }
    const fallback = fallbackPattern3TurnClassification(salesText);
    return resolvePattern3Section(
      coercePattern3Classification({
      ...fallback,
      section: fallback.section
      })
    );
  };
  const getPattern3VisaCareerExamples = () => {
    return getCurrentIndustryScenario().pattern3CareerPathExample;
  };
  const choosePattern3Decision = (): Pattern3Decision =>
    Math.random() < PATTERN3_VERBAL_OFFER_RATE
      ? "verbal_offer"
      : "pending_review";
  const isPattern3VerbalOfferDecision = () =>
    pattern3Decision === "verbal_offer";
  const getPattern3DecisionSummary = () =>
    isPattern3VerbalOfferDecision()
      ? "In this session, the company is positive enough to give a verbal offer in pattern3."
      : "In this session, the company should not give a verbal offer in pattern3 and should say the result will be reviewed internally.";
  const buildPattern3InterviewerGuidance = async (salesText: string) => {
    const classification = await resolvePattern3TurnClassification(salesText);
    const currentSection = classification.section;
    const answeredPattern3Question =
      getSelectedInterviewerQuestionById(pendingPattern3AnsweredQuestionId);
    if (answeredPattern3Question) {
      const nextLoopQuestion = pattern3FinalQuestionLoopActive
        ? getNextPendingPattern3LoopQuestion(currentSection)
        : null;
      if (nextLoopQuestion) {
        markPattern3QuestionIssued(nextLoopQuestion);
        return `The sales representative has just answered your previous company-side question: 「${answeredPattern3Question.prompt}」. First respond with one short acknowledgement sentence in natural business Japanese. Right after that, because there are still selected pattern3 questions to cover before closing, proactively ask exactly one more brief company-side question in Japanese very close to: 「${nextLoopQuestion.prompt}」. ${getPattern3QuestionBridgeHint(nextLoopQuestion, "loop")} Avoid abrupt or redundant transitions like 「それでは、弊社としては」. Do not restate earlier topics. Stop after asking that one question.`;
      }
      pendingPattern3IssuedQuestionId = null;
      pattern3FinalQuestionLoopActive = false;
      return `The sales representative has just answered your previous company-side question: 「${answeredPattern3Question.prompt}」. Respond in natural business Japanese with only one short acknowledgement sentence that shows you understood the answer. Keep it to a brief receipt such as 「ありがとうございます。承知しました。」 or 「ありがとうございます。よく分かりました。」. Do not restate your earlier impression, result, or any other topic. Do not repeat the same question. Do not ask a new company-side question in this turn. After the short acknowledgement, stop so the sales representative can continue the main closing flow.`;
    }
    if (isPattern3CareerPathPrompt(salesText)) {
      pendingPattern3IssuedQuestionId = null;
      return `Respond in natural Japanese as the company side to the sales representative's request for concrete future career-up possibilities for the hiring reason statement. Give one concise but concrete explanation of the kinds of roles or responsibilities the candidate could gradually take on, such as mentoring juniors, helping with shift coordination, safety checks, or light progress management. Do not just repeat your earlier general answer in the same wording. Do not ask a new company-side question in this turn. End after your concrete answer.`;
    }
    if (isPattern3VisaGrowthConfirmationPrompt(salesText)) {
      pendingPattern3IssuedQuestionId = null;
      return `Respond in natural Japanese as the company side to the sales representative's visa-eligibility / future-growth confirmation. Give only a short high-level answer about whether the company can support gradual career growth and future management-side responsibilities. Keep it to 1 or 2 short sentences. Do not give detailed examples yet such as specific later roles, detailed mentoring content, or exact future positions, because the sales representative may ask for those separately afterward. Do not ask a new company-side question in this turn. End after the brief high-level answer.`;
    }
    if (isPattern3LaborConditionFieldRequest(salesText)) {
      pendingPattern3IssuedQuestionId = null;
      return `Respond in natural Japanese as the company side to the sales representative's request to confirm the labor conditions notice details. Answer concretely right now instead of saying you will prepare the information later. Use realistic placeholder values if needed. In one concise reply, include all of these items: company name, representative director name, monthly salary, work location, working hours, salary closing date, and payment date. A natural pattern is: 「ありがとうございます。承知しました。では順にお伝えいたします。まず会社名は〇〇株式会社、代表取締役は□□、給料は月額〇〇万円、勤務地は当社東京事業所、勤務時間は午前8時から午後5時まで、給料の締日は毎月末日、支払日は翌月10日でございます。」 Keep the wording businesslike. Do not ask a new question. Stop after giving the details.`;
    }
    if (isPattern3OfferDocumentDecisionPrompt(salesText)) {
      pendingPattern3IssuedQuestionId = null;
      return `Respond in natural Japanese as the company side to the sales representative's explanation or offer regarding the labor conditions notice / offer-document template. Do not treat this as merely asking permission to continue an explanation. Answer the substance directly. When the sales representative offers to send a template or asks whether sending the template is okay, respond positively and practically in one short businesslike reply, for example by saying that you would like them to send the template. A natural answer is close to: 「ありがとうございます。ぜひ雛形をお送りください。」 or 「ありがとうございます。雛形をお送りいただけますと助かります。」 Do not answer with 「ご説明をお願いします」 in this turn. Do not ask a new company-side question. Stop after your direct answer.`;
    }
    if (isPattern3FinalQuestionPrompt(salesText)) {
      pattern3FinalQuestionLoopActive = true;
      const nextLoopQuestion = getNextPendingPattern3LoopQuestion(currentSection);
      if (nextLoopQuestion) {
        markPattern3QuestionIssued(nextLoopQuestion);
        return `Respond in natural Japanese as the company side to the sales representative's invitation for final questions. First react briefly and politely, then ask exactly one brief company-side question in Japanese very close to: 「${nextLoopQuestion.prompt}」. ${getPattern3QuestionBridgeHint(nextLoopQuestion, "loop")} Do not say that you have no questions yet. Do not close the meeting in this turn. Stop after asking that one question.`;
      }
      pendingPattern3IssuedQuestionId = null;
      pattern3FinalQuestionLoopActive = false;
      return "Respond in natural Japanese as the company side to the sales representative's invitation for final questions. Say briefly and politely that you have no further questions at this point, and stop. Do not close the meeting fully in this turn.";
    }
    if (classification.intent === "closing") {
      const nextLoopQuestion = getNextPendingPattern3LoopQuestion(currentSection);
      if (nextLoopQuestion) {
        pattern3FinalQuestionLoopActive = true;
        markPattern3QuestionIssued(nextLoopQuestion);
        return `Respond in natural Japanese as the company side to the sales representative's closing cue. Before fully closing, briefly acknowledge the closing cue, then reopen with exactly one brief company-side question in Japanese very close to: 「${nextLoopQuestion.prompt}」. ${getPattern3QuestionBridgeHint(nextLoopQuestion, "loop")} Do not end with 「【面接終了】」 in this turn. Stop after asking that one question.`;
      }
    }
    const forcedHardExtraQuestion =
      interviewerSettings.difficulty === "hard" &&
      getPattern3ExplicitExtraQuestionCount() < 2 &&
      classification.intent !== "opening_impression" &&
      classification.intent !== "closing" &&
      classification.intent !== "visa_permission" &&
      classification.intent !== "contract_permission" &&
      classification.intent !== "documents_permission" &&
      classification.intent !== "timeline_permission"
        ? getNextPendingHardPattern3ExtraQuestion(currentSection)
        : null;
    const nextQuestion =
      forcedHardExtraQuestion ??
      pickRandomPattern3SelectedInterviewerQuestion(currentSection, classification.intent);
    const shouldAppendQuestion = forcedHardExtraQuestion
      ? true
      : shouldAppendRandomPattern3Question(classification, nextQuestion);
    const nextQuestionLine = shouldAppendQuestion
      ? `After your short answer, proactively insert exactly one brief company-side reverse question in Japanese, even if the timing is a little forceful. Ask one question close to: 「${nextQuestion!.prompt}」. ${getPattern3QuestionBridgeHint(nextQuestion!, "normal")} Avoid awkward transitions like 「それでは、弊社としては」. Then stop.`
      : "Do not add a new company-side question in this turn. Answer briefly and stop after addressing the sales representative's point.";
    if (shouldAppendQuestion && nextQuestion) {
      markPattern3QuestionIssued(nextQuestion);
    } else {
      pendingPattern3IssuedQuestionId = null;
    }
    console.log(
      `[Pattern3Insert] intent=${classification.intent} section=${currentSection} append=${shouldAppendQuestion} question=${shouldAppendQuestion && nextQuestion ? nextQuestion.id : "none"}`
    );
    if (classification.intent === "closing") {
      if (shouldAppendQuestion && nextQuestion) {
        return `Respond in natural Japanese as the company side. Before fully closing, first react briefly to the sales representative's closing cue, then proactively insert one final short reverse question close to: 「${nextQuestion.prompt}」. Do not end with 「【面接終了】」 in this turn because you are reopening the topic with that question.`;
      }
      return "Respond in Japanese as the company side with a short polite closing. After the closing line, end with 「【面接終了】」.";
    }
    if (
      classification.intent === "visa_permission" ||
      classification.intent === "contract_permission" ||
      classification.intent === "documents_permission" ||
      classification.intent === "timeline_permission"
    ) {
      return `Respond in natural Japanese as the company side with a short acknowledgement to the sales representative's request to continue. Approve them to continue the explanation or guidance they just proposed. If you add a reverse question, first give the short acknowledgement and then insert the question. A tone like 「ありがとうございます。お願いします。」 or 「ありがとうございます。ご説明をお願いします。」 is appropriate. ${nextQuestionLine}`;
    }
    if (
      !hasPattern3SubstantiveExplanationBody(salesText, classification.section) &&
      isPattern3ExplanationLeadInPrompt(salesText) &&
      (classification.intent === "visa_explanation" ||
        classification.intent === "contract_explanation" ||
        classification.intent === "documents_explanation" ||
        classification.intent === "timeline_explanation")
    ) {
      return `Respond in natural Japanese as the company side with a short acknowledgement to the sales representative's announcement that they are about to continue the explanation or guidance. Do not react to the substance yet as they have not explained it yet. If you add a reverse question, first give the short acknowledgement and then insert the question. A tone like 「ありがとうございます。お願いします。」 or 「ありがとうございます。その前に一点確認ですが…」 is appropriate. ${nextQuestionLine}`;
    }
    if (classification.intent === "opening_impression" || currentSection === "opening") {
      const candidateName =
        confirmedCandidateName ??
        expectedCandidateName ??
        getCurrentIndustryScenario().candidateProfile.name;
      return `${getPattern3DecisionSummary()} Respond in natural Japanese as the company side to the sales representative's opening closing talk. Start with a short thanks. If asked for the overall impression, answer that first. If this session is verbal_offer, say the overall impression was good and naturally mention that ${candidateName} looked especially solid. If this session is pending_review, say the overall impression was generally positive but the final result will be discussed internally and shared later. ${nextQuestionLine}`;
    }
    if (classification.intent === "result_followup" || currentSection === "result_followup") {
      return `${getPattern3DecisionSummary()} Respond in natural Japanese as the company side to the sales representative's post-impression follow-up. If they ask for a quick result turnaround, you must answer that point explicitly first in the same turn before doing anything else. In a pending_review session, say clearly that you will review internally and try to respond within 2〜3 days if possible. In a verbal_offer session, stay positive and cooperative, and still answer the turnaround point explicitly first. Only after that direct answer may you add one brief company-side reverse question if instructed. Do not skip the direct answer and do not jump straight to your own question. ${nextQuestionLine}`;
    }
    if (classification.intent === "visa_explanation" || currentSection === "visa") {
      return `Respond in natural Japanese as the company side to the sales representative's explanation of the 技人国 visa / career path. First acknowledge the explanation and react to whether the company can support gradual career growth. Keep the answer at a general level unless the sales representative explicitly asks for concrete future roles or examples. Do not volunteer detailed concrete examples too early. ${nextQuestionLine}`;
    }
    if (classification.intent === "contract_explanation" || currentSection === "contract") {
      return `Respond in natural Japanese as the company side to the sales representative's explanation about the offer notice, labor conditions notice, housing support, or other practical employment arrangements. Answer the point they just raised first, then continue naturally. ${nextQuestionLine}`;
    }
    if (classification.intent === "documents_explanation" || currentSection === "documents") {
      return `Respond in natural Japanese as the company side to the sales representative's explanation of required company documents or the post-interview process. Acknowledge the requested materials first and keep the flow practical and businesslike. ${nextQuestionLine}`;
    }
    if (classification.intent === "timeline_explanation" || currentSection === "timeline") {
      return `Respond in natural Japanese as the company side to the sales representative's explanation about visa timing, possible approval risk, or joining schedule. Answer the timing/risk point first and keep the flow grounded. ${nextQuestionLine}`;
    }
    if (classification.intent === "deadline_request" || currentSection === "deadline") {
      return `${getPattern3DecisionSummary()} Respond in natural Japanese as the company side to the sales representative's request for a concrete return deadline. If this session is verbal_offer, it is natural to commit to sending the labor conditions notice quickly, ideally today or tomorrow. If this session is pending_review, it is natural to commit to sharing the result within a few days if possible. ${nextQuestionLine}`;
    }
    return `Respond in natural Japanese as the company side and keep the current post-interview closing section moving naturally. Answer the sales representative's latest point first and stay on the current topic. ${nextQuestionLine}`;
  };
  const isCandidateCompanyQuestionLoopPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /他に質問.*ありますか/,
      /他に聞きたいこと.*ありますか/,
      /もう一つ質問.*ありますか/,
      /まだ質問.*ありますか/,
      /最後に何か質問.*ありますか/,
      /何か聞きたいこと.*ありますか/
    ]);
  };
  const buildCandidateCompanyQuestionAnswerGuidance = (salesText: string) => {
    const normalized = normalizeText(salesText);
    const scenario = getCurrentIndustryScenario();
    if (/入社前.*勉強/.test(normalized)) {
      const studyTips =
        interviewIndustry === "construction"
          ? "Mention that special pre-study is not mandatory, but knowing basic safety words and common tool names helps someone start the work more smoothly."
          : interviewIndustry === "food"
            ? "Mention that special pre-study is not mandatory, but learning simple service Japanese, menu terms, and hygiene-related words helps someone start the work more smoothly."
            : interviewIndustry === "manufacturing"
              ? "Mention that special pre-study is not mandatory, but learning basic safety words, simple process vocabulary, and common tool or machine names helps someone start the work more smoothly."
              : "Mention that special pre-study is not mandatory, but learning simple service Japanese, greeting phrases, and common workplace terms helps someone start the work more smoothly.";
      return `The candidate asked what to study before joining. Answer directly and naturally in polite Japanese as the company side. Start with one short acknowledgement such as 「ありがとうございます。」 if it fits. ${studyTips} Keep it to 1 or 2 short sentences. Avoid awkward phrases like 「スムーズに入れる」; prefer natural Japanese such as 「仕事に入りやすい」「現場に慣れやすい」「役に立つ」. Tailor the content to the current industry: ${scenario.label}. Do not ask a new question in this turn.`;
    }
    if (/外国人.*先輩/.test(normalized)) {
      return `The candidate asked whether there are foreign senior coworkers. Answer directly and naturally in polite Japanese as the company side. Start with one short acknowledgement such as 「ありがとうございます。」 if it fits. Say that there are foreign staff or seniors when appropriate, and mention briefly that they are active in the workplace and that the environment allows consultation. Keep it to 1 or 2 short sentences. Do not ask a new question in this turn.`;
    }
    return "The candidate has just asked the company a final question through the sales representative. Answer that question directly and briefly in natural Japanese. Start with one short natural acknowledgement such as 「ありがとうございます。」 if it fits, then answer the question. Do not ask a new question in this turn.";
  };
  const buildInterviewerCompanyOverviewLeadGuidance = () =>
    "This is your first substantial turn in pattern2. First say a short acknowledgement such as 「ありがとうございます。」. Then introduce yourself as the hiring company representative in Japanese, and only after that continue into the company/job explanation. Use a natural line such as 「では私も自己紹介をさせていただきます。採用担当の田中と申します。」. Stop after the explanation in this turn. Do not begin concrete interview questions yet.";
  const buildInterviewerCompanyOverviewBodyGuidance = () => {
    const scenario = getIndustryScenario(interviewIndustry);
    return `Briefly explain the job responsibilities and workplace atmosphere for this role. ${scenario.companyOverviewGuidance} Keep it concise, and in Japanese refer to your company/facility naturally as 「当社」「弊社」「当施設」. In this turn, stop after the explanation. Do not begin concrete interview questions yet, and do not close the whole meeting here.`;
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
    const candidateNameHint = normalizeText(
      getCurrentCandidateName() ?? scenario.candidateProfile.name
    );

    const candidateHints = [
      "本人",
      "候補者",
      "求職者",
      candidateNameHint,
      scenario.candidateProfile.nationality,
      "彼女",
      "彼",
      "日本語",
      "経験",
      "資格",
      "前職",
      "働い",
      "できます",
      "できる",
      ...scenario.introKeywords,
      ...scenario.experienceKeywords
    ].filter(Boolean);
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
  const isPattern2InterviewClosingUtterance = (text: string) => {
    const normalized = text.replace(/\s+/g, "");
    if (phase !== "pattern2" || !normalized) return false;
    if (
      /よろしいでしょうか|よろしいですか|いいですか|可能でしょうか|してもよろしい|いただく形でよろしい/.test(
        normalized
      ) || /もよろしいでしょうか|もよろしいですか/.test(normalized)
    ) {
      return false;
    }
    const candidateName = getCurrentCandidateName();
    const addressedCandidate =
      (candidateName
        ? new RegExp(`${escapeRegex(candidateName)}さん?`).test(normalized)
        : false) || /(学生|生徒|候補者|本人|皆さん|みなさん)/.test(normalized);
    const hasWrapUp = /本日の?ご面接.*(以上|終了)|ご面接.*(以上|終了)|面接.*(以上|終了)/.test(
      normalized
    );
    const hasThanks = /ありがとうございました|本日はありがとうございました/.test(normalized);
    const hasExit =
      /(退室|退出|退席).*(ください|お願いします|していただ|してもら)/.test(normalized) ||
      /(それでは|では).*(退室|退出|退席)/.test(normalized);
    return addressedCandidate && hasExit && (hasWrapUp || hasThanks);
  };
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
    const workLabel = `${scenario.label}の仕事`;
    const roughWorkLabel = scenario.label;

    if (candidateLanguageLevel === "basic") {
      return [
        `${candidateName}です。${nationality}出身。${roughWorkLabel}、少し。`,
        `${candidateName}です。${nationality}から。${roughWorkLabel}、ちょっと。`,
        `${candidateName}です。${nationality}出身。${roughWorkLabel}の仕事、少し。`,
        `${candidateName}です。${nationality}。${roughWorkLabel}、経験少し。`
      ];
    }

    if (candidateLanguageLevel === "standard") {
      return [
        `${candidateName}です。${nationality}出身。${workLabel}、少し経験あります。`,
        `${candidateName}です。${nationality}から来ました。${workLabel}、少しやりました。`,
        `${candidateName}です。${nationality}出身です。${workLabel}、少しあります。`,
        `${candidateName}です。${nationality}出身。${workLabel}に興味あります。`
      ];
    }

    return [
      `${candidateName}です。${nationality}出身です。日本では${workLabel}を少し経験しました。`,
      `${candidateName}です。${nationality}から来ました。${workLabel}の経験が少しあり、もっと頑張りたいです。`,
      `${candidateName}です。${nationality}出身です。以前から${workLabel}に興味があって、少し経験もあります。`,
      `${candidateName}です。${nationality}出身です。日本では${workLabel}の仕事を少ししていて、これからも続けたいです。`
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
        : `P3ヒント: 学生退出後は、全体印象の確認、結果のすり合わせ、ビザ説明、条件通知書、必要書類、日程切りの順でクロージングを進めてください。FAQはその流れの中で自然に差し込みます。 / ${getCandidateLevelStatusText()}`;
  const buildCueBlock = (title: string, cues: string[]) =>
    cues.length === 0 ? "" : `\n[${title}]\n- ${cues.join("\n- ")}`;
  const containsAny = (text: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));
  const isQuestionLike = (text: string) =>
    /[?？]|ですか|ますか|でしょうか|どう|何|なに|どこ|いつ|なぜ|どうして|どのよう|どんな|できますか|ありますか|いいですか/.test(
      text
    );
  const getCandidateCompanyQuestionOptions = () => [
    { key: "foreign_senior" as const, text: "外国人の先輩はいますか？" },
    { key: "pre_join_study" as const, text: "入社前に勉強することはありますか？" }
  ];
  const classifyCandidateCompanyQuestionKey = (
    text: string
  ): CandidateCompanyQuestionKey | null => {
    const normalized = normalizeText(text);
    if (!normalized) return null;
    if (/外国人.*先輩/.test(normalized)) return "foreign_senior";
    if (/入社前.*勉強/.test(normalized)) return "pre_join_study";
    return null;
  };
  const getRemainingCandidateCompanyQuestionOptions = () =>
    getCandidateCompanyQuestionOptions().filter(
      (option) => !askedCandidateCompanyQuestionKeys[option.key]
    );
  const getCandidateQuestionExamples = () => {
    const remaining = getRemainingCandidateCompanyQuestionOptions().map(
      (option) => option.text
    );
    return remaining.length > 0 ? remaining : ["もうないです。"];
  };
  const looksLikeStandalonePattern1NameCall = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized || isQuestionLike(normalized)) return false;
    const candidateName = getCurrentCandidateName();
    const escapedName = candidateName ? escapeRegex(candidateName) : null;
    if (
      escapedName &&
      new RegExp(`^(それでは|では|じゃあ|次は|続いて)?${escapedName}さん?[。．！？!?]?$`, "u").test(
        normalized
      )
    ) {
      return true;
    }
    return /^(それでは|では|じゃあ|次は|続いて)?[A-Za-zぁ-んァ-ン一-龯]{1,12}(さん|くん|ちゃん)[。．！？!?]?$/u.test(
      normalized
    );
  };
  const isPattern1AttendancePrompt = (text: string) =>
    looksLikeStandalonePattern1NameCall(text) ||
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
  const classifyPattern1DirectiveByRules = (
    text: string
  ): { mode: CandidateResponseMode | null; confidence: "high" | "medium" | "low" } => {
    const normalized = normalizeText(text);
    const isDrillAnswerPrompt = isExplicitDrillAnswerPrompt(normalized);
    if (!normalized) {
      return { mode: "acknowledge", confidence: "high" };
    }
    if (isPattern1PracticeClosingPrompt(text)) {
      return { mode: "acknowledge", confidence: "high" };
    }
    if (isPattern1ReactionPrompt(normalized)) {
      return { mode: "reaction", confidence: "high" };
    }
    if (
      isPattern1WorkIntentPrompt(normalized) &&
      (isDrillAnswerPrompt || /聞かれたら|質問練習|練習/.test(normalized))
    ) {
      return {
        mode: "fixed_work_intent",
        confidence: "high"
      };
    }
    if (
      isPattern1EffortPrompt(normalized) &&
      (isDrillAnswerPrompt || /聞かれたら|質問練習|練習/.test(normalized))
    ) {
      return {
        mode: "fixed_effort",
        confidence: "high"
      };
    }
    if (isPattern1GoodQuestionFeedbackPrompt(normalized)) {
      return { mode: "acknowledge", confidence: "medium" };
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
  const isStrongPattern1RuleMode = (mode: CandidateResponseMode | null) =>
    mode === "attendance" ||
    mode === "reaction" ||
    mode === "fixed_work_intent" ||
    mode === "fixed_effort" ||
    mode === "acknowledge";
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
                "You classify the sales representative's latest Japanese utterance in pattern1 pre-interview practice. Return strict JSON with keys mode and confidence. mode must be one of: attendance, reaction, fixed_work_intent, fixed_effort, good_question, acknowledge, answer_question. confidence must be one of: high, medium, low. Use recent conversation history and the current stage, not just keywords. Choose attendance for name-call / reply practice, including short utterances that are mainly the candidate's name being called, such as 「ジョンさん。」 after the sales representative has said they will practice attendance. Choose reaction for nodding/aizuchi practice. Choose fixed_work_intent when the sales representative is teaching or practicing the answer meaning 「日本でずっと働きたいです」. Choose fixed_effort when the sales representative is teaching or practicing the answer meaning 「大丈夫です。頑張ります」. Choose good_question when they are asking for a good company question, including when they first praise a previous question and then ask whether there is another one, such as 「いいですね。他に聞きたいことがありますか」 or 「もう一つ質問はありますか」. Choose acknowledge only for explanations, praise, or instructions that do not require a new drill answer. Choose answer_question only when the candidate should answer a genuine question freely rather than repeat a taught phrase."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase: "pattern1",
                defaultMode,
                candidateName: getCurrentCandidateName(),
                utterance: text,
                recentHistory: getRecentConversationHistory()
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
    if (
      ruleResult.mode &&
      ruleResult.confidence !== "low" &&
      isStrongPattern1RuleMode(ruleResult.mode)
    ) {
      return ruleResult.mode;
    }
    const defaultMode =
      ruleResult.mode && ruleResult.confidence !== "low"
        ? ruleResult.mode
        : "acknowledge";
    const aiResult = await classifyPattern1DirectiveWithAi(text, defaultMode);
    if (aiResult.confidence === "high" || aiResult.confidence === "medium") {
      return aiResult.mode;
    }
    if (ruleResult.mode && ruleResult.confidence !== "low") {
      return ruleResult.mode;
    }
    return "acknowledge";
  };
  const validateCandidateResponseWithAi = async (input: {
    salesText: string;
    normalizedPrompt: string;
    mode: CandidateResponseMode | null;
    candidateAnswer: string;
    selectedQuestionId?: string | null;
    selectedQuestionFocus?: string | null;
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
                "You validate whether the candidate AI's latest Japanese reply is natural and coherent given the recent conversation in an interview-practice app. Return strict JSON with keys verdict, confidence, reason, and optional suggestedMode. verdict must be accept or retry. confidence must be high, medium, or low. suggestedMode, if present, must be one of: attendance, reaction, fixed_work_intent, fixed_effort, self_intro, good_question, acknowledge, answer_question, clarify, goodbye. Choose retry when the answer clearly reacts to the wrong part of the sales representative's utterance, copies discourse markers unnaturally, answers a different question, or breaks the conversation flow. If a selected interview question focus is provided, make sure the candidate answer actually addresses that exact focus; if it does not, choose retry. If candidateLevel is basic, also choose retry when the Japanese sounds too fluent, polished, or abstract for a drill-level learner. Be tolerant of broken Japanese, short fragments, and natural variation."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase,
                industry: getCurrentIndustryScenario().label,
                candidateLevel: candidateLanguageLevel,
                mode: input.mode,
                latestSalesUtterance: input.salesText,
                normalizedPrompt: input.normalizedPrompt,
                candidateAnswer: input.candidateAnswer,
                selectedQuestionId: input.selectedQuestionId ?? null,
                selectedQuestionFocus: input.selectedQuestionFocus ?? null,
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
      const resolvedMode = await resolvePattern1DirectiveMode(salesText);
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
        /何か質問/,
        /他に質問/,
        /他に聞きたいこと/,
        /もう一つ質問/
      ])
    ) {
      if (
        currentPhase === "pattern2" &&
        candidateCompanyQuestionLoopActive &&
        isCandidateCompanyQuestionLoopPrompt(salesText)
      ) {
        const remainingCompanyQuestions = getRemainingCandidateCompanyQuestionOptions();
        if (remainingCompanyQuestions.length === 0) {
          return {
            mode: "answer_question",
            instructions: [
              "もう会社への質問はないと短く答える。",
              "例: 「もうないです。」"
            ]
          };
        }
        return {
          mode: "good_question",
          instructions: [
            "会社への質問は残っている候補の中から1つだけ、そのまま質問文で言う。",
            `使ってよい質問は「${remainingCompanyQuestions
              .map((option) => option.text)
              .join("」か「")}」だけ。言い換えずにそのまま言う。`,
            "前に使った質問は繰り返さない。"
          ]
        };
      }
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
      return false;
    }
    if (
      currentPhase === "pattern2" &&
      candidateCompanyQuestionLoopActive &&
      isCandidateCompanyQuestionLoopPrompt(salesText)
    ) {
      return false;
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
      if (
        mode === "acknowledge" &&
        isPattern1GoodQuestionFeedbackPrompt(normalized)
      ) {
        return false;
      }
      if (isPattern1PracticeClosingPrompt(salesText)) {
        return false;
      }
      const sentenceCount = salesText
        .split(/[。！？!?]/)
        .map((part) => part.trim())
        .filter(Boolean).length;
      return (
        mode === "acknowledge" ||
        mode === "answer_question" ||
        mode === "good_question" ||
        looksLikeStandalonePattern1NameCall(salesText) ||
        sentenceCount >= 2 ||
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
    const systemPrompt =
      currentPhase === "pattern1"
        ? "You review whether the proposed candidate response mode is coherent with the recent Japanese conversation in pattern1 pre-interview practice. Return strict JSON with keys mode, normalizedPrompt, confidence. mode must be one of: attendance, reaction, fixed_work_intent, fixed_effort, self_intro, good_question, acknowledge, answer_question, clarify, goodbye. confidence must be high, medium, or low. Use recent history and the practice stage, not just keywords. If the latest sales utterance is mainly a name-call or reply practice cue, revise to attendance. If it is mainly aizuchi practice, revise to reaction. If the candidate has already answered and the sales representative is now only praising, explaining, or wrapping up, revise to acknowledge. But if the sales representative praises a previous company question and then asks whether there is another or one more question, revise to good_question, not acknowledge. Keep good_question only when the sales representative is clearly asking for a new company question right now."
        : "You review whether the proposed candidate response mode is coherent with the recent Japanese conversation in an interview-practice app. Return strict JSON with keys mode, normalizedPrompt, confidence. mode must be one of: attendance, reaction, fixed_work_intent, fixed_effort, self_intro, good_question, acknowledge, answer_question, clarify, goodbye. confidence must be high, medium, or low. If the candidate has already answered the drill and the sales representative is now praising, giving an example, reinforcing, or wrapping up the point, revise the mode to acknowledge. Only keep good_question when the sales representative is clearly asking the candidate to generate a new company question right now.";
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
              content: systemPrompt
            },
            {
              role: "user",
              content: JSON.stringify({
                phase: currentPhase,
                candidateName: getCurrentCandidateName(),
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
    const selectedQuestionProfile = getSelectedCandidateQuestionProfile(
      getSelectedCandidateQuestionIdForPrompting()
    );

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
        cues.push(
          "会社への質問は1つだけ。「外国人の先輩はいますか？」か「入社前に勉強することはありますか？」のどちらかをそのまま言う。"
        );
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
      if (candidateLanguageLevel === "basic") {
        cues.push("初級なので、1文か短い2フレーズまで。助詞が抜けてもよい。急に流暢にならない。");
      }
      if (selectedQuestionProfile && isQuestionLike(normalized)) {
        cues.push(...selectedQuestionProfile.cueLines);
      }
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
        if (
          candidateCompanyQuestionLoopActive &&
          isCandidateCompanyQuestionLoopPrompt(salesText)
        ) {
          const remainingCompanyQuestions = getRemainingCandidateCompanyQuestionOptions();
          if (remainingCompanyQuestions.length === 0) {
            cues.push("もう会社への質問はない。『もうないです。』と短く答える。");
          } else {
            cues.push(
              `残っている会社質問は「${remainingCompanyQuestions
                .map((option) => option.text)
                .join("」か「")}」だけ。言い換えずにそのまま1つ言う。`
            );
          }
        } else {
          cues.push("会社への質問は1つだけ。良い質問を選び、給料・引っ越し・ビザは避ける。");
        }
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
      if (
        shouldRequestPattern3ExitApproval(salesText) ||
        isStrongPattern2InterviewClosureApprovalRequest(salesText)
      ) {
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
      const candidateNameForTurn = normalizeText(
        getCurrentCandidateName() ?? getCurrentIndustryScenario().candidateProfile.name
      );
      const hasQuestionTurnHandoff =
        containsAny(normalized, [
          /お聞きしたいこと|質問したいこと/,
          /聞きたいこと.*(学生|生徒|候補者|本人)/,
          /(学生|生徒|候補者|本人).*(聞きたいこと|質問)/
        ]) ||
        (candidateNameForTurn.length > 0 &&
          containsAny(normalized, [
            new RegExp(`聞きたいこと.*${escapeRegex(candidateNameForTurn)}`),
            new RegExp(`${escapeRegex(candidateNameForTurn)}.*聞きたいこと`),
            new RegExp(`${escapeRegex(candidateNameForTurn)}.*質問`)
          ]));
      if (hasQuestionTurnHandoff) {
        cues.push("営業から質問ターンへ自然につなぐ場面。いきなり質問だけを言わず、まず短く「ありがとうございます。」「それでは、」などと受けてから入る。");
        cues.push("ここから質問ターン。候補者に対する最初の具体的な質問を1つ短く始める。");
      }
      if (containsAny(normalized, [/お伝えしたいこと|特に大丈夫/])) {
        cues.push("締めの場面では、簡潔に前向きな一言で返す。例: 「特に大丈夫です。皆さんと一緒に働けるのを楽しみにしています。」");
      }
      if (introPhase === "complete") {
        cues.push("質問ターンでは、Part2用の質問リストに入っている質問だけを1問ずつ行う。");
        cues.push("候補者回答の深掘りや別話題への脱線を自分から増やさない。");
      }
      cues.push("学生へ直接主導せず、営業担当が進行役である前提を守る。");
    }

    if (currentPhase === "pattern3") {
      cues.push("ここは学生退出後のクロージング。営業が主導して、印象確認→結果→ビザ説明→条件通知書→必要書類→日程切りの順で進める。");
      cues.push("Part3用FAQと必須質問は、その説明の流れに自然に入る範囲だけで差し込む。最初から質問攻めにしない。");
      cues.push("質問を始めるときは、短く「ありがとうございます。それでは、」のように自然につなげてよい。");
      if (isPattern3ClosingPrompt(salesText)) {
        cues.push("締めの最後は丁寧に応じ、「【面接終了】」で終える。");
      }
    }

    return cues;
  };
  const getLatestConversationEntryText = (
    speaker: ConversationHistorySpeaker
  ) =>
    [...conversationHistory].reverse().find((entry) => entry.speaker === speaker)
      ?.text ?? "";
  const getFixedInterviewerReply = () => {
    if (phase === "pattern2" && pendingPattern3ExitApprovalReply) {
      return "承知しました。それでは、どうぞお声がけください。";
    }
    if (
      phase === "pattern2" &&
      introPhase === "sales_intro" &&
      shouldPromptInitialCompanyGreeting(lastSalesUtterance)
    ) {
      return "よろしくお願いします。";
    }
    if (
      phase === "pattern2" &&
      introPhase === "company_ack" &&
      shouldPromptCompanyIntroAcknowledgement(lastSalesUtterance)
    ) {
      return "はい、ありがとうございます。";
    }
    if (
      phase === "pattern2" &&
      introPhase === "student_intro_permission" &&
      shouldPromptStudentIntroApproval(lastSalesUtterance)
    ) {
      return "お願いします！";
    }
    if (phase === "pattern2" && introPhase === "sales_supplement") {
      return "ありがとうございます。";
    }
    return null;
  };
  const buildInterviewerPlannerPrompt = (plan: InterviewerTurnPlan) =>
    plan.exact
      ? `Before you speak, follow this one-turn speaking plan exactly. Say exactly the following Japanese line and nothing else in this turn: 「${plan.utterance}」`
      : `Before you speak, follow this one-turn speaking plan strictly. In this turn, stay very close to the following Japanese content: 「${plan.utterance}」. Keep the meaning and topic the same. You may make only minimal wording adjustments for natural speech, but do not add a new topic or extra explanation. End after this turn.`;
  const planInterviewerTurnWithAi = async (input: {
    pendingGuidance: string | null;
    interruptPrompt: string | null;
    companyOverviewLeadPrompt: string | null;
    companyOverviewBodyPrompt: string | null;
    plannedQuestion: InterviewQuestionSpec | null;
    pendingSelectedQuestions: string[];
    strictSelectedQuestionMode: boolean;
  }): Promise<InterviewerTurnPlan | null> => {
    const fixedReply = getFixedInterviewerReply();
    if (fixedReply) {
      return {
        utterance: fixedReply,
        confidence: "high",
        exact: true,
        reason: "fixed_stage"
      };
    }

    const recentHistory = getRecentConversationHistory().slice(-6);
    const cueLines = lastSalesUtterance
      ? getInterviewerCueLines(lastSalesUtterance, phase)
      : [];
    if (
      !lastSalesUtterance &&
      !input.pendingGuidance &&
      !input.interruptPrompt &&
      !input.companyOverviewLeadPrompt &&
      !input.companyOverviewBodyPrompt &&
      cueLines.length === 0 &&
      recentHistory.length === 0
    ) {
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: OPENAI_INTERVIEWER_PLANNER_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are a low-latency planner for the company-side interviewer's next spoken turn in a Japanese interview practice app. Preserve the existing conversation content and stage constraints. Make only the next interviewer utterance more natural and coherent. Return strict JSON with keys utterance, confidence, and optional reason. utterance must be one interviewer-side turn in natural Japanese, usually 1-3 short sentences. confidence must be high, medium, or low. Do not invent a different agenda, skip ahead, add meta commentary, or include labels/bullets. If guidance/cues require a fixed short acknowledgement, keep the utterance very close to that. If company overview prompts are present, this turn should contain acknowledgement + company-side self-introduction + brief company/job explanation only. If follow-up guidance is present, react briefly and keep the next question on the same topic. If nextPlannedQuestion is present, ask that question now and stay very close to its Japanese wording, but you may make small wording fixes so the Japanese sounds human and professional. When the sales representative has just handed the floor to the interviewer for questions, do not jump straight into the question; first use one short natural bridge such as 「ありがとうございます。それでは、」 before asking it. If strictSelectedQuestionMode is true, never introduce a brand-new interview question unless nextPlannedQuestion or explicit pendingGuidance/interrupt guidance tells you to do so. In that mode, if there is no explicit next question, keep the turn to a short acknowledgement and stop. Do not stack stiff acknowledgements such as 「承知しました、分かりました」 or 「分かりました、ありがとうございます」."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase,
                introPhase,
                industry: getCurrentIndustryScenario().label,
                interviewerSettings,
                salesText: lastSalesUtterance,
                cueLines,
                pendingGuidance: input.pendingGuidance,
                interruptPrompt: input.interruptPrompt,
                companyOverviewLeadPrompt: input.companyOverviewLeadPrompt,
                companyOverviewBodyPrompt: input.companyOverviewBodyPrompt,
                nextPlannedQuestion: input.plannedQuestion?.prompt ?? null,
                pendingSelectedQuestions: input.pendingSelectedQuestions,
                strictSelectedQuestionMode: input.strictSelectedQuestionMode,
                interviewerSelfIntroDone,
                lastInterviewerQuestionText,
                lastCandidateAnswer: getLatestConversationEntryText("candidate"),
                lastInterviewerReply: getLatestConversationEntryText("interviewer"),
                coverage,
                missingCoverage: listMissingCoverage() || "none",
                recentHistory
              })
            }
          ]
        })
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as {
        utterance?: string;
        confidence?: PlannerConfidence;
        reason?: string;
      };
      const utterance =
        typeof parsed.utterance === "string"
          ? parsed.utterance.replace(/\s+/g, " ").trim()
          : "";
      const confidence =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "low";
      if (
        !utterance ||
        utterance.length > 220 ||
        /sales representative|candidate|interviewer|one-turn|speaking plan|営業が|今の優先ルール|^\[/.test(
          utterance
        )
      ) {
        return null;
      }
      return {
        utterance,
        confidence,
        exact: false,
        reason: parsed.reason
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const summarizeCandidateQuestionFocus = (salesText: string) => {
    const selectedQuestionProfile = getSelectedCandidateQuestionProfile(
      getSelectedCandidateQuestionIdForPrompting()
    );
    if (selectedQuestionProfile) {
      return selectedQuestionProfile.focusSummary;
    }
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
      containsAny(normalized, [/経験|前職|業務|担当|仕事|何をして|どのような仕事/]) ||
      containsAnyNormalizedKeywords(normalized, [
        ...scenario.introKeywords,
        ...scenario.experienceKeywords
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
          scenario.candidateExperienceQuestionPrompt,
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
    const activeSelectedQuestion = getSelectedCandidateQuestionSpec(
      getSelectedCandidateQuestionIdForPrompting()
    );
    const isCompanyQuestionLoopTurn =
      phase === "pattern2" &&
      candidateCompanyQuestionLoopActive &&
      isCandidateCompanyQuestionLoopPrompt(salesText);
    const remainingCompanyQuestions = isCompanyQuestionLoopTurn
      ? getRemainingCandidateCompanyQuestionOptions()
      : [];
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
        if (isCompanyQuestionLoopTurn) {
          return remainingCompanyQuestions.length > 0
            ? `会社への質問は「${remainingCompanyQuestions
                .map((option) => option.text)
                .join("」か「")}」の中から1つだけ、そのまま言ってください。`
            : "もう会社への質問がなければ「もうないです。」と短く答えてください。";
        }
        return "会社に聞きたい良い質問を1つ言ってください。";
      case "goodbye":
        return "短くお礼して退出してください。";
      case "acknowledge":
        return "営業担当の説明を聞いて、短く返してください。";
      case "answer_question":
      case "clarify": {
        if (isCompanyQuestionLoopTurn && remainingCompanyQuestions.length === 0) {
          return "もう会社への質問がなければ「もうないです。」と短く答えてください。";
        }
        if (questionSnippet && questionSnippet.length <= 44) {
          const ending = /ですか|ますか|でしょうか|教えて|聞かせて|してください|お願いします/.test(
            questionSnippet
          )
            ? "？"
            : "。";
          return ensureSentenceEnding(questionSnippet, ending);
        }
        if (activeSelectedQuestion) {
          return ensureSentenceEnding(activeSelectedQuestion.prompt, "？");
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
        if (
          phase === "pattern2" &&
          candidateCompanyQuestionLoopActive &&
          isCandidateCompanyQuestionLoopPrompt(salesText)
        ) {
          const remainingCompanyQuestions = getRemainingCandidateCompanyQuestionOptions();
          if (remainingCompanyQuestions.length === 0) {
            summaryLines.push("今は会社への質問がもうないと短く伝える場面。");
          } else {
            summaryLines.push("今は残っている会社質問候補の中から1つだけ、そのまま言う場面。");
          }
        } else {
          summaryLines.push("今は会社に聞く良い質問を1つ言う場面。");
        }
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
  const isTooFluentForBasicCandidateAnswer = (text: string) => {
    const normalized = text.replace(/\s+/g, "").trim();
    if (!normalized) return false;
    if (
      /と思います|と考えています|ことが大切|しっかり|きちんと|前向きに|柔軟に|信頼される|経験を積|対応できます|協力すること|相談すること|やりがい|感じています|ながら|ため|ので/u.test(
        normalized
      )
    ) {
      return true;
    }
    const sentenceCount = normalized
      .split(/[。．!?？！]/u)
      .map((part) => part.trim())
      .filter(Boolean).length;
    if (sentenceCount >= 2 && normalized.length >= 20 && /(です|ます)/u.test(normalized)) {
      return true;
    }
    if (normalized.length >= 28 && /(です|ます)/u.test(normalized)) {
      return true;
    }
    return false;
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
        /let me know|need more help|how can i help|happy to help|anything else|if you need|sales representative|next prompt|self-introduction|wait for|before continuing|can add a supplement|understood\.?|here is the exact line|as requested|say exactly|follow this one-turn|nothing else in this turn/i.test(
          value
        )
      );
    };

    const looksLikeLeakedInstructionReply = (value: string) =>
      /sales representative|candidate|self-introduction|next prompt|wait for their next prompt|respond only after|before continuing|can add a supplement|understood\.?|here is the exact line|as requested|say exactly|nothing else in this turn|営業担当|次の指示|待ってください|指示されてい|指示されています|と言われてい|短く答えるように|そのため|ですので|とお答えします|と答えます/u.test(
        value
      ) ||
      /今は[「『].+[」』]と短く答えるように/u.test(value) ||
      /[「『].+[」』](とお答えします|と答えます)/u.test(value) ||
      /(今は|今回は).*(状況なので|場面なので|流れなので).*(お伝えします|答えます|お答えします)/u.test(
        value
      ) ||
      /(そのように|このように).*(お伝えします|答えます|お答えします)/u.test(
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
      const selectedQuestionProfile = getSelectedCandidateQuestionProfile(
        lastCandidateRelayContext?.selectedQuestionId ?? lastSelectedCandidateQuestionId
      );
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
          return getCandidateQuestionExamples()[0] ?? "もうないです。";
        case "acknowledge":
          return "はい、わかりました。";
        case "clarify":
          return "すみません、もう一度、お願いします。";
        case "answer_question":
        default:
          if (selectedQuestionProfile) {
            return selectedQuestionProfile.fallbackAnswer;
          }
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

    const extractSafeShortCandidateReply = (value: string) => {
      const normalizedValue = normalizeText(value);
      if (/もうない|ありません|ないです/u.test(normalizedValue)) {
        return "もうないです。";
      }
      if (/大丈夫です/u.test(normalizedValue)) {
        return "大丈夫です。";
      }
      if (/頑張ります/u.test(normalizedValue)) {
        return "大丈夫です！頑張ります！";
      }
      if (/日本でずっと働きたい/u.test(normalizedValue)) {
        return "日本でずっと働きたいです。";
      }
      return null;
    };

    const candidateName =
      getCurrentCandidateName() ?? getCurrentIndustryScenario().candidateProfile.name;

    if (
      effectiveMode &&
      (looksLikeEnglishMetaReply(normalized) ||
        looksLikeLeakedInstructionReply(normalized))
    ) {
      const fallback =
        extractSafeShortCandidateReply(normalized) ??
        buildCandidateFallbackFromContext(effectiveMode);
      console.log(
        `[CandidateNormalizeFallback] mode=${effectiveMode} raw="${normalized}" fallback="${fallback}"`
      );
      normalized = fallback;
    }

    if (
      candidateLanguageLevel === "basic" &&
      effectiveMode &&
      effectiveMode !== "attendance" &&
      effectiveMode !== "reaction" &&
      effectiveMode !== "fixed_work_intent" &&
      effectiveMode !== "fixed_effort" &&
      effectiveMode !== "acknowledge" &&
      effectiveMode !== "goodbye" &&
      isTooFluentForBasicCandidateAnswer(normalized)
    ) {
      const fallback = buildCandidateFallbackFromContext(effectiveMode);
      console.log(
        `[CandidateBasicClamp] mode=${effectiveMode} raw="${normalized}" fallback="${fallback}"`
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
        normalized = stripLeadingDiscourseMarkers(normalized);
        if (
          effectiveMode === "answer_question" &&
          isCandidateAcknowledgeOnlyAnswer(normalized)
        ) {
          return buildCandidateFallbackFromContext(effectiveMode);
        }
        return normalized;
    }
  };
  const getFixedCandidateReply = (
    mode: CandidateResponseMode | null
  ): string | null => {
    switch (mode) {
      case "attendance":
        return "はい！";
      case "fixed_work_intent":
        return "日本でずっと働きたいです。";
      case "fixed_effort":
        return "大丈夫です！頑張ります！";
      default:
        return null;
    }
  };
  const isExactCandidatePlannerMode = (mode: CandidateResponseMode | null) =>
    mode === "attendance" ||
    mode === "reaction" ||
    mode === "fixed_work_intent" ||
    mode === "fixed_effort" ||
    mode === "acknowledge" ||
    mode === "goodbye" ||
    Boolean(
      getSelectedCandidateQuestionProfile(getSelectedCandidateQuestionIdForPrompting())
    );
  const buildCandidateRetryPromptText = (input: {
    normalizedPrompt: string;
    retryMode: CandidateResponseMode;
    rejectedAnswer: string;
    reason?: string;
    selectedQuestionProfile: SelectedCandidateQuestionProfile | null;
  }) => {
    const focusText = input.selectedQuestionProfile
      ? `Selected question focus: ${input.selectedQuestionProfile.focusSummary}. `
      : "";
    const cueText = input.selectedQuestionProfile?.cueLines[0]
      ? `Important: ${input.selectedQuestionProfile.cueLines[0]} `
      : "";
    const exampleText = input.selectedQuestionProfile?.fallbackAnswer
      ? `A safe example would be: 「${input.selectedQuestionProfile.fallbackAnswer}」. `
      : "";
    return `Your previous reply was not natural enough for the current conversation and was discarded. Try once more in Japanese. Latest sales meaning: 「${input.normalizedPrompt}」. Expected response mode: ${input.retryMode}. ${focusText}${cueText}${exampleText}${input.reason ? `Fix this issue: ${input.reason}. ` : ""}Do not repeat the discarded reply: 「${input.rejectedAnswer}」. Keep it short and natural for the current context.`;
  };
  const buildCandidatePlannerPrompt = (plan: CandidateTurnPlan) =>
    plan.exact
      ? `Before you speak, follow this one-turn candidate speaking plan exactly. Say exactly the following Japanese line and nothing else in this turn: 「${plan.utterance}」`
      : `Before you speak, follow this one-turn candidate speaking plan strictly. In this turn, stay very close to the following Japanese content: 「${plan.utterance}」. Keep the meaning and brevity the same. You may make only minimal wording adjustments for natural speech. Do not add a new topic or extra explanation. End after this turn.`;
  const planCandidateTurnWithAi = async (input: {
    salesText: string;
    normalizedPrompt: string;
    mode: CandidateResponseMode | null;
    instructions: string[];
  }): Promise<CandidateTurnPlan | null> => {
    const fixedReply = getFixedCandidateReply(input.mode);
    if (fixedReply) {
      return {
        utterance: fixedReply,
        confidence: "high",
        exact: true,
        reason: "fixed_mode"
      };
    }

    if (!input.mode || !input.normalizedPrompt.trim()) {
      return null;
    }

    const recentHistory = getRecentConversationHistory().slice(-6);
    const cueLines = getCandidateCueLines(input.normalizedPrompt, phase);
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
          model: OPENAI_CANDIDATE_PLANNER_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are a low-latency planner for the candidate AI's next spoken turn in a Japanese interview practice app. Preserve the existing response mode and keep the app's short-answer style. Return strict JSON with keys utterance, confidence, and optional reason. utterance must be one short candidate-side turn in Japanese, usually 1 sentence and at most about 20 Japanese words. Do not invent a new topic, do not add meta commentary, and do not repeat the sales representative's discourse markers unnaturally. For attendance, give only a bright reply. For reaction or acknowledge, give only one short acknowledgement. For self_intro, start with the candidate's name followed by 「です。」. For good_question, output exactly one simple question to the company. For answer_question or clarify, answer the latest point directly and briefly. If candidateLevel is basic, keep the reply at drill level for the whole session: 1 very short sentence or 2 short fragments at most, often with missing particles, limited vocabulary, and slightly broken grammar. In basic mode, do not suddenly sound fluent and avoid polished phrases such as 「〜と思います」「〜ことが大切です」「〜していきたいです」."
            },
            {
              role: "user",
              content: JSON.stringify({
                phase,
                candidateLevel: candidateLanguageLevel,
                candidateName: getCurrentCandidateName(),
                industry: getCurrentIndustryScenario().label,
                mode: input.mode,
                salesText: input.salesText,
                normalizedPrompt: input.normalizedPrompt,
                instructions: input.instructions,
                cueLines,
                lastInterviewerQuestionText,
                lastCandidateAnswer: getLatestConversationEntryText("candidate"),
                recentHistory
              })
            }
          ]
        })
      });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as {
        utterance?: string;
        confidence?: PlannerConfidence;
        reason?: string;
      };
      const rawUtterance =
        typeof parsed.utterance === "string" ? parsed.utterance.trim() : "";
      if (!rawUtterance) {
        return null;
      }
      const confidence =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "low";
      const utterance = normalizeCandidateFinalText(rawUtterance, input.mode);
      if (!utterance) {
        return null;
      }
      return {
        utterance,
        confidence,
        exact: isExactCandidatePlannerMode(input.mode),
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const normalizeInterviewerFinalText = (text: string) => {
    let normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return normalized;

    normalized = normalized.replace(
      /^(承知しました|かしこまりました)[、,\s]+(分かりました|わかりました)[。．]?\s*/u,
      "よく分かりました。"
    );
    normalized = normalized.replace(
      /^(承知しました|かしこまりました)[。．]\s*(分かりました|わかりました)[。．]?\s*/u,
      "よく分かりました。"
    );
    normalized = normalized.replace(
      /^(分かりました|わかりました)[、,\s]+(ありがとうございます|ありがとうございました)[。．]?\s*/u,
      "ありがとうございます。"
    );
    normalized = normalized.replace(
      /^(承知しました|かしこまりました)[、,\s]+(ありがとうございます|ありがとうございました)[。．]?\s*/u,
      "ありがとうございます。"
    );

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
  const stripQuestionTailFromCompanyOverview = (text: string) => {
    const normalized = text.trim();
    if (!normalized) return normalized;
    const cutoffPatterns = [
      /それでは、?ここから具体的な質問に入らせていただきます。?/u,
      /それでは、?ここから質問に入らせていただきます。?/u,
      /まず、?[^\n。！？!?]*お聞かせください。?/u,
      /どんな仕事をして、どんな業務を担当していたか、具体的にお聞かせください。?/u,
      /ご経験について教えていただけますか。?/u
    ];
    for (const pattern of cutoffPatterns) {
      const match = normalized.match(pattern);
      if (match && match.index !== undefined) {
        return normalized.slice(0, match.index).trim();
      }
    }
    const sentences = normalized.match(/[^。！？!?]+[。！？!?]?/gu);
    if (!sentences) return normalized;
    const kept: string[] = [];
    for (const sentence of sentences) {
      if (
        /ですか[。？]?|ますか[。？]?|でしょうか[。？]?|お聞かせください|教えていただけますか/u.test(
          sentence
        )
      ) {
        break;
      }
      kept.push(sentence);
    }
    return kept.join("").trim() || normalized;
  };
  const buildCandidateRelayMessage = async (
    salesText: string
  ): Promise<CandidateRelayMessage> => {
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
        instructions: directive.instructions,
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
        instructions: directive.instructions,
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
        instructions: directive.instructions,
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
      instructions: directive.instructions,
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
  const resolveSelectedCandidateQuestionIdForSalesTurn = (salesText: string) => {
    if (
      phase === "pattern2" &&
      candidateCompanyQuestionLoopActive &&
      isCandidateCompanyQuestionLoopPrompt(salesText)
    ) {
      return "common_last_question";
    }
    return getSelectedCandidateQuestionIdForPrompting();
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
  const stripLeadingExplicitAddress = (text: string) => {
    const candidateName = getCurrentCandidateName();
    const escapedCandidateName = candidateName
      ? candidateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : null;
    const addressTokens = [
      escapedCandidateName ? `${escapedCandidateName}さん?` : null,
      "本人",
      "候補者",
      "あなた",
      "皆さん",
      "みなさん",
      "学生の皆さん",
      "生徒の皆さん",
      "面接官様",
      "面接官の方",
      "企業様",
      "企業の方",
      "採用担当",
      "担当者",
      "御社",
      "田中様"
    ].filter(Boolean) as string[];
    if (!addressTokens.length) return text.trim();
    const pattern = new RegExp(
      `^\\s*(?:${addressTokens.join("|")})\\s*[、,，。.!！?？:]?\\s*`
    );
    return text.replace(pattern, "").trim();
  };
  const isAddressedAcknowledgementOnlyUtterance = (text: string) => {
    const stripped = stripLeadingExplicitAddress(text);
    if (!stripped || stripped === text.trim()) return false;
    return isAcknowledgementOnlyUtterance(stripped);
  };
  const isPattern1PracticeClosingPrompt = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return containsAny(normalized, [
      /面接官が入室するので.*面接を始めましょう/u,
      /では.*面接を始めましょう/u,
      /事前練習.*以上/u,
      /ここまで.*練習/u
    ]);
  };
  const getLatestCommittedNonSalesSpeaker = () =>
    [...conversationHistory].reverse().find((entry) => entry.speaker !== "sales")
      ?.speaker ?? null;
  const wasLatestCommittedSpeakerCandidate = () =>
    getLatestCommittedNonSalesSpeaker() === "candidate";
  const wasLatestCommittedSpeakerInterviewer = () =>
    getLatestCommittedNonSalesSpeaker() === "interviewer";
  const looksLikeSalesSupplementForInterviewer = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized || isQuestionLike(normalized)) return false;
    const compact = normalized.replace(/\s+/g, "");
    const candidateName = getCurrentCandidateName();
    const escapedName = candidateName
      ? candidateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : null;
    const mentionsCandidate =
      (escapedName ? new RegExp(`${escapedName}さん?`).test(normalized) : false) ||
      /(本人|候補者|この方|こちらの方|学生さん)/.test(normalized);
    const hasReportedSpeech =
      /と聞いております|と聞いており|とのことです|とおっしゃって|と仰って|と話しておりました|と考えております|と伺って/.test(
        normalized
      );
    const hasSummarySignals =
      /前向き|意欲|気持ち|思い|頑張って|活かして|見込み|問題ない|問題なく|対応でき|取り組める|取り組んで|体力|健康|勉強中|基本的な会話|簡単な指示|夜勤|勤務経験|レクリエーション|丁寧な補助|協力しながら|寄り添|助けたい/.test(
        normalized
      );
    const isLongSupplement = compact.length >= 24;
    return (
      /補足/.test(normalized) ||
      hasReportedSpeech ||
      /と思っております|だそうです/.test(
        normalized
      ) ||
      /以前の職場|前の職場|勤務していた|働いていた|経験していた|対応できる|対応できそう|見込み|問題ない|大丈夫だと思|柔軟に|安心して|意識して|対応していた/.test(
        normalized
      ) ||
      ((mentionsCandidate || pendingFollowUpContext !== null) &&
        hasSummarySignals &&
        isLongSupplement) ||
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
  const isStrongInterviewerQuestionTurnHandoff = (text: string) => {
    const normalized = normalizeText(text);
    return containsAny(normalized, [
      /(田中様|御社|採用担当|面接官).*(方から)?.*(お聞きしたいこと|質問したいこと|聞きたいこと|ご質問)/,
      /(お聞きしたいこと|質問したいこと|聞きたいこと|ご質問).*(田中様|御社|採用担当|面接官)/,
      /方から.*(お聞きしたいこと|質問したいこと|聞きたいこと|ご質問).*(ございますでしょうか|ありますでしょうか|お願いします)/,
      /(田中様|御社|採用担当).*(ございますでしょうか|ありますでしょうか)/
    ]);
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
    if (
      phase === "pattern2" &&
      pendingPattern2ClosureExpected &&
      looksLikePattern2ClosureApprovalIntent(text)
    ) {
      return { target: "ai_a", confidence: "high" };
    }
    if (
      phase === "pattern2" &&
      isStrongPattern2InterviewClosureApprovalRequest(text)
    ) {
      return { target: "ai_a", confidence: "high" };
    }
    if (pendingSalesReplyQuestionId) {
      return { target: "ai_a", confidence: "high" };
    }
    if (pendingCandidateRetry || studentIntroPromptPending) {
      return { target: "ai_b", confidence: "high" };
    }
    if (phase === "pattern2" && pendingCandidateCompanyQuestionRelay) {
      if (isExplicitCandidateAddress(text)) {
        return { target: "ai_b", confidence: "high" };
      }
      return { target: "ai_a", confidence: "high" };
    }
    if (
      phase === "pattern2" &&
      candidateCompanyQuestionLoopActive &&
      isCandidateCompanyQuestionLoopPrompt(text)
    ) {
      return { target: "ai_b", confidence: "high" };
    }
    if (
      phase === "pattern2" &&
      latestSpeakerWasCandidate &&
      !pendingCandidateRetry &&
      !isQuestionLike(normalized) &&
      !isAcknowledgementOnlyUtterance(text) &&
      looksLikeSalesSupplementForInterviewer(text)
    ) {
      return { target: "ai_a", confidence: "high" };
    }
    if (phase === "pattern2" && isStrongEffortConfirmationPrompt(normalized)) {
      return { target: "ai_b", confidence: "high" };
    }
    if (isAddressedAcknowledgementOnlyUtterance(text)) {
      return { target: "none", confidence: "high" };
    }
    if (isAcknowledgementOnlyUtterance(text)) {
      return { target: "none", confidence: "high" };
    }
    if (phase === "pattern2" && isStrongInterviewerQuestionTurnHandoff(text)) {
      return { target: "ai_a", confidence: "high" };
    }

    const candidateAddressed = isExplicitCandidateAddress(text);
    const interviewerAddressed = isExplicitInterviewerAddress(text);
    const activeSelectedCandidateQuestion = getSelectedCandidateQuestionSpec(
      getSelectedCandidateQuestionIdForPrompting()
    );
    const latestSpeakerWasInterviewer =
      lastAiSpeaker === "ai_a" || wasLatestCommittedSpeakerInterviewer();

    if (
      phase === "pattern2" &&
      latestSpeakerWasInterviewer &&
      activeSelectedCandidateQuestion &&
      isQuestionLike(normalized) &&
      !interviewerAddressed &&
      !looksLikeSalesSupplementForInterviewer(text) &&
      !isAcknowledgementOnlyUtterance(text)
    ) {
      return { target: "ai_b", confidence: candidateAddressed ? "high" : "medium" };
    }

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
      return { target: "none", confidence: "medium" };
    }
    return { target: null, confidence: "low" };
  };
  const shouldUseAiRelayReview = (
    text: string,
    ruleResult: { target: RelayTarget | null; confidence: "high" | "medium" | "low" }
  ) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    if (phase === "pattern1") return false;
    if (phase === "pattern3") return false;
    if (ruleResult.target === null) return true;
    if (ruleResult.target === "none") return false;
    if (pendingSalesReplyQuestionId || pendingCandidateRetry || studentIntroPromptPending) {
      return false;
    }
    if (phase === "pattern2" && pendingCandidateCompanyQuestionRelay) {
      return false;
    }
    if (
      phase === "pattern2" &&
      candidateCompanyQuestionLoopActive &&
      isCandidateCompanyQuestionLoopPrompt(text)
    ) {
      return false;
    }
    if (phase === "pattern2" && looksLikePattern2ClosureApprovalIntent(text)) {
      return false;
    }
    if (
      phase === "pattern2" &&
      pendingPattern2ClosureExpected &&
      looksLikePattern2ClosureApprovalIntent(text)
    ) {
      return false;
    }
    if (isStrongPattern2InterviewClosureApprovalRequest(text)) {
      return false;
    }
    if (isStrongInterviewerQuestionTurnHandoff(text)) {
      return false;
    }
    if (looksLikeSalesSupplementForInterviewer(text)) {
      return false;
    }
    if (isQuestionLike(normalized)) {
      return false;
    }
    return true;
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
                "You classify who should answer the sales representative's latest Japanese utterance in a 3-party interview practice app. Return strict JSON with keys target and confidence. target must be one of: interviewer, candidate, none. confidence must be one of: high, medium, low. Use the recent conversation history and current interview intent, not just surface keywords. Choose interviewer when the sales representative is summarizing or supplementing the candidate's answer for the company side, or is clearly handing the floor back to the company-side person for the next question, even if the candidate's name appears only as the topic. Choose candidate only when the sales representative is clearly asking the candidate to answer now. Choose none for acknowledgements, short praise-only comments like 「意気込みばっちりですね」, transitions, or statements that do not require an answer."
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
    if (shouldUseAiRelayReview(text, ruleResult)) {
      const aiReviewed = await classifyRelayTargetWithAi(text, defaultTarget);
      if (aiReviewed.confidence === "high" || aiReviewed.confidence === "medium") {
        return aiReviewed.target;
      }
      if (ruleResult.target !== null) {
        return ruleResult.target;
      }
      return defaultTarget;
    }
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
    clearBufferedCandidateAudioDoneFallback();
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
    if (SALES_LED_FLOW && currentTurn.ai_b === turnId) {
      playbackDone.ai_b = true;
      logEvent("ai_b", "audio_playback_done_skip");
    }
    clearBufferedCandidatePlaybackDoneFallback();
    bufferedCandidatePlaybackDoneFallbackTimer = setTimeout(() => {
      if (currentTurn.ai_b !== turnId || playbackDone.ai_b) return;
      playbackDone.ai_b = true;
      logEvent("ai_b", "audio_playback_done_fallback");
      checkTurnCompletion("ai_b");
    }, getBufferedCandidatePlaybackFallbackMs(validatedText));
    bufferedCandidateTurn = null;
    checkTurnCompletion("ai_b");
  };
  const sendSessionUpdateToAi = (key: AiKey) => {
    const socket = aiSockets[key];
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(buildSessionUpdate(getAiProfile(key))));
  };
  const sendSessionUpdateToTranscription = () => {
    if (!transcriptionSocket || transcriptionSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    transcriptionSocket.send(JSON.stringify(buildTranscriptionSessionUpdate()));
  };
  const maybeStartPendingSession = () => {
    if (!pendingStart && !waitingForSessionRefresh) return;
    if (!sessionReady.ai_a || !sessionReady.ai_b) {
      console.log(
        `[Sessions] still waiting for socket readiness ai_a=${sessionReady.ai_a} ai_b=${sessionReady.ai_b} pendingStart=${pendingStart} waitingRefresh=${waitingForSessionRefresh}`
      );
      return;
    }
    if (pendingSessionRefresh.ai_a || pendingSessionRefresh.ai_b) {
      console.log(
        `[Sessions] waiting for refresh ack pending=${JSON.stringify(
          pendingSessionRefresh
        )}`
      );
      return;
    }

    pendingStart = false;
    waitingForSessionRefresh = false;
    clearSessionRefreshWatchdog();
    console.log("[Sessions] ready -> notifying client");
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
      setScriptHint("P3ヒント: クロージングの本流を優先してください。印象確認、結果、技人国ビザ説明、条件通知書、必要書類、日程切りの順に進め、FAQは自然なところで差し込んでください。");
      return;
    }
  };

  const emitPhaseUpdate = (nextPhase: Phase, reason: "start" | "trigger" | "manual") => {
    sendToClient({ type: "phase_update", phase: nextPhase, reason });
  };
  const emitPracticeComplete = (completedPhase: Phase) => {
    if (completedPracticePhases[completedPhase]) return;
    completedPracticePhases[completedPhase] = true;
    sendToClient({ type: "phase_practice_complete", phase: completedPhase });
  };
  const emitHumanTurnReady = (reason: "phase_transition" | "manual_phase" | "server_ready") => {
    console.log(`[SalesFlow] human_turn_ready reason=${reason} phase=${phase}`);
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
      pattern3Section = "opening";
      pattern3FinalQuestionLoopActive = false;
      pattern3ExplicitMandatoryQuestionIds = {};
      pattern3ExplicitExtraQuestionIds = {};
      pendingPattern3AnsweredQuestionId = null;
      pendingPattern3IssuedQuestionId = null;
      pendingSalesReplyQuestionId = null;
      pendingCandidateCompanyQuestionRelay = false;
      candidateCompanyQuestionLoopActive = false;
      askedCandidateCompanyQuestionKeys = {
        foreign_senior: false,
        pre_join_study: false
      };
      lastPattern2QuestionOrigin = null;
    }
    if (phase === "pattern2") {
      introPhase = "sales_intro";
      pattern3Section = "opening";
      pattern3FinalQuestionLoopActive = false;
      pattern3ExplicitMandatoryQuestionIds = {};
      pattern3ExplicitExtraQuestionIds = {};
      pendingPattern3StudentExit = false;
      pendingPattern3ExitApprovalReply = false;
      pendingPattern3AnsweredQuestionId = null;
      pendingPattern3IssuedQuestionId = null;
      pendingSalesReplyQuestionId = null;
      pendingCandidateCompanyQuestionRelay = false;
      candidateCompanyQuestionLoopActive = false;
      askedCandidateCompanyQuestionKeys = {
        foreign_senior: false,
        pre_join_study: false
      };
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
      lastSelectedCandidateQuestionId = null;
      lastCandidateRelayContext = null;
      clearBufferedCandidateTurnFallbacks();
      candidateValidationRetriedForCurrentPrompt = false;
      followUpTopicUsage = {};
      companyGreetingPromptPending = false;
      companyIntroAckPromptPending = false;
      studentIntroApprovalPromptPending = false;
      companyCandidateAckPromptPending = false;
      companyOverviewPromptPending = false;
      studentIntroPromptPending = false;
      interviewerSelfIntroDone = false;
      lastPattern2QuestionOrigin = null;
    }
    if (phase === "pattern3") {
      introPhase = "complete";
      pattern3FinalQuestionLoopActive = false;
      pattern3ExplicitMandatoryQuestionIds = {};
      pattern3ExplicitExtraQuestionIds = {};
      pendingPattern3StudentExit = false;
      pendingPattern3ExitApprovalReply = false;
      pendingPattern3AnsweredQuestionId = null;
      pendingPattern3IssuedQuestionId = null;
      pendingSalesReplyQuestionId = null;
      pendingCandidateCompanyQuestionRelay = false;
      candidateCompanyQuestionLoopActive = false;
      askedCandidateCompanyQuestionKeys = {
        foreign_senior: false,
        pre_join_study: false
      };
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
      lastSelectedCandidateQuestionId = null;
      lastCandidateRelayContext = null;
      bufferedCandidateTurn = null;
      activeBufferedCandidateTurnId = null;
      candidateValidationRetriedForCurrentPrompt = false;
      companyGreetingPromptPending = false;
      companyIntroAckPromptPending = false;
      studentIntroApprovalPromptPending = false;
      companyCandidateAckPromptPending = false;
      companyOverviewPromptPending = false;
      studentIntroPromptPending = false;
      lastPattern2QuestionOrigin = null;
    }
    emitPhaseUpdate(phase, reason);
    sendPhaseContextToCandidate(phase);
    sendPhaseContextToInterviewer(phase);
    sendSessionUpdateToTranscription();
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
        ? "Language level reminder: speak one level above the earlier prototype quality. Use short natural sentences, explain simple reasons briefly, and still remain a non-native speaker."
        : candidateLanguageLevel === "standard"
          ? "Language level reminder: answer simple interview questions in short understandable Japanese, close to the earlier prototype quality."
          : "Language level reminder: stay close to drill level for the whole session. Keep Japanese broken and very short, and do not suddenly sound fluent even when you know the answer.";
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
  "外国人の先輩はいますか？" / "入社前に勉強することはありますか？"
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
  "外国人の先輩はいますか？" / "入社前に勉強することはありますか？".
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
After the company/job explanation, ask only the questions that appear in the selected Part2 interview question plan.
Do not invent off-script questions, and do not deepen candidate answers into a different topic on your own.
When speaking about your company in Japanese, use natural in-company wording like 「当社」「弊社」「当施設」.
Keep Japanese natural and conversational. Avoid mechanical starts like 「承知しました」 unless you are truly responding to a permission or explicit request. Prefer natural transitions such as 「ありがとうございます」「よく分かりました」「なるほど」, and when moving into a detailed explanation, name the topic briefly if it makes the sentence sound more human.
Avoid detailed visa/document discussion while students are present. Those checks belong to pattern3 after the students leave.
If the sales representative asks permission to let the students leave before discussing visa approval likelihood or visa-related details, answer with approval only, such as 「承知しました。それでは、どうぞお声がけください。」. Do not close the meeting and do not tell the students to leave yourself in that turn.
Do not say 「【面接終了】」 in pattern2. The whole meeting ends only in pattern3.`
          : `Phase: pattern3 (post-interview closing with the sales representative).
Students have left. Respond as the hiring company representative.
The sales representative still leads the flow. Do not open with FAQ questions.
First follow the natural closing sequence led by the sales representative:
1. overall impression of the interview,
2. result / next-step coordination,
3. 技人国 visa and career-path explanation,
4. labor conditions notice / contract discussion,
5. required company documents,
6. visa timing and deadline coordination,
7. final closing.
Part3 FAQ questions still exist, but they should be inserted only when they naturally fit the current closing section. Do not start with a question list from the top.
When the sales representative explains something, answer that point first in natural business Japanese. If it is natural for the company side to ask one short follow-up FAQ question in that section, you may ask exactly one.
Do not jump back to candidate questioning. Do not derail into unrelated topics.
Use natural company wording like 「当社」「弊社」「当施設」, not 「今回の職場」.
Keep Japanese natural and businesslike. Avoid mechanical phrasing and avoid stacking acknowledgements.
When the sales rep clearly gives the final closing thanks, end politely with "【面接終了】".`;
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
    markPattern3QuestionTopicsCoveredBySalesText(normalized);

    let forceNextAi: AiKey | null = null;
    let forcedRelayTarget: RelayTarget | null = null;
    let skipCandidateForward = false;
    let skipInterviewerForward = false;
    let suppressAutoAdvance = false;
    let phaseTransitionTriggered = false;
    let interviewClosingTriggered = false;
    let humanTurnReadyReason: "phase_transition" | "server_ready" =
      "phase_transition";
    if (pendingInterruptTarget) {
      forceNextAi = pendingInterruptTarget;
      clearInterruptState();
    }
    if (phase === "pattern3" && pendingPattern3IssuedQuestionId) {
      pendingPattern3AnsweredQuestionId = pendingPattern3IssuedQuestionId;
      forcedRelayTarget = "ai_a";
      console.log(
        `[Pattern3Answer] question=${pendingPattern3IssuedQuestionId} mode=ack_only`
      );
      pendingPattern3IssuedQuestionId = null;
      pendingSalesReplyQuestionId = null;
    } else if (pendingSalesReplyQuestionId) {
      if (phase === "pattern3") {
        pendingPattern3AnsweredQuestionId = pendingSalesReplyQuestionId;
      }
      forcedRelayTarget = "ai_a";
      pendingSalesReplyQuestionId = null;
    }
    if (
      SALES_LED_FLOW &&
      scenarioMode === "unified" &&
      phase === "pattern1" &&
      shouldTransitionToPattern2(normalized)
    ) {
      setPhase("pattern2", "trigger");
      phaseTransitionTriggered = true;
      introPhase = "sales_intro";
      skipCandidateForward = true;
      suppressAutoAdvance = true;
    }
    const pattern2StudentExitExecution =
      SALES_LED_FLOW &&
      scenarioMode === "pattern2" &&
      phase === "pattern2" &&
      pendingPattern2StudentExit &&
      shouldExecutePattern3StudentExit(normalized);
    const pattern3StudentExitExecution =
      SALES_LED_FLOW &&
      scenarioMode === "unified" &&
      phase === "pattern2" &&
      pendingPattern3StudentExit &&
      shouldExecutePattern3StudentExit(normalized);
    const pattern2ClosureApprovalRequest =
      !pattern2StudentExitExecution &&
      !pattern3StudentExitExecution &&
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      (await resolvePattern2ExitApprovalRequest(normalized));
    const pattern3ExitApprovalRequest =
      pattern2ClosureApprovalRequest && scenarioMode === "unified";
    if (pattern2ClosureApprovalRequest) {
      pendingPattern2ClosureExpected = false;
      if (scenarioMode === "unified") {
        pendingPattern3StudentExit = true;
        pendingPattern3ExitApprovalReply = true;
      } else if (scenarioMode === "pattern2") {
        pendingPattern2StudentExit = true;
      }
      forceNextAi = "ai_a";
      forcedRelayTarget = "ai_a";
      pendingInterviewerGuidance =
        "The sales representative is asking permission to conclude the candidate-facing part of the interview and let the student/candidate leave before moving to the next discussion. Reply in one short Japanese line granting permission only, for example 「承知しました。それでは、どうぞお声がけください。」. Do not close the meeting yourself, do not tell the student to leave yourself, and do not start any further explanation yet.";
    }
    if (pattern2StudentExitExecution) {
      pendingPattern2StudentExit = false;
      pendingPattern2ClosureExpected = false;
      interviewClosingTriggered = true;
      forceNextAi = "ai_b";
      forcedRelayTarget = "ai_b";
    }
    const activeSelectedCandidateQuestion = getSelectedCandidateQuestionSpec(
      getSelectedCandidateQuestionIdForPrompting()
    );
    const shouldForceCandidateQuestionRelay =
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      !pattern2ClosureApprovalRequest &&
      !pendingCandidateCompanyQuestionRelay &&
      !isStrongInterviewerQuestionTurnHandoff(normalized) &&
      !looksLikeSalesSupplementForInterviewer(normalized) &&
      !isAcknowledgementOnlyUtterance(normalized) &&
      isQuestionLike(normalized) &&
      !isExplicitInterviewerAddress(normalized) &&
      (isExplicitCandidateAddress(normalized) ||
        ((lastAiSpeaker === "ai_a" || wasLatestCommittedSpeakerInterviewer()) &&
          Boolean(activeSelectedCandidateQuestion)));
    if (shouldForceCandidateQuestionRelay) {
      forceNextAi = "ai_b";
      forcedRelayTarget = "ai_b";
    }
    const shouldForceInterviewerSupplementRelay =
      SALES_LED_FLOW &&
      phase === "pattern2" &&
      !pattern2ClosureApprovalRequest &&
      !pattern2StudentExitExecution &&
      !pattern3StudentExitExecution &&
      !pendingCandidateCompanyQuestionRelay &&
      !isStrongInterviewerQuestionTurnHandoff(normalized) &&
      !isAcknowledgementOnlyUtterance(normalized) &&
      !isQuestionLike(normalized) &&
      (lastAiSpeaker === "ai_b" || wasLatestCommittedSpeakerCandidate()) &&
      looksLikeSalesSupplementForInterviewer(normalized);
    if (shouldForceInterviewerSupplementRelay) {
      forceNextAi = "ai_a";
      forcedRelayTarget = "ai_a";
    }
    if (
      SALES_LED_FLOW &&
      scenarioMode === "unified" &&
      phase === "pattern2" &&
      !pattern2ClosureApprovalRequest &&
      (pattern3StudentExitExecution ||
        (!pattern3ExitApprovalRequest && shouldTransitionToPattern3(normalized)))
    ) {
      setPhase("pattern3", "trigger");
      phaseTransitionTriggered = true;
      pendingPattern2StudentExit = false;
      pendingPattern3StudentExit = false;
      pendingPattern3ExitApprovalReply = false;
      pendingPattern2ClosureExpected = false;
      skipCandidateForward = true;
      suppressAutoAdvance = true;
      if (shouldPromptCompanyResponse(normalized)) {
        suppressAutoAdvance = false;
        forceNextAi = "ai_a";
      }
    }
    if (
      SALES_LED_FLOW &&
      scenarioMode === "pattern2" &&
      phase === "pattern2" &&
      !pattern2StudentExitExecution &&
      !pattern2ClosureApprovalRequest &&
      isPattern2InterviewClosingUtterance(normalized)
    ) {
      interviewClosingTriggered = true;
      forceNextAi = "ai_b";
      forcedRelayTarget = "ai_b";
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
      const pattern3Guidance = await buildPattern3InterviewerGuidance(normalized);
      if (pattern3Guidance) {
        pendingInterviewerGuidance = pattern3Guidance;
      }
    } else if (
      phase === "pattern2" &&
      pendingCandidateCompanyQuestionRelay &&
      resolvedRelayTarget === "ai_a"
    ) {
      pendingInterviewerGuidance =
        buildCandidateCompanyQuestionAnswerGuidance(normalized);
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
    const shouldShowRelayTargetUnclearNotice =
      SALES_LED_FLOW &&
      resolvedRelayTarget === "none" &&
      !phaseTransitionTriggered &&
      !interviewClosingTriggered &&
      forceNextAi === null &&
      (!pendingCandidateRetry || retryRelayDecision?.target === "none");
    if (shouldShowRelayTargetUnclearNotice) {
      sendToClient({ type: "relay_target_unclear", phase });
    }
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
      const followUp = isStrictSelectedQuestionMode()
        ? null
        : buildTopicAwareFollowUpGuidance(
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
      pendingFollowUpContext = null;
    }

    if (SALES_LED_FLOW && !skipCandidateForward && phase !== "pattern3") {
      lastSalesUtterance = normalized;
      if (resolvedRelayTarget === "ai_b") {
        const candidateRelay = await buildCandidateRelayMessage(lastSalesUtterance);
        const selectedQuestionIdForSalesTurn =
          resolveSelectedCandidateQuestionIdForSalesTurn(lastSalesUtterance);
        pendingCandidateResponseMode = candidateRelay.mode;
        lastCandidateRelayContext = {
          salesText: lastSalesUtterance,
          normalizedPrompt: candidateRelay.normalizedPrompt,
          mode: candidateRelay.mode,
          instructions: candidateRelay.instructions,
          selectedQuestionId: selectedQuestionIdForSalesTurn
        };
        candidateValidationRetriedForCurrentPrompt = false;
        if (phase === "pattern1") {
          console.log(
            `[Pattern1Directive] mode=${candidateRelay.mode} text="${lastSalesUtterance}"`
          );
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
    return createRealtimeConnection(() => buildSessionUpdate(getAiProfile(key)), {
      onReady: () => {
        sessionReady[key] = true;
        if (pendingSessionRefresh[key]) {
          pendingSessionRefresh[key] = false;
        }
        console.log(
          `[Sessions] onReady key=${key} pending=${JSON.stringify(
            pendingSessionRefresh
          )} waitingRefresh=${waitingForSessionRefresh}`
        );
        maybeStartPendingSession();
      },
      onAudioDelta: (audioBase64) => {
        const profile = getAiProfile(key);
        if (
          key === "ai_b" &&
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
          key === "ai_b" &&
          bufferedCandidateTurn &&
          bufferedCandidateTurn.turnId === currentTurn[key]
        ) {
          audioDone[key] = true;
          bufferedCandidateTurn.audioDone = true;
          clearBufferedCandidateAudioDoneFallback();
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
        let candidateDeclinedFurtherQuestionsThisTurn = false;
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
          if (phase === "pattern2" && introPhase === "company_overview") {
            finalText = stripQuestionTailFromCompanyOverview(finalText);
          }
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
          const selectedQuestionId = getSelectedCandidateQuestionIdForValidation();
          const isCompanyQuestionLoopValidationContext =
            (selectedQuestionId === "common_last_question" ||
              (candidateCompanyQuestionLoopActive &&
                isCandidateCompanyQuestionLoopPrompt(
                  lastCandidateRelayContext.salesText
                ))) &&
            phase === "pattern2";
          const selectedQuestionProfile = getSelectedCandidateQuestionProfile(
            isCompanyQuestionLoopValidationContext
              ? "common_last_question"
              : selectedQuestionId
          );
          const selectedQuestionAssessment = selectedQuestionProfile
            ? classifyCandidateAnswerBySelectedQuestion(
                isCompanyQuestionLoopValidationContext
                  ? "common_last_question"
                  : selectedQuestionId,
                finalText
              )
            : { assessment: null, confidence: "low" as const };
          const commonLastQuestionRemainingKeys =
            isCompanyQuestionLoopValidationContext
              ? getRemainingCandidateCompanyQuestionOptions().map((option) => option.key)
              : [];
          const matchedCompanyQuestionKey =
            isCompanyQuestionLoopValidationContext
              ? classifyCandidateCompanyQuestionKey(finalText)
              : null;
          const candidateDeclinedCompanyQuestions =
            isCompanyQuestionLoopValidationContext &&
            commonLastQuestionRemainingKeys.length === 0 &&
            /もうない|ありません|ないです|大丈夫です/u.test(normalizeText(finalText));
          const validation =
            isCompanyQuestionLoopValidationContext &&
            matchedCompanyQuestionKey &&
            commonLastQuestionRemainingKeys.includes(matchedCompanyQuestionKey)
              ? {
                  verdict: "accept" as const,
                  confidence: "high" as const
                }
              : candidateDeclinedCompanyQuestions
                ? {
                    verdict: "accept" as const,
                    confidence: "high" as const
                  }
                : selectedQuestionAssessment.assessment === "mismatch"
                  ? {
                      verdict: "retry" as const,
                      confidence: selectedQuestionAssessment.confidence,
                      suggestedMode: "answer_question" as CandidateResponseMode,
                      reason: selectedQuestionProfile
                        ? `The reply did not answer the selected question focus: ${selectedQuestionProfile.focusSummary}`
                        : "The reply did not answer the current question."
                    }
                  : await validateCandidateResponseWithAi({
                      salesText: lastCandidateRelayContext.salesText,
                      normalizedPrompt: lastCandidateRelayContext.normalizedPrompt,
                      mode: responseMode,
                      candidateAnswer: finalText,
                      selectedQuestionId,
                      selectedQuestionFocus:
                        selectedQuestionProfile?.focusSummary ?? null
                    });
          console.log(
            `[CandidateValidate] verdict=${validation.verdict} confidence=${validation.confidence} mode=${responseMode ?? "unknown"} answer="${finalText}"${validation.reason ? ` reason="${validation.reason}"` : ""}`
          );
        if (
            validation.verdict === "retry" &&
            validation.confidence !== "low" &&
            !candidateValidationRetriedForCurrentPrompt
          ) {
            candidateValidationRetriedForCurrentPrompt = true;
            clearBufferedCandidateTurnFallbacks();
            bufferedCandidateTurn = null;
            activeBufferedCandidateTurnId = null;
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
                        text: buildCandidateRetryPromptText({
                          normalizedPrompt: lastCandidateRelayContext.normalizedPrompt,
                          retryMode,
                          rejectedAnswer: finalText,
                          reason: validation.reason,
                          selectedQuestionProfile
                        })
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
              const selectedQuestionRetryHint = getSelectedCandidateQuestionProfile(
                getSelectedCandidateQuestionIdForValidation()
              )?.cueLines[0];
              if (intentMismatch && (activeIntent || selectedQuestionRetryHint)) {
                setScriptHint(
                  `P2ヒント: 候補者が質問意図を取り違えています。${
                    activeIntent
                      ? getIntentRetryHint(activeIntent)
                      : selectedQuestionRetryHint
                  }`
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
            const selectedQuestionIdForValidation =
              getSelectedCandidateQuestionIdForValidation();
            const isCompanyQuestionLoopAnswer =
              (selectedQuestionIdForValidation === "common_last_question" ||
                (candidateCompanyQuestionLoopActive &&
                  lastCandidateRelayContext !== null &&
                  isCandidateCompanyQuestionLoopPrompt(
                    lastCandidateRelayContext.salesText
                  ))) &&
              phase === "pattern2";
            const selectedQuestionProfile = getSelectedCandidateQuestionProfile(
              isCompanyQuestionLoopAnswer
                ? "common_last_question"
                : selectedQuestionIdForValidation
            );
            const askedCompanyQuestionKey = classifyCandidateCompanyQuestionKey(finalText);
            const candidateDeclinedFurtherQuestions =
              isCompanyQuestionLoopAnswer &&
              !pendingCandidateRetry &&
              !askedCompanyQuestionKey &&
              /もうない|ありません|ないです|大丈夫です/u.test(normalizeText(finalText));
            candidateDeclinedFurtherQuestionsThisTurn =
              candidateDeclinedFurtherQuestions;
            const candidateAskedCompanyQuestion =
              !candidateDeclinedFurtherQuestions &&
              (responseMode === "good_question" ||
                Boolean(selectedQuestionProfile?.requiresQuestion));
            if (!pendingCandidateRetry && askedCompanyQuestionKey) {
              askedCandidateCompanyQuestionKeys[askedCompanyQuestionKey] = true;
            }
            if (candidateDeclinedFurtherQuestions) {
              candidateCompanyQuestionLoopActive = false;
              pendingCandidateCompanyQuestionRelay = false;
              pendingPattern2ClosureExpected = true;
            }
            if (!candidateDeclinedFurtherQuestions) {
              pendingCandidateCompanyQuestionRelay =
                !pendingCandidateRetry && candidateAskedCompanyQuestion;
            }
            if (
              !pendingCandidateRetry &&
              candidateAskedCompanyQuestion &&
              !candidateDeclinedFurtherQuestions
            ) {
              candidateCompanyQuestionLoopActive = true;
              pendingPattern2ClosureExpected = false;
            }
            if (isCompanyQuestionLoopAnswer) {
              lastSelectedCandidateQuestionId = null;
              if (lastCandidateRelayContext?.selectedQuestionId === "common_last_question") {
                lastCandidateRelayContext = {
                  ...lastCandidateRelayContext,
                  selectedQuestionId: null
                };
              }
            }
          }
          if (key === "ai_a") {
            pendingCandidateCompanyQuestionRelay = false;
            lastInterviewerQuestionText = finalText;
            const matchedSelectedQuestion = markInterviewerQuestionsAsked(finalText);
            lastSelectedCandidateQuestionId =
              matchedSelectedQuestion?.target === "candidate"
                ? matchedSelectedQuestion.id
                : null;
            if (matchedSelectedQuestion?.id === "common_last_question") {
              candidateCompanyQuestionLoopActive = true;
            }
            const detectedIntent = detectInterviewIntent(finalText);
            lastInterviewerIntent = detectedIntent !== "other" ? detectedIntent : null;
            if (lastInterviewerIntent !== null) {
              if (!matchedSelectedQuestion) {
                lastPattern2QuestionOrigin = "base";
              }
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
          key === "ai_b" &&
          phase === "pattern1" &&
          (
            responseMode === "goodbye" ||
            (isPattern1PracticeClosingPrompt(lastSalesUtterance) &&
              isAcknowledgementOnlyUtterance(finalText))
          )
        ) {
          emitPracticeComplete("pattern1");
        }
        if (
          key === "ai_b" &&
          phase === "pattern2" &&
          !candidateDeclinedFurtherQuestionsThisTurn &&
          (
            responseMode === "goodbye" ||
            (isPattern2InterviewClosingUtterance(lastSalesUtterance) &&
              isAcknowledgementOnlyUtterance(finalText))
          )
        ) {
          emitPracticeComplete("pattern2");
        }
        if (
          key === "ai_b" &&
          scenarioMode === "pattern2" &&
          phase === "pattern2" &&
          !candidateDeclinedFurtherQuestionsThisTurn &&
          (
            responseMode === "goodbye" ||
            (isPattern2InterviewClosingUtterance(lastSalesUtterance) &&
              isAcknowledgementOnlyUtterance(finalText))
          )
        ) {
          endSession("marker");
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
            emitPracticeComplete("pattern3");
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
        } else if (!SALES_LED_FLOW && totalTurns >= MAX_TURNS) {
          endSession("max_turns");
        }
        if (
          key === "ai_b" &&
          bufferedCandidateTurn &&
          bufferedCandidateTurn.turnId === currentTurn[key]
        ) {
          bufferedCandidateTurn.validatedText = finalText;
          if (!bufferedCandidateTurn.audioDone && !audioDone[key]) {
            clearBufferedCandidateAudioDoneFallback();
            bufferedCandidateAudioDoneFallbackTimer = setTimeout(() => {
              if (
                !bufferedCandidateTurn ||
                currentTurn.ai_b !== bufferedCandidateTurn.turnId ||
                bufferedCandidateTurn.audioDone
              ) {
                return;
              }
              audioDone.ai_b = true;
              bufferedCandidateTurn.audioDone = true;
              logEvent("ai_b", "audio_done_fallback");
              flushBufferedCandidateTurn();
            }, BUFFERED_CANDIDATE_AUDIO_DONE_FALLBACK_MS);
          }
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
        handleUserInputTranscriptDone(transcript);
      },
      onInputTranscript: (delta) => {
        if (key !== "ai_a") return;
        handleUserInputTranscriptDelta(delta);
      },
      onError: (error) => {
        console.error(`[OpenAI ${key}] error:`, error.message);
        sendToClient({ type: "error", message: error.message });
      }
    });
  };
  const handleUserInputTranscriptDone = (transcript: string) => {
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
        now - pendingUserCommitAt < USER_TRANSCRIPT_LATE_ACCEPT_MS;
      if (waitingForUserTranscript || isLateButAcceptable) {
        waitingForUserTranscript = false;
        pendingUserCommitAt = 0;
        clearUserTranscriptTimer();
        void handleUserUtteranceReady(normalized);
      }
    }
  };
  const handleUserInputTranscriptDelta = (delta: string) => {
    if (!delta) return;
    liveUserTranscriptBuffer += delta;
    maybeScheduleInterruption(liveUserTranscriptBuffer);
  };
  const createTranscriptionSocket = () => {
    return createRealtimeConnection(() => buildTranscriptionSessionUpdate(), {
      onReady: () => {
        transcriptionSessionReady = true;
        pendingTranscriptionRefresh = false;
        console.log("[Sessions] transcription ready");
        maybeStartPendingSession();
      },
      onAudioDelta: () => {},
      onAudioDone: () => {},
      onTranscriptDelta: () => {},
      onTranscriptDone: () => {},
      onInputTranscriptDone: (transcript) => {
        handleUserInputTranscriptDone(transcript);
      },
      onInputTranscript: (delta) => {
        handleUserInputTranscriptDelta(delta);
      },
      onError: (error) => {
        console.error("[OpenAI transcription] error:", error.message);
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
      activeBufferedCandidateTurnId = currentTurn[key];
    } else if (key === "ai_b") {
      activeBufferedCandidateTurnId = null;
    }
    setTimeout(async () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const activeInterviewerGuidance =
        key === "ai_a" ? pendingInterviewerGuidance : null;
      const activeInterruptPrompt = key === "ai_a" ? pendingInterruptPrompt : null;
      const companyOverviewLeadPrompt =
        key === "ai_a" &&
        phase === "pattern2" &&
        !interviewerSelfIntroDone &&
        (companyOverviewPromptPending || introPhase === "company_overview")
          ? buildInterviewerCompanyOverviewLeadGuidance()
          : null;
      const companyOverviewBodyPrompt =
        key === "ai_a" && companyOverviewPromptPending
          ? buildInterviewerCompanyOverviewBodyGuidance()
          : null;
      const nextSelectedInterviewerQuestion =
        key === "ai_a" &&
        !activeInterviewerGuidance &&
        !activeInterruptPrompt &&
        !companyOverviewLeadPrompt &&
        !companyOverviewBodyPrompt
          ? getNextSelectedInterviewerQuestion()
          : null;
      const activeSelectedQuestionGuidance =
        key === "ai_a" && nextSelectedInterviewerQuestion
          ? buildSelectedInterviewerQuestionGuidance(
              nextSelectedInterviewerQuestion
            )
          : null;
      const shouldSuppressInterviewerPlanner =
        key === "ai_a" &&
        phase === "pattern3" &&
        Boolean(activeInterviewerGuidance);
      const interviewerTurnPlan =
        key === "ai_a" &&
        ENABLE_INTERVIEWER_TURN_PLANNING &&
        !shouldSuppressInterviewerPlanner &&
        !companyOverviewLeadPrompt &&
        !companyOverviewBodyPrompt
          ? await planInterviewerTurnWithAi({
              pendingGuidance: activeInterviewerGuidance,
              interruptPrompt: activeInterruptPrompt,
              companyOverviewLeadPrompt,
              companyOverviewBodyPrompt,
              plannedQuestion: nextSelectedInterviewerQuestion,
              pendingSelectedQuestions: listPendingSelectedInterviewerQuestions(
                phase
              ),
              strictSelectedQuestionMode: isStrictSelectedQuestionMode()
            })
          : null;
      if (key === "ai_a" && pendingPattern3ExitApprovalReply) {
        pendingPattern3ExitApprovalReply = false;
      }
      if (key === "ai_a" && pendingPattern3AnsweredQuestionId) {
        pendingPattern3AnsweredQuestionId = null;
      }
      let candidateTurnPlan: CandidateTurnPlan | null = null;
      if (socket.readyState !== WebSocket.OPEN) return;
      if (key === "ai_a" && activeInterviewerGuidance) {
        pushConversationText("ai_a", activeInterviewerGuidance);
        if (pendingInterviewerGuidance === activeInterviewerGuidance) {
          pendingInterviewerGuidance = null;
        }
      }
      if (key === "ai_a" && companyOverviewLeadPrompt) {
        pushConversationText("ai_a", companyOverviewLeadPrompt);
      }
      if (key === "ai_a" && companyOverviewBodyPrompt) {
        companyOverviewPromptPending = false;
        pushConversationText("ai_a", companyOverviewBodyPrompt);
      }
      if (key === "ai_a" && activeSelectedQuestionGuidance) {
        pushConversationText("ai_a", activeSelectedQuestionGuidance);
      }
      if (key === "ai_b" && studentIntroPromptPending) {
        studentIntroPromptPending = false;
        pendingCandidateResponseMode = "self_intro";
        lastCandidateRelayContext = {
          salesText: lastSalesUtterance || "自己紹介をお願いします。",
          normalizedPrompt: "自己紹介をしてください。",
          mode: "self_intro",
          instructions: buildPhaseAwareDirective("self_intro", phase, false).instructions,
          selectedQuestionId: null
        };
        candidateValidationRetriedForCurrentPrompt = false;
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
      const activeCandidateRelayContext =
        key === "ai_b" && ENABLE_CANDIDATE_TURN_PLANNING
          ? lastCandidateRelayContext
          : null;
      if (activeCandidateRelayContext) {
        candidateTurnPlan = await planCandidateTurnWithAi({
          salesText: activeCandidateRelayContext.salesText,
          normalizedPrompt: activeCandidateRelayContext.normalizedPrompt,
          mode: activeCandidateRelayContext.mode,
          instructions: activeCandidateRelayContext.instructions
        });
        if (socket.readyState !== WebSocket.OPEN) return;
      }
      if (key === "ai_a" && activeInterruptPrompt) {
        pushConversationText("ai_a", activeInterruptPrompt);
        if (pendingInterruptPrompt === activeInterruptPrompt) {
          pendingInterruptPrompt = null;
        }
      }
      if (
        key === "ai_a" &&
        interviewerTurnPlan &&
        (interviewerTurnPlan.confidence === "high" ||
          interviewerTurnPlan.confidence === "medium" ||
          interviewerTurnPlan.exact)
      ) {
        console.log(
          `[InterviewerPlan] confidence=${interviewerTurnPlan.confidence} exact=${interviewerTurnPlan.exact} phase=${phase} introPhase=${introPhase} utterance="${interviewerTurnPlan.utterance}"${interviewerTurnPlan.reason ? ` reason="${interviewerTurnPlan.reason}"` : ""}`
        );
        pushConversationText(
          "ai_a",
          buildInterviewerPlannerPrompt(interviewerTurnPlan)
        );
      }
      if (
        key === "ai_b" &&
        candidateTurnPlan &&
        (candidateTurnPlan.confidence === "high" ||
          candidateTurnPlan.confidence === "medium" ||
          candidateTurnPlan.exact)
      ) {
        console.log(
          `[CandidatePlan] confidence=${candidateTurnPlan.confidence} exact=${candidateTurnPlan.exact} phase=${phase} mode=${activeCandidateRelayContext?.mode ?? pendingCandidateResponseMode ?? "unknown"} utterance="${candidateTurnPlan.utterance}"${candidateTurnPlan.reason ? ` reason="${candidateTurnPlan.reason}"` : ""}`
        );
        pushConversationText("ai_b", buildCandidatePlannerPrompt(candidateTurnPlan));
      }
      socket.send(
        JSON.stringify({
          type: "response.create",
          response: { output_modalities: ["audio"] }
        })
      );
    }, delayMs);
  };

  const checkTurnCompletion = (key: AiKey) => {
    const canSkipPlaybackDone =
      SALES_LED_FLOW &&
      key === "ai_b" &&
      activeBufferedCandidateTurnId === currentTurn[key];
    if (
      !audioDone[key] ||
      !transcriptDone[key] ||
      (!playbackDone[key] && !canSkipPlaybackDone)
    ) {
      return;
    }
    if (sessionEnded) return;
    if (SALES_LED_FLOW) {
      if (userSpeaking) return;
      lastAiSpeaker = key;
      waitingForHuman = true;
      if (pendingDeferredUserUtterance) {
        const deferredUtterance = pendingDeferredUserUtterance;
        pendingDeferredUserUtterance = null;
        queueMicrotask(() => {
          void handleUserUtteranceReady(deferredUtterance);
        });
        return;
      }
      emitHumanTurnReady("server_ready");
      return;
    }

    if (!autoMode || userSpeaking) return;

    const nextKey =
      queuedNextKeys.shift() ?? (key === "ai_a" ? "ai_b" : "ai_a");
    requestAiResponse(nextKey, 450);
  };

  const aiSockets: Record<AiKey, WebSocket> = {
    ai_a: createAiSocket("ai_a"),
    ai_b: createAiSocket("ai_b")
  };
  const transcriptionSocket = PREFER_DEDICATED_TRANSCRIPTION_INPUT
    ? createTranscriptionSocket()
    : null;
  const getActiveTranscriptionSocket = () =>
    aiSockets.ai_a.readyState === WebSocket.OPEN
      ? aiSockets.ai_a
      : PREFER_DEDICATED_TRANSCRIPTION_INPUT &&
          transcriptionSessionReady &&
          transcriptionSocket &&
          transcriptionSocket.readyState === WebSocket.OPEN
        ? transcriptionSocket
        : null;

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
      activeBufferedCandidateTurnId = null;
      clearBufferedCandidateTurnFallbacks();
      lastSelectedCandidateQuestionId = null;
      pendingCandidateCompanyQuestionRelay = false;
      lastCandidateRelayContext = null;
      candidateValidationRetriedForCurrentPrompt = false;
      conversationHistory = [];
      scenarioMode = message.scenario ?? "unified";
      candidateLanguageLevel = message.candidateLevel ?? "basic";
      interviewIndustry = message.industry ?? "construction";
      interviewerSettings = sanitizeInterviewerSettings({
        personality: message.personality,
        literacy: message.literacy,
        dialect: message.dialect,
        difficulty: message.difficulty,
        note: message.note
      });
      pattern3Decision = choosePattern3Decision();
      console.log(`[Pattern3Decision] ${pattern3Decision}`);
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
      followUpTopicUsage = {};
      initializeSelectedInterviewerQuestions();
      pattern3FinalQuestionLoopActive = false;
      pattern3ExplicitMandatoryQuestionIds = {};
      pattern3ExplicitExtraQuestionIds = {};
      completedPracticePhases = {
        pattern1: false,
        pattern2: false,
        pattern3: false
      };
      emitCandidateProfile();
      if (SALES_LED_FLOW) {
        if (scenarioMode === "pattern2") {
          phase = "pattern2";
        } else if (scenarioMode === "pattern3") {
          phase = "pattern3";
        } else {
          phase = "pattern1";
        }
        pattern3Section = "opening";
        pattern3FinalQuestionLoopActive = false;
        pattern3ExplicitExtraQuestionIds = {};
        if (phase === "pattern2") {
          introPhase = "sales_intro";
        } else if (phase === "pattern3") {
          introPhase = "complete";
        } else {
          introPhase = "sales_intro";
        }
        companyGreetingPromptPending = false;
        companyIntroAckPromptPending = false;
        studentIntroApprovalPromptPending = false;
        companyCandidateAckPromptPending = false;
        pendingPattern2StudentExit = false;
        pendingPattern3StudentExit = false;
        pendingPattern3ExitApprovalReply = false;
        pendingPattern2ClosureExpected = false;
        pattern2StartTimingAsked = false;
        pattern2VisaHandoffAsked = false;
        studentIntroPromptPending = false;
      } else {
        phase = "pattern2";
        pattern3Section = "opening";
        pattern3FinalQuestionLoopActive = false;
        pattern3ExplicitExtraQuestionIds = {};
        introPhase = "complete";
        companyGreetingPromptPending = false;
        companyIntroAckPromptPending = false;
        studentIntroApprovalPromptPending = false;
        companyCandidateAckPromptPending = false;
        pendingPattern2StudentExit = false;
        pendingPattern3StudentExit = false;
        pendingPattern3ExitApprovalReply = false;
        pendingPattern2ClosureExpected = false;
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
        console.log("[Sessions] requesting refresh before start");
        sendToClient({ type: "waiting_for_sessions" });
        setScriptHint(getPhaseScriptHint(phase));
        sendSessionUpdateToAi("ai_a");
        sendSessionUpdateToAi("ai_b");
        if (transcriptionSessionReady) {
          pendingTranscriptionRefresh = true;
          sendSessionUpdateToTranscription();
        }
        scheduleSessionRefreshWatchdog("start");
      } else {
        pendingStart = true;
        console.log(
          `[Sessions] start queued until sockets are ready ai_a=${sessionReady.ai_a} ai_b=${sessionReady.ai_b}`
        );
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
      const activeTranscriptionSocket = getActiveTranscriptionSocket();
      if (activeTranscriptionSocket) {
        activeTranscriptionSocket.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: message.data
          })
        );
      }
      return;
    }

    if (message.type === "user_audio_clear") {
      const activeTranscriptionSocket = getActiveTranscriptionSocket();
      if (activeTranscriptionSocket) {
        activeTranscriptionSocket.send(
          JSON.stringify({ type: "input_audio_buffer.clear" })
        );
      }
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
      const activeTranscriptionSocket = getActiveTranscriptionSocket();
      if (activeTranscriptionSocket) {
        activeTranscriptionSocket.send(
          JSON.stringify({ type: "input_audio_buffer.commit" })
        );
      }
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
      }, USER_TRANSCRIPT_TIMEOUT_MS);
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
      if (message.target === "ai_b") {
        clearBufferedCandidatePlaybackDoneFallback();
      }
      logEvent(message.target, "audio_playback_done");
      checkTurnCompletion(message.target);
      return;
    }
  });

  clientSocket.on("close", () => {
    console.log("[Client] WebSocket closed");
    Object.values(aiSockets).forEach((socket) => socket.close());
    transcriptionSocket?.close();
  });

  clientSocket.on("error", (error) => {
    console.error("[Client] WebSocket error:", error);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});

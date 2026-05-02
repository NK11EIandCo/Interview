import type { InterviewIndustry } from "./industry.js";
import type { InterviewDifficulty } from "./interviewerSettings.js";

export type InterviewQuestionPhase = "pattern2" | "pattern3";
export type InterviewQuestionTarget = "candidate" | "sales";
type Pattern3QuestionBucket =
  | "background"
  | "practical"
  | "risk"
  | "process";
export type InterviewQuestionWindow =
  | "candidate_insert"
  | "late_candidate"
  | "pattern3_result_followup"
  | "pattern3_visa"
  | "pattern3_contract"
  | "pattern3_documents"
  | "pattern3_timeline";

export interface InterviewQuestionSpec {
  id: string;
  prompt: string;
  phase: InterviewQuestionPhase;
  target: InterviewQuestionTarget;
  window: InterviewQuestionWindow;
  mandatory: boolean;
  matchKeywords: string[];
  bucket?: Pattern3QuestionBucket;
}

const shuffle = <T>(items: T[]) => {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
};

const PART2_ALWAYS_ASK_QUESTION_IDS = new Set(["common_last_question"]);
const PART2_EXCLUDED_FROM_RANDOM_PLAN_IDS = new Set([
  "common_hard_work",
  "common_last_question"
]);

const COMMON_PATTERN2_QUESTIONS: InterviewQuestionSpec[] = [
  {
    id: "common_japan_duration",
    prompt: "日本でどのくらい働きたいですか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["日本でどのくらい働きたい", "日本でどれくらい働きたい"]
  },
  {
    id: "common_hard_work",
    prompt: "仕事は大変なときもありますが、大丈夫ですか。頑張れますか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["大変なときもあります", "頑張れますか", "大丈夫ですか"]
  },
  {
    id: "common_why_company",
    prompt: "なぜ弊社で働きたいと思いましたか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["なぜ弊社で働きたい", "なぜ弊社", "働きたいと思いましたか"]
  },
  {
    id: "common_work_values",
    prompt: "働くうえで何を大切にしたいですか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["何を大切にしたい", "大切にしたいですか"]
  },
  {
    id: "common_challenge_overcome",
    prompt:
      "日本に来てからや、アルバイトをしている中で大変だったことはありますか。また、それをどのように乗り越えましたか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["大変だったこと", "どうやって乗り越え", "乗り越えましたか"]
  },
  {
    id: "common_busy_time",
    prompt: "忙しいときはどう行動しますか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["忙しいときはどう", "忙しいときはどう行動"]
  },
  {
    id: "common_teamwork",
    prompt: "チームで働くときに大切だと思うことは何ですか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["チームで働くとき", "大切だと思うこと"]
  },
  {
    id: "common_strengths_weaknesses",
    prompt: "あなたの長所と短所を教えてください。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["長所と短所", "長所", "短所"]
  },
  {
    id: "common_when_unsure",
    prompt: "分からないことがあったときはどうしますか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["分からないことがあったとき", "どうしますか"]
  },
  {
    id: "common_biggest_effort",
    prompt: "今までで一番頑張ったことは何ですか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["一番頑張ったこと", "頑張ったことは何"]
  },
  {
    id: "common_hardest_experience",
    prompt: "今までで一番つらかったことは何ですか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["一番つらかったこと", "つらかったことは何"]
  },
  {
    id: "common_future_dream",
    prompt: "将来の夢は何ですか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["将来の夢", "夢は何ですか"]
  },
  {
    id: "common_weekend_holiday",
    prompt: "土日や祝日の勤務は可能ですか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["土日や祝日", "祝日の勤務", "土日の勤務"]
  },
  {
    id: "common_early_or_night",
    prompt: "朝早い仕事や夜勤は可能ですか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["朝早い仕事", "夜勤は可能", "夜勤は大丈夫"]
  },
  {
    id: "common_relocation",
    prompt: "引っ越しは可能ですか。",
    phase: "pattern2",
    target: "candidate",
    window: "candidate_insert",
    mandatory: false,
    matchKeywords: ["引っ越しは可能", "引っ越しできますか"]
  },
  {
    id: "common_last_question",
    prompt: "最後に何か質問はありますか。",
    phase: "pattern2",
    target: "candidate",
    window: "late_candidate",
    mandatory: false,
    matchKeywords: ["最後に何か質問", "何か質問はありますか"]
  }
];

const INDUSTRY_PATTERN2_QUESTIONS: Record<string, InterviewQuestionSpec[]> = {
  food: [
    {
      id: "food_customer_service_experience",
      prompt: "接客の経験はありますか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["接客の経験", "接客経験"]
    },
    {
      id: "food_standing_work",
      prompt: "立ち仕事は大丈夫ですか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["立ち仕事は大丈夫", "立ち仕事"]
    },
    {
      id: "food_struggle_in_japan",
      prompt: "日本に来て苦労したことはありますか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["日本に来て苦労", "苦労したこと"]
    },
    {
      id: "food_mistake_response",
      prompt: "ミスをしたときはどう対応しますか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["ミスをしたとき", "どう対応しますか"]
    }
  ],
  manufacturing: [
    {
      id: "manufacturing_why_this_work",
      prompt: "どうしてこの製造の仕事を選びましたか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["どうしてこの製造", "製造の仕事を選び"]
    },
    {
      id: "manufacturing_physical_work",
      prompt: "体力を使う仕事についてどう思いますか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["体力を使う仕事", "どう思いますか"]
    },
    {
      id: "manufacturing_how_long_continue",
      prompt: "日本でこの仕事をいつまで続けたいですか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["この仕事をいつまで続けたい", "いつまで続けたい"]
    },
    {
      id: "manufacturing_dirty_work",
      prompt: "汚れる仕事は嫌ではありませんか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["汚れる仕事", "嫌ではありませんか"]
    }
  ],
  construction: [
    {
      id: "construction_business_trip",
      prompt: "たまに県外へ出張もありますが、大丈夫ですか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["県外へ出張", "出張もありますが"]
    },
    {
      id: "construction_weather",
      prompt:
        "現場の仕事なので夏は暑く、冬は寒いですが、それでも大丈夫ですか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["夏は暑く", "冬は寒い", "それでも大丈夫"]
    },
    {
      id: "construction_heavy_items",
      prompt: "重いものを持つ仕事もありますが、できますか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["重いものを持つ", "できますか"]
    },
    {
      id: "construction_early_gathering",
      prompt: "朝の集合が早いこともありますが、平気ですか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["朝の集合が早い", "平気ですか"]
    },
    {
      id: "construction_driver_license",
      prompt: "車の免許は持っていますか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["車の免許", "免許は持って"]
    }
  ],
  lodging: [
    {
      id: "lodging_why_japan",
      prompt: "なぜ日本で働きたいと思いましたか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["なぜ日本で働きたい", "日本で働きたいと思い"]
    },
    {
      id: "lodging_failure_response",
      prompt: "失敗したときはどうしますか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["失敗したとき", "どうしますか"]
    },
    {
      id: "lodging_service_struggle",
      prompt:
        "日本でアルバイトをして接客するときに苦労したことはありますか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["接客するときに苦労", "苦労したことはありますか"]
    },
    {
      id: "lodging_customer_mix",
      prompt:
        "日本のお客様と外国人のお客様のどちらにも対応できますか。",
      phase: "pattern2",
      target: "candidate",
      window: "candidate_insert",
      mandatory: false,
      matchKeywords: ["日本のお客様", "外国人のお客様", "どちらにも対応"]
    }
  ]
};

const MANDATORY_PATTERN3_QUESTIONS: InterviewQuestionSpec[] = [
  {
    id: "mandatory_why_free_intro",
    prompt:
      "1点確認ですが、紹介料をいただかずに無料でご紹介いただける理由を、改めて教えていただけますか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_result_followup",
    mandatory: true,
    matchKeywords: ["なぜ無料", "無料でご紹介", "紹介料"]
  },
  {
    id: "mandatory_start_timing",
    prompt:
      "入社時期について確認したいのですが、今回の候補者の方々は、実際にはいつ頃から働き始められる見込みでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_timeline",
    mandatory: true,
    matchKeywords: ["いつ頃から入社", "いつから入社", "入社時期"]
  },
  {
    id: "mandatory_housing_support",
    prompt:
      "住まいについて確認したいのですが、住居は企業側で手配する必要があるのでしょうか。それとも本人が自分で探す形でしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_contract",
    mandatory: true,
    matchKeywords: ["家の手配", "住まい", "住居", "住居のサポート"]
  },
  {
    id: "mandatory_future_fieldwork",
    prompt:
      "将来のキャリアとしては徐々に管理業務も担っていくと思いますが、その場合でも現場業務を続ける形で問題ないのでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_visa",
    mandatory: true,
    matchKeywords: ["将来のキャリア", "現場業務", "管理だけでなく", "管理業務"]
  }
];

const PATTERN3_EXTRA_QUESTIONS: InterviewQuestionSpec[] = [
  {
    id: "pattern3_management_takes_time",
    prompt:
      "1年や2年で管理業務まで任せるのは難しいと思うのですが、その間は現場中心でも問題ないのか、どのように考えればよいでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_visa",
    mandatory: false,
    matchKeywords: ["1年や2年で管理", "管理を任せるのは難しい", "5年くらい"],
    bucket: "background"
  },
  {
    id: "pattern3_driving_license",
    prompt:
      "車の運転が必要な場面もあると思うのですが、外国人の方の免許や運転の扱いはどのようになりますか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_visa",
    mandatory: false,
    matchKeywords: ["車の運転", "免許の扱い", "車の免許"],
    bucket: "practical"
  },
  {
    id: "pattern3_culture_religion_general",
    prompt: "異文化や宗教面で、実務上気をつけることはありますか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_visa",
    mandatory: false,
    matchKeywords: ["異文化", "宗教面", "気をつけること"],
    bucket: "background"
  },
  {
    id: "pattern3_culture_religion_islam",
    prompt: "イスラム教圏の方の場合、お祈りや断食は仕事に影響しますか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_visa",
    mandatory: false,
    matchKeywords: ["イスラム教圏", "お祈りや断食", "断食"],
    bucket: "background"
  },
  {
    id: "pattern3_immigration_visibility",
    prompt:
      "ビザを申請した方が結果的に入社に至らなかった場合、入管から見て企業側に不利にならないのかが少し気になるのですが、その点は大丈夫でしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_timeline",
    mandatory: false,
    matchKeywords: ["入管からの見え方", "入社に至らない", "受け入れ終了届"],
    bucket: "risk"
  },
  {
    id: "pattern3_guarantor",
    prompt:
      "入社や住居の手続きで保証人が必要になる場合、候補者の方に保証人をつけてもらうことは可能でしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_contract",
    mandatory: false,
    matchKeywords: ["保証人", "つけてもらうことはできますか"],
    bucket: "practical"
  },
  {
    id: "pattern3_pre_entry_part_time",
    prompt:
      "ビザがまだ下りる前の段階で、先にアルバイトや研修のような形で入ってもらうことは可能でしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_timeline",
    mandatory: false,
    matchKeywords: ["ビザ交付前", "アルバイトとして", "入社前にアルバイト"],
    bucket: "risk"
  },
  {
    id: "pattern3_trial_period_termination",
    prompt:
      "もし試用期間中に雇用を打ち切る判断になった場合、それは会社都合の退職になるのでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_contract",
    mandatory: false,
    matchKeywords: ["試用期間で雇用", "会社都合の退職", "雇用を打ち切る"],
    bucket: "risk"
  },
  {
    id: "pattern3_second_interview",
    prompt:
      "採用判断の前に、必要であれば二次面接を設定することは可能でしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_result_followup",
    mandatory: false,
    matchKeywords: ["二次面接", "行うことは可能"],
    bucket: "process"
  },
  {
    id: "pattern3_why_japan_work",
    prompt:
      "そもそも候補者の方々は、どのような理由で日本で働くことを希望されているのでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_result_followup",
    mandatory: false,
    matchKeywords: ["なぜ日本で働くことを希望", "なぜ日本で働く"],
    bucket: "background"
  },
  {
    id: "pattern3_community_support",
    prompt:
      "日本で同じ国の方とのつながりやコミュニティのようなものはありますか。孤立してしまわないか少し心配です。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_visa",
    mandatory: false,
    matchKeywords: ["外国人コミュニティ", "孤立しないか", "つながりはありますか"],
    bucket: "background"
  },
  {
    id: "pattern3_marriage_case",
    prompt:
      "日本で働く中で、日本で結婚されるようなケースは実際にあるのでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_visa",
    mandatory: false,
    matchKeywords: ["日本で結婚", "結婚されるケース"],
    bucket: "background"
  },
  {
    id: "pattern3_social_insurance_trial",
    prompt:
      "試用期間中の社会保険については、日本人の採用時と同じように考えればよいのでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_contract",
    mandatory: false,
    matchKeywords: ["試用期間中の社会保険", "社会保険はどのようになりますか"],
    bucket: "risk"
  },
  {
    id: "pattern3_fit_concern",
    prompt:
      "実際に入社してから、会社と本人の相性が合わないということが起きないか不安なのですが、その点はどう考えればよいでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_result_followup",
    mandatory: false,
    matchKeywords: ["合う合わない", "不安もある", "入社してから"],
    bucket: "risk"
  },
  {
    id: "pattern3_rent_payment",
    prompt:
      "住居が決まった場合、家賃の支払いは会社負担になるのか、それとも本人が給与から支払う形になるのでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_contract",
    mandatory: false,
    matchKeywords: ["家賃の支払い", "会社が負担", "給与から支払い"],
    bucket: "practical"
  },
  {
    id: "pattern3_visa_too_many_approvals",
    prompt:
      "想定より多くの方にビザが下りた場合は、採用の進め方としてどのように考えればよいでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_timeline",
    mandatory: false,
    matchKeywords: ["ビザがおり過ぎ", "多めに内定", "ビザがおりた方を採用"],
    bucket: "risk"
  },
  {
    id: "pattern3_leave_japan_after_saving",
    prompt:
      "ある程度稼いだらすぐ母国へ帰ってしまうのではないか、という心配はないのでしょうか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_visa",
    mandatory: false,
    matchKeywords: ["稼いだらすぐに帰って", "心配はありませんか"],
    bucket: "background"
  },
  {
    id: "pattern3_post_interview_flow",
    prompt:
      "面接後は、企業側としてどのような流れで対応していけばよいのか、全体の進め方を教えていただけますか。",
    phase: "pattern3",
    target: "sales",
    window: "pattern3_documents",
    mandatory: false,
    matchKeywords: ["面接後の流れ", "流れを教えて", "必要になってくる会社資料"],
    bucket: "process"
  }
];

const PATTERN3_BUCKET_ORDER: Pattern3QuestionBucket[] = [
  "background",
  "practical",
  "risk",
  "process"
];
const PATTERN3_WINDOW_ORDER: InterviewQuestionWindow[] = [
  "pattern3_result_followup",
  "pattern3_visa",
  "pattern3_contract",
  "pattern3_documents",
  "pattern3_timeline"
];

const normalizeIndustryFamily = (industry: InterviewIndustry) => {
  if (industry === "food") return "food";
  if (industry === "hotel") return "lodging";
  if (industry === "manufacturing") return "manufacturing";
  if (industry === "construction") return "construction";
  return "generic";
};

const buildPattern2Plan = (difficulty: InterviewDifficulty, industry: InterviewIndustry) => {
  const industryFamily = normalizeIndustryFamily(industry);
  const industryQuestions =
    industryFamily === "generic"
      ? []
      : INDUSTRY_PATTERN2_QUESTIONS[industryFamily] ?? [];
  const commonQuestions = COMMON_PATTERN2_QUESTIONS.filter(
    (question) => !PART2_EXCLUDED_FROM_RANDOM_PLAN_IDS.has(question.id)
  );
  const guaranteedLateQuestions = COMMON_PATTERN2_QUESTIONS.filter((question) =>
    PART2_ALWAYS_ASK_QUESTION_IDS.has(question.id)
  );

  if (difficulty === "easy") {
    const selectedIndustry = shuffle(industryQuestions).slice(
      0,
      Math.min(1, industryQuestions.length)
    );
    const selectedIndustryIds = new Set(selectedIndustry.map((question) => question.id));
    const selectedCommon = shuffle(
      commonQuestions.filter((question) => !selectedIndustryIds.has(question.id))
    ).slice(0, Math.max(0, 3 - selectedIndustry.length));

    return [...shuffle([...selectedIndustry, ...selectedCommon]), ...guaranteedLateQuestions];
  }

  const guaranteedIndustryCount = Math.min(2, industryQuestions.length, 5);
  const selectedIndustry = shuffle(industryQuestions).slice(0, guaranteedIndustryCount);
  const selectedIndustryIds = new Set(selectedIndustry.map((question) => question.id));
  const selectedCommon = shuffle(
    commonQuestions.filter((question) => !selectedIndustryIds.has(question.id))
  ).slice(0, Math.max(0, 5 - selectedIndustry.length));

  return [...shuffle([...selectedIndustry, ...selectedCommon]).slice(0, 5), ...guaranteedLateQuestions];
};

const buildPattern3Plan = (difficulty: InterviewDifficulty) => {
  if (difficulty === "easy") {
    return [...MANDATORY_PATTERN3_QUESTIONS];
  }

  const selectedExtras = shuffle(PATTERN3_EXTRA_QUESTIONS).slice(0, 5);
  const sortedExtras = [...selectedExtras].sort((left, right) => {
    const leftWindowIndex = PATTERN3_WINDOW_ORDER.indexOf(left.window);
    const rightWindowIndex = PATTERN3_WINDOW_ORDER.indexOf(right.window);
    if (leftWindowIndex !== rightWindowIndex) {
      return leftWindowIndex - rightWindowIndex;
    }
    const leftBucketIndex = PATTERN3_BUCKET_ORDER.indexOf(left.bucket ?? "process");
    const rightBucketIndex = PATTERN3_BUCKET_ORDER.indexOf(right.bucket ?? "process");
    if (leftBucketIndex !== rightBucketIndex) {
      return leftBucketIndex - rightBucketIndex;
    }
    return PATTERN3_EXTRA_QUESTIONS.findIndex((question) => question.id === left.id) -
      PATTERN3_EXTRA_QUESTIONS.findIndex((question) => question.id === right.id);
  });
  return [...MANDATORY_PATTERN3_QUESTIONS, ...sortedExtras];
};

export const buildSelectedInterviewerQuestionPlan = (
  difficulty: InterviewDifficulty,
  industry: InterviewIndustry
) => ({
  pattern2: buildPattern2Plan(difficulty, industry),
  pattern3: buildPattern3Plan(difficulty)
});

export const matchesInterviewQuestionSpec = (
  spec: InterviewQuestionSpec,
  text: string
) => {
  const normalized = text.replace(/\s+/g, "");
  return spec.matchKeywords.some((keyword) =>
    normalized.includes(keyword.replace(/\s+/g, ""))
  );
};

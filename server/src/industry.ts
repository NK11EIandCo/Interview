export type InterviewIndustry = "care" | "restaurant" | "hotel";

export interface CandidateProfile {
  name: string;
  nationality: string;
  targetRole: string;
  experience: string[];
  strengths: string[];
  note?: string;
}

export interface IndustryScenario {
  id: InterviewIndustry;
  label: string;
  interviewerRole: string;
  interviewerCompanyContext: string;
  companyOverviewGuidance: string;
  candidateBackgroundContext: string;
  candidateSelfIntroExample: string;
  candidateProfile: CandidateProfile;
  introKeywords: string[];
  experienceKeywords: string[];
  experienceRetryHint: string;
  experienceFollowUpPrompt: string;
  experienceTopics: IndustryFollowUpTopicSpec[];
}

export interface IndustryFollowUpTopicSpec {
  key: string;
  label: string;
  keywords: string[];
  followUpPrompts: string[];
}

const INDUSTRY_SCENARIOS: Record<InterviewIndustry, IndustryScenario> = {
  care: {
    id: "care",
    label: "介護",
    interviewerRole: "hiring manager at a Japanese care facility",
    interviewerCompanyContext:
      "Your company is a Japanese care facility. Typical duties include daily living support, meal assistance, bathing support, mobility support, recreation support, and watching over elderly residents.",
    companyOverviewGuidance:
      "Describe the role as caregiving support for elderly residents, including daily living support, meal assistance, bathing support, mobility support, and teamwork on site.",
    candidateBackgroundContext:
      "Your default background: from the Philippines, with a little helper experience in a caregiving facility. You have mainly helped with meals and watching over residents.",
    candidateSelfIntroExample:
      "ジョンです。フィリピン出身。介護の仕事、少し経験あります。",
    candidateProfile: {
      name: "ジョン",
      nationality: "フィリピン",
      targetRole: "介護スタッフ候補",
      experience: [
        "介護施設で食事介助と見守りの補助を少し経験",
        "高齢者の方への声かけや簡単なサポートを担当"
      ],
      strengths: [
        "人助けへの意欲が強い",
        "毎日少しずつ日本語を勉強している"
      ]
    },
    introKeywords: ["介護", "施設", "補助", "食事", "見守り"],
    experienceKeywords: [
      "食事",
      "入浴",
      "排泄",
      "介護",
      "見守り",
      "補助",
      "手伝い",
      "レク",
      "移乗"
    ],
    experienceRetryHint:
      "今はこれまでの具体的な仕事や介護内容を、食事・入浴・排泄・見守りなど短い言葉で答えてください。",
    experienceFollowUpPrompt:
      "Ask one short Japanese follow-up about specific care tasks such as 食事介助・入浴介助・排泄介助・見守り before moving on.",
    experienceTopics: [
      {
        key: "meal_support",
        label: "食事介助",
        keywords: ["食事", "配膳", "食べ", "食事介助"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what they specifically did during meal assistance.",
          "Ask one short Japanese follow-up about how they supported residents at mealtime."
        ]
      },
      {
        key: "bathing_support",
        label: "入浴介助",
        keywords: ["入浴", "お風呂", "清拭"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what kind of bathing support they handled.",
          "Ask one short Japanese follow-up about their role during bathing assistance."
        ]
      },
      {
        key: "toileting_support",
        label: "排泄介助",
        keywords: ["排泄", "トイレ", "おむつ"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what kind of toileting support they handled.",
          "Ask one short Japanese follow-up about their experience helping residents with toilet-related support."
        ]
      },
      {
        key: "monitoring",
        label: "見守り",
        keywords: ["見守り", "声かけ", "巡回"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about how they did monitoring or voice support for residents.",
          "Ask one short Japanese follow-up about what they paid attention to during resident monitoring."
        ]
      },
      {
        key: "recreation",
        label: "レクリエーション",
        keywords: ["レク", "レクリエーション", "体操", "イベント"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about their role in recreation or activity support.",
          "Ask one short Japanese follow-up about what kind of recreation help they have done."
        ]
      }
    ]
  },
  restaurant: {
    id: "restaurant",
    label: "外食",
    interviewerRole: "hiring manager at a Japanese restaurant company",
    interviewerCompanyContext:
      "Your company runs restaurants in Japan. Typical duties include hall service, taking orders, serving food and drinks, simple food preparation, cleaning, and busy-hour teamwork.",
    companyOverviewGuidance:
      "Describe the role as restaurant floor and store support work, including customer service, order taking, serving meals, simple preparation, cleaning, and teamwork during busy hours.",
    candidateBackgroundContext:
      "Your default background: from the Philippines, with some experience at a casual restaurant. You have helped with hall service, clearing tables, and simple plating support.",
    candidateSelfIntroExample:
      "マリアです。フィリピン出身。飲食の仕事、少し経験あります。",
    candidateProfile: {
      name: "マリア",
      nationality: "フィリピン",
      targetRole: "外食店舗スタッフ候補",
      experience: [
        "カジュアルレストランでホール接客と簡単な盛り付け補助を経験",
        "忙しい時間帯の案内や片付けも担当"
      ],
      strengths: [
        "明るい接客を意識している",
        "立ち仕事や忙しい時間帯にも前向き"
      ]
    },
    introKeywords: ["レストラン", "接客", "ホール", "盛り付け", "片付け"],
    experienceKeywords: [
      "接客",
      "ホール",
      "配膳",
      "注文",
      "レジ",
      "盛り付け",
      "片付け",
      "案内",
      "清掃"
    ],
    experienceRetryHint:
      "今はこれまでの飲食店での仕事を、接客・配膳・注文・盛り付け・片付けなど短い言葉で答えてください。",
    experienceFollowUpPrompt:
      "Ask one short Japanese follow-up about specific restaurant tasks such as 接客・配膳・注文対応・盛り付け・片付け before moving on.",
    experienceTopics: [
      {
        key: "customer_service",
        label: "接客",
        keywords: ["接客", "案内", "お客様", "ホール"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what kind of customer service they handled.",
          "Ask one short Japanese follow-up about how they interacted with customers on the floor."
        ]
      },
      {
        key: "order_taking",
        label: "注文対応",
        keywords: ["注文", "オーダー", "ハンディ", "レジ"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about taking orders or handling checkout.",
          "Ask one short Japanese follow-up about how they handled customer orders."
        ]
      },
      {
        key: "serving",
        label: "配膳",
        keywords: ["配膳", "料理", "ドリンク", "運ぶ"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about serving food or drinks.",
          "Ask one short Japanese follow-up about what they actually did when serving customers."
        ]
      },
      {
        key: "plating",
        label: "盛り付け",
        keywords: ["盛り付け", "仕込み", "簡単な調理", "キッチン"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about simple kitchen prep or plating support.",
          "Ask one short Japanese follow-up about what kind of back-of-house support they did."
        ]
      },
      {
        key: "cleanup",
        label: "片付け・清掃",
        keywords: ["片付け", "清掃", "下げ", "洗い場"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about cleanup or table clearing work.",
          "Ask one short Japanese follow-up about what they handled during store cleanup."
        ]
      }
    ]
  },
  hotel: {
    id: "hotel",
    label: "ホテル",
    interviewerRole: "hiring manager at a Japanese hotel company",
    interviewerCompanyContext:
      "Your company operates hotels in Japan. Typical duties include front desk support, guest guidance, room checks, cleaning support, breakfast service support, and teamwork with hospitality staff.",
    companyOverviewGuidance:
      "Describe the role as hotel operations support, including guest guidance, front desk assistance, room checks, cleaning support, breakfast support, and careful customer service.",
    candidateBackgroundContext:
      "Your default background: from Vietnam, with some experience at a business hotel. You have helped with room checks, cleaning support, and simple front desk guidance.",
    candidateSelfIntroExample:
      "リンです。ベトナム出身。ホテルの仕事、少し経験あります。",
    candidateProfile: {
      name: "リン",
      nationality: "ベトナム",
      targetRole: "ホテルスタッフ候補",
      experience: [
        "ビジネスホテルで客室チェックと清掃補助を経験",
        "フロント補助や館内案内も少し担当"
      ],
      strengths: [
        "丁寧な接客を意識している",
        "清潔さと時間管理を大切にしている"
      ]
    },
    introKeywords: ["ホテル", "補助", "客室", "清掃", "フロント"],
    experienceKeywords: [
      "ホテル",
      "客室",
      "清掃",
      "フロント",
      "案内",
      "朝食",
      "チェック",
      "受付",
      "補助"
    ],
    experienceRetryHint:
      "今はこれまでのホテルでの仕事を、フロント補助・客室チェック・清掃補助・館内案内など短い言葉で答えてください。",
    experienceFollowUpPrompt:
      "Ask one short Japanese follow-up about specific hotel tasks such as フロント補助・客室チェック・清掃補助・館内案内 before moving on.",
    experienceTopics: [
      {
        key: "front_desk",
        label: "フロント補助",
        keywords: ["フロント", "受付", "チェックイン", "チェックアウト"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what they did at the front desk.",
          "Ask one short Japanese follow-up about how they supported reception work."
        ]
      },
      {
        key: "room_check",
        label: "客室チェック",
        keywords: ["客室", "ルーム", "チェック", "確認"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about room checks or inspection work.",
          "Ask one short Japanese follow-up about what they checked in guest rooms."
        ]
      },
      {
        key: "cleaning_support",
        label: "清掃補助",
        keywords: ["清掃", "ベッドメイク", "掃除"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about cleaning support or room preparation.",
          "Ask one short Japanese follow-up about their role in cleaning or bed-making."
        ]
      },
      {
        key: "guest_guidance",
        label: "館内案内",
        keywords: ["案内", "お客様", "館内", "接客"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about how they guided guests or explained facilities.",
          "Ask one short Japanese follow-up about guest support or hospitality work they handled."
        ]
      },
      {
        key: "breakfast_support",
        label: "朝食対応",
        keywords: ["朝食", "配膳", "レストラン", "サービス"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about breakfast service support.",
          "Ask one short Japanese follow-up about what they did during breakfast operations."
        ]
      }
    ]
  }
};

export const getIndustryScenario = (
  industry: InterviewIndustry = "care"
) => INDUSTRY_SCENARIOS[industry];

export const getIndustryLabel = (industry: InterviewIndustry) =>
  INDUSTRY_SCENARIOS[industry].label;

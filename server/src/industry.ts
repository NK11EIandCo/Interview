export type InterviewIndustry =
  | "construction"
  | "food"
  | "manufacturing"
  | "lodging"
  | "restaurant"
  | "hotel"
  | "care";

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
  candidateExperienceQuestionPrompt: string;
  pattern3CareerPathExample: string;
  experienceTopics: IndustryFollowUpTopicSpec[];
}

export interface IndustryFollowUpTopicSpec {
  key: string;
  label: string;
  keywords: string[];
  followUpPrompts: string[];
}

const INDUSTRY_SCENARIOS: Record<InterviewIndustry, IndustryScenario> = {
  construction: {
    id: "construction",
    label: "建築",
    interviewerRole: "hiring manager at a Japanese construction company",
    interviewerCompanyContext:
      "Your company runs Japanese construction-site operations. Typical duties include carrying materials, preparing tools, site cleanup, assisting senior workers, following safety rules, and working outdoors with a team.",
    companyOverviewGuidance:
      "Describe the role as construction-site support work, including material carrying, tool preparation, cleanup, outdoor teamwork, early gathering, and practical safety awareness.",
    candidateBackgroundContext:
      "Your default background: from Vietnam, with some helper experience at building sites. You have mainly helped with carrying materials, cleanup, and preparing tools.",
    candidateSelfIntroExample:
      "ジョンです。ベトナム出身。建築の仕事、少し経験あります。",
    candidateProfile: {
      name: "ジョン",
      nationality: "ベトナム",
      targetRole: "建築現場スタッフ候補",
      experience: [
        "建築現場で資材運搬と片付け補助を経験",
        "朝の集合や屋外作業にも対応してきた"
      ],
      strengths: ["体力に自信がある", "暑さ寒さがあっても前向きに働ける"]
    },
    introKeywords: ["建築", "現場", "資材", "運搬", "工具"],
    experienceKeywords: [
      "建築",
      "現場",
      "資材",
      "運搬",
      "片付け",
      "清掃",
      "工具",
      "搬入",
      "外作業",
      "測量"
    ],
    experienceRetryHint:
      "今はこれまでの建築現場での仕事を、資材運搬・片付け・清掃・工具準備など短い言葉で答えてください。",
    experienceFollowUpPrompt:
      "Ask one short Japanese follow-up about specific construction-site tasks such as 資材運搬・片付け・清掃・工具準備・搬入 before moving on.",
    candidateExperienceQuestionPrompt:
      "これまで建築現場でどのような仕事をしましたか",
    pattern3CareerPathExample:
      "将来的には、現場を理解したうえで、外国人スタッフの指導、安全確認、工程管理の補助なども任せていくイメージです。",
    experienceTopics: [
      {
        key: "material_carrying",
        label: "資材運搬",
        keywords: ["資材", "運搬", "運ぶ", "搬入"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what kind of materials they carried.",
          "Ask one short Japanese follow-up about how they supported material carrying or delivery on site."
        ]
      },
      {
        key: "tool_preparation",
        label: "工具準備",
        keywords: ["工具", "準備", "片付け", "道具"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what tools they prepared or cleaned up.",
          "Ask one short Japanese follow-up about their role in tool preparation before work."
        ]
      },
      {
        key: "site_cleanup",
        label: "現場清掃",
        keywords: ["清掃", "掃除", "片付け", "現場"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what kind of cleanup they handled on site.",
          "Ask one short Japanese follow-up about how they kept the site safe and clean."
        ]
      },
      {
        key: "outdoor_work",
        label: "屋外作業",
        keywords: ["外", "屋外", "暑い", "寒い"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about how they handled outdoor work in different weather.",
          "Ask one short Japanese follow-up about whether they have experience working outside for long hours."
        ]
      },
      {
        key: "safety_rules",
        label: "安全意識",
        keywords: ["安全", "ルール", "危ない", "確認"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what safety points they paid attention to on site.",
          "Ask one short Japanese follow-up about how they followed safety rules during construction work."
        ]
      }
    ]
  },
  food: {
    id: "food",
    label: "飲食",
    interviewerRole: "hiring manager at a Japanese food-service company",
    interviewerCompanyContext:
      "Your company runs food-service operations in Japan. Typical duties include customer service, taking orders, serving food and drinks, simple kitchen support, cleanup, and teamwork during busy hours.",
    companyOverviewGuidance:
      "Describe the role as food-service support work, including customer service, order taking, serving meals, simple preparation, cleaning, and teamwork during busy periods.",
    candidateBackgroundContext:
      "Your default background: from the Philippines, with some experience at a casual food-service workplace. You have helped with hall service, clearing tables, and simple plating support.",
    candidateSelfIntroExample:
      "マリアです。フィリピン出身。飲食の仕事、少し経験あります。",
    candidateProfile: {
      name: "マリア",
      nationality: "フィリピン",
      targetRole: "飲食スタッフ候補",
      experience: [
        "飲食店でホール接客と簡単な盛り付け補助を経験",
        "忙しい時間帯の案内や片付けも担当"
      ],
      strengths: ["明るい接客を意識している", "立ち仕事や忙しい時間帯にも前向き"]
    },
    introKeywords: ["飲食", "接客", "ホール", "盛り付け", "片付け"],
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
      "Ask one short Japanese follow-up about specific food-service tasks such as 接客・配膳・注文対応・盛り付け・片付け before moving on.",
    candidateExperienceQuestionPrompt:
      "これまで飲食店でどのような仕事をしましたか",
    pattern3CareerPathExample:
      "将来的には、外国人スタッフの指導、シフト作成補助、在庫管理、衛生管理などを任せていくイメージです。",
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
  manufacturing: {
    id: "manufacturing",
    label: "製造",
    interviewerRole: "hiring manager at a Japanese manufacturing company",
    interviewerCompanyContext:
      "Your company runs manufacturing-site operations in Japan. Typical duties include line work, simple machine support, inspection, packing, sorting, cleaning, and following safety and quality rules.",
    companyOverviewGuidance:
      "Describe the role as factory or manufacturing support work, including line work, inspection, packing, machine support, cleaning, and teamwork under production rules.",
    candidateBackgroundContext:
      "Your default background: from Myanmar, with some experience at a factory. You have mainly helped with inspection, sorting, packing, and keeping the line area clean.",
    candidateSelfIntroExample:
      "アウンです。ミャンマー出身。製造の仕事、少し経験あります。",
    candidateProfile: {
      name: "アウン",
      nationality: "ミャンマー",
      targetRole: "製造スタッフ候補",
      experience: [
        "工場で検品、仕分け、梱包の補助を経験",
        "立ち仕事とルールに沿った作業に慣れている"
      ],
      strengths: ["細かい確認を丁寧に行える", "単調な作業でも集中して続けられる"]
    },
    introKeywords: ["製造", "工場", "検品", "梱包", "仕分け"],
    experienceKeywords: [
      "製造",
      "工場",
      "検品",
      "梱包",
      "仕分け",
      "ライン",
      "組立",
      "機械",
      "清掃"
    ],
    experienceRetryHint:
      "今はこれまでの製造や工場での仕事を、検品・梱包・仕分け・ライン作業など短い言葉で答えてください。",
    experienceFollowUpPrompt:
      "Ask one short Japanese follow-up about specific manufacturing tasks such as 検品・梱包・仕分け・ライン作業・機械補助 before moving on.",
    candidateExperienceQuestionPrompt:
      "これまで工場や製造現場でどのような仕事をしましたか",
    pattern3CareerPathExample:
      "将来的には、ラインリーダーの補助、品質確認、在庫や工程の管理補助などを任せていくイメージです。",
    experienceTopics: [
      {
        key: "inspection",
        label: "検品",
        keywords: ["検品", "確認", "傷", "不良"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what points they checked during inspection work.",
          "Ask one short Japanese follow-up about how they handled quality checks."
        ]
      },
      {
        key: "packing",
        label: "梱包",
        keywords: ["梱包", "箱", "詰める", "包装"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what kind of packing work they handled.",
          "Ask one short Japanese follow-up about how they packed products safely and neatly."
        ]
      },
      {
        key: "sorting",
        label: "仕分け",
        keywords: ["仕分け", "分ける", "分類", "並べる"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what they sorted and how.",
          "Ask one short Japanese follow-up about their role in sorting or organizing products."
        ]
      },
      {
        key: "line_work",
        label: "ライン作業",
        keywords: ["ライン", "流れ", "組立", "作業"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what they did on the production line.",
          "Ask one short Japanese follow-up about how they kept up with line-speed work."
        ]
      },
      {
        key: "machine_support",
        label: "機械補助",
        keywords: ["機械", "ボタン", "操作", "補助"],
        followUpPrompts: [
          "Ask one short Japanese follow-up about what kind of machine support they handled.",
          "Ask one short Japanese follow-up about whether they have experience assisting simple machine operations."
        ]
      }
    ]
  },
  lodging: {
    id: "lodging",
    label: "宿泊",
    interviewerRole: "hiring manager at a Japanese lodging company",
    interviewerCompanyContext:
      "Your company runs lodging and hospitality operations in Japan. Typical duties include guest guidance, front desk support, room checks, cleaning support, breakfast service support, and teamwork with hospitality staff.",
    companyOverviewGuidance:
      "Describe the role as lodging or hospitality support work, including guest guidance, front desk assistance, room checks, cleaning support, breakfast support, and careful customer service.",
    candidateBackgroundContext:
      "Your default background: from Vietnam, with some experience at a lodging or hospitality workplace. You have helped with room checks, cleaning support, and simple guest guidance.",
    candidateSelfIntroExample:
      "リンです。ベトナム出身。宿泊の仕事、少し経験あります。",
    candidateProfile: {
      name: "リン",
      nationality: "ベトナム",
      targetRole: "宿泊スタッフ候補",
      experience: [
        "宿泊施設で客室チェックと清掃補助を経験",
        "フロント補助や館内案内も少し担当"
      ],
      strengths: ["丁寧な接客を意識している", "清潔さと時間管理を大切にしている"]
    },
    introKeywords: ["宿泊", "補助", "客室", "清掃", "フロント"],
    experienceKeywords: [
      "宿泊",
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
      "今はこれまでの宿泊施設での仕事を、フロント補助・客室チェック・清掃補助・館内案内など短い言葉で答えてください。",
    experienceFollowUpPrompt:
      "Ask one short Japanese follow-up about specific lodging tasks such as フロント補助・客室チェック・清掃補助・館内案内 before moving on.",
    candidateExperienceQuestionPrompt:
      "これまで宿泊施設でどのような仕事をしましたか",
    pattern3CareerPathExample:
      "将来的には、外国人スタッフの教育、客室やフロントのシフト調整、備品在庫管理、サービス品質の確認などを任せていくイメージです。",
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
      "マリアです。フィリピン出身。外食の仕事、少し経験あります。",
    candidateProfile: {
      name: "マリア",
      nationality: "フィリピン",
      targetRole: "外食店舗スタッフ候補",
      experience: [
        "カジュアルレストランでホール接客と簡単な盛り付け補助を経験",
        "忙しい時間帯の案内や片付けも担当"
      ],
      strengths: ["明るい接客を意識している", "立ち仕事や忙しい時間帯にも前向き"]
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
      "今はこれまでの外食店での仕事を、接客・配膳・注文・盛り付け・片付けなど短い言葉で答えてください。",
    experienceFollowUpPrompt:
      "Ask one short Japanese follow-up about specific restaurant tasks such as 接客・配膳・注文対応・盛り付け・片付け before moving on.",
    candidateExperienceQuestionPrompt:
      "これまで外食店でどのような仕事をしましたか",
    pattern3CareerPathExample:
      "将来的には、外国人スタッフの指導、シフト作成補助、在庫管理、衛生管理などを任せていくイメージです。",
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
      strengths: ["丁寧な接客を意識している", "清潔さと時間管理を大切にしている"]
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
    candidateExperienceQuestionPrompt:
      "これまでホテルでどのような仕事をしましたか",
    pattern3CareerPathExample:
      "将来的には、外国人スタッフの教育、客室やフロントのシフト調整、備品在庫管理、サービス品質の確認などを任せていくイメージです。",
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
  },
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
      strengths: ["人助けへの意欲が強い", "毎日少しずつ日本語を勉強している"]
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
    candidateExperienceQuestionPrompt:
      "これまでどのような介護の補助をしましたか",
    pattern3CareerPathExample:
      "将来的には、外国人スタッフの指導、シフト管理、在庫管理、衛生管理などの管理業務も任せていくイメージです。",
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
  }
};

export const getIndustryScenario = (
  industry: InterviewIndustry = "construction"
) => INDUSTRY_SCENARIOS[industry];

export const getIndustryLabel = (industry: InterviewIndustry) =>
  INDUSTRY_SCENARIOS[industry].label;

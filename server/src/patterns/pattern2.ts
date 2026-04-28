import {
  createCandidateConfig,
  type CandidateLanguageLevel
} from "../prompts/candidate.js";
import { createInterviewerConfig } from "../prompts/interviewer.js";
import type { InterviewIndustry } from "../industry.js";
import type { InterviewerSettings } from "../interviewerSettings.js";

export const createPattern2InterviewerConfig = (
  industry: InterviewIndustry = "construction",
  settings?: InterviewerSettings
) => createInterviewerConfig(industry, settings);

export const createPattern2StudentConfig = (
  level: CandidateLanguageLevel = "basic",
  industry: InterviewIndustry = "construction"
) => createCandidateConfig(level, industry);

import { createCandidateConfig } from "../prompts/candidate.js";
import { createInterviewerConfig } from "../prompts/interviewer.js";

export const createPattern2InterviewerConfig = () => createInterviewerConfig();

export const createPattern2StudentConfig = () => createCandidateConfig();

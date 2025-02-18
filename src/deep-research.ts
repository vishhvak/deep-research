import { generateObject } from 'ai';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';

import { o3MiniModel, trimPrompt } from './ai/providers';
import { systemPrompt } from './prompt';
import { OutputManager } from './output-manager';
import { researchTools, AgentResponse } from './tools';

// Initialize output manager for coordinated console/progress output
const output = new OutputManager();

// Replace console.log with output.log
function log(...args: any[]) {
  output.log(...args);
}

export type ResearchProgress = {
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  currentQuery?: string;
  totalQueries: number;
  completedQueries: number;
};

type ResearchResult = {
  learnings: string[];
  sources: string[];
  compliance_scores?: string[];
};

// increase this if you have higher API rate limits
const ConcurrencyLimit = 2;

// Determine which tool to use based on the query
async function determineResearchTool(query: string) {
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following research query, determine which research tool would be most appropriate. Here are the available tools and their purposes:
    
    ${Object.entries(researchTools)
      .map(([name, tool]) => `${name}: ${tool.description}`)
      .join('\n')}
    
    Query: ${query}
    
    Return the name of the most appropriate tool.`,
    schema: z.object({
      toolName: z.string().describe('The name of the most appropriate research tool'),
      reason: z.string().describe('Why this tool is most appropriate for the query'),
    }),
  });

  const toolName = res.object.toolName as keyof typeof researchTools;
  return {
    tool: researchTools[toolName],
    reason: res.object.reason
  };
}

async function generateFollowUpQuestions({
  query,
  toolDescription,
  numQuestions = 3,
  previousLearnings = [],
}: {
  query: string;
  toolDescription: string;
  numQuestions?: number;
  previousLearnings?: string[];
}) {
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following research topic and tool description, generate specific follow-up questions that are appropriate for this type of research. Tool: ${toolDescription}\n\nTopic: ${query}\n\n${
      previousLearnings.length > 0
        ? `Previous learnings:\n${previousLearnings.join('\n')}`
        : ''
    }`,
    schema: z.object({
      questions: z
        .array(
          z.object({
            question: z.string().describe('The follow-up question'),
            rationale: z
              .string()
              .describe('Why this question is important for this type of research'),
          }),
        )
        .describe(`List of follow-up questions, max of ${numQuestions}`),
    }),
  });
  
  return res.object.questions.slice(0, numQuestions);
}

async function processAgentResponse({
  response,
  numLearnings = 3,
}: {
  response: AgentResponse;
  numLearnings?: number;
}) {
  return {
    learnings: [response.content],
    sources: response.source?.map(s => `${s.file_name} (${s.file_path})`) || [],
    compliance_score: response.compliance_score
  };
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  sources = [],
  onProgress,
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  sources?: string[];
  onProgress?: (progress: ResearchProgress) => void;
}): Promise<ResearchResult> {
  const progress: ResearchProgress = {
    currentDepth: depth,
    totalDepth: depth,
    currentBreadth: breadth,
    totalBreadth: breadth,
    totalQueries: 0,
    completedQueries: 0,
  };
  
  // Determine which research tool to use
  const { tool, reason } = await determineResearchTool(query);
  log(`Using ${tool.name} for research: ${reason}`);
  
  const reportProgress = (update: Partial<ResearchProgress>) => {
    Object.assign(progress, update);
    onProgress?.(progress);
  };

  // Generate follow-up questions appropriate for the selected tool
  const followUpQuestions = await generateFollowUpQuestions({
    query,
    toolDescription: tool.description,
    numQuestions: breadth,
    previousLearnings: learnings,
  });
  
  reportProgress({
    totalQueries: followUpQuestions.length,
    currentQuery: followUpQuestions[0]?.question
  });
  
  const limit = pLimit(ConcurrencyLimit);

  const results = await Promise.all(
    followUpQuestions.map(questionObj =>
      limit(async () => {
        try {
          // Use the selected tool to get the response
          const response = await tool.execute({
            query: questionObj.question
          });

          const processedResponse = await processAgentResponse({
            response,
            numLearnings: 3
          });

          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;
          const allLearnings = [...learnings, ...processedResponse.learnings];
          const allSources = [...sources, ...processedResponse.sources];

          if (newDepth > 0) {
            log(
              `Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`,
            );

            reportProgress({
              currentDepth: newDepth,
              currentBreadth: newBreadth,
              completedQueries: progress.completedQueries + 1,
              currentQuery: questionObj.question,
            });

            return deepResearch({
              query: `Following up on: ${response.content}\nContext: ${questionObj.rationale}`,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              sources: allSources,
              onProgress,
            });
          } else {
            reportProgress({
              currentDepth: 0,
              completedQueries: progress.completedQueries + 1,
              currentQuery: questionObj.question,
            });
            return {
              learnings: allLearnings,
              sources: allSources,
              compliance_scores: processedResponse.compliance_score ? [processedResponse.compliance_score] : undefined
            };
          }
        } catch (e: any) {
          log(`Error processing question: ${questionObj.question}: `, e);
          return {
            learnings: [],
            sources: [],
            compliance_scores: []
          };
        }
      }),
    ),
  );

  // Combine all results
  const flatResults = results.flat();
  return {
    learnings: Array.from(new Set(flatResults.flatMap(r => r.learnings))),
    sources: Array.from(new Set(flatResults.flatMap(r => r.sources))),
    compliance_scores: flatResults.flatMap(r => r.compliance_scores || [])
  };
}

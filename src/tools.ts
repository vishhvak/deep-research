import { tool } from 'ai';
import { z } from 'zod';

export interface AgentRequestBody {
  elzSessionId?: string;
  elzRequestCount?: number;
  userId?: string;
  agentId: string;
  content: string;
  useHistory?: boolean;
  returnRagContext?: boolean;
  retrieverStrategy?: string;
  metadataFilterExpression?: string;
  chunkCount?: number;
}

export interface PageSection {
  score: number;
  agentDocId: string;
  agentDocChunkId: string;
  chunkAlias: string;
  page_label: string;
}

export interface Source {
  sourceType: string;
  file_name: string;
  file_path: string;
  page_section: PageSection[];
}

export interface Action {
  name: string;
  type: 'PROMPT' | 'URL';
  content: string;
}

export interface ContextItem {
  key: string;
  value: string;
}

export interface PromptInfo {
  promptId: string;
  promptName: string;
}

export interface AgentResponse {
  elzSessionId: string;
  elzRequestCount: string;
  elzRequestId: string;
  content: string;
  delta?: {
    content: string;
    index: number;
  };
  source?: Source[];
  actions?: Action[];
  cost?: number;
  log?: {
    raw_log: string;
    intermediate_answers: string[];
  };
  context?: ContextItem[];
  ragContext?: string;
  blocked?: boolean;
  blockReason?: string;
  promptInfo?: PromptInfo;
  wasRemembered?: boolean;
  self_reflection_score?: string;
  self_reflection_content?: string;
  compliance_score?: string;
  compliance_content?: string;
  source_summary?: string;
}

export interface AgentCallOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

export async function callAgent(
  agentId: string, 
  content: string,
  options: AgentCallOptions = {}
): Promise<AgentResponse> {
  const baseUrl = process.env.AGENT_API_URL;
  if (!baseUrl) throw new Error('AGENT_API_URL environment variable is not set');
  const apiUrl = `${baseUrl}/agents/chat`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 30000);

  const body: AgentRequestBody = {
    elzSessionId: "123",
    elzRequestCount: 0,
    userId: process.env.USER_ID,
    agentId,
    content,
    useHistory: false,
    returnRagContext: false,
    retrieverStrategy: "RAG",
    chunkCount: 20
  };

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        ...(options.headers || {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    return await response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

export interface SearchResultItem {
  markdown?: string;
  url?: string;
}

export interface SearchResult {
  data: SearchResultItem[];
}

export interface ApiSearchOptions {
  timeout: number;
  limit: number;
  scrapeOptions: {
    formats: string[];
  };
}

export async function apiSearch(query: string, options: ApiSearchOptions): Promise<SearchResult> {
  const searchAgentId = process.env.SEARCH_AGENT_ID;
  if (!searchAgentId) throw new Error('SEARCH_AGENT_ID environment variable is not set');
  
  const response = await callAgent(
    searchAgentId,
    query,
    {
      timeout: options.timeout,
      headers: { 'X-Jwt-Assertion': process.env.JWT_TOKEN || '' }
    }
  );

  return {
    data: [{
      markdown: response.content,
      url: ''
    }]
  };
}

// Define the market intelligence agent tool
export const marketIntelligenceAgent = tool({
  description: 'A tool for gathering market intelligence about companies and industries. Use this for questions about market research, company analysis, and industry trends.',
  parameters: z.object({
    query: z.string().describe('The market intelligence question to ask'),
    metadataFilter: z.string().optional().describe('Optional metadata filter expression for specific data'),
  }),
  execute: async ({ query, metadataFilter }) => {
    const baseUrl = process.env.AGENT_API_URL;
    if (!baseUrl) throw new Error('AGENT_API_URL environment variable is not set');
    const apiUrl = `${baseUrl}/agents/chat`;
    
    const agentId = process.env.MARKET_INTELLIGENCE_AGENT_ID;
    if (!agentId) throw new Error('MARKET_INTELLIGENCE_AGENT_ID environment variable is not set');

    const body = {
      elzSessionId: "123",
      elzRequestCount: 0,
      userId: process.env.USER_ID,
      agentId,
      content: query,
      useHistory: false,
      returnRagContext: false,
      retrieverStrategy: "RAG",
      metadataFilterExpression: metadataFilter,
      chunkCount: 20
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'X-Jwt-Assertion': process.env.JWT_TOKEN || ''
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json() as AgentResponse;
  }
});

// You can add more agent tools here
// export const complianceAgent = tool({ ... });
// export const riskAnalysisAgent = tool({ ... });

// Add these interfaces after AgentRequestBody
export interface AgentFunctionRequest {
  agentId: string;
  funcNameKey: string;
  arguments: Record<string, any>;
}

export interface AgentFunctionCallOptions extends AgentCallOptions {
  functionName: string;
  agentId: string;
}

// Add this function after callAgent
export async function callAgentFunction<T = any>(
  options: AgentFunctionCallOptions,
  args: Record<string, any>
): Promise<T> {
  const baseUrl = process.env.AGENT_API_URL;
  if (!baseUrl) throw new Error('AGENT_API_URL environment variable is not set');
  const apiUrl = `${baseUrl}/agents/${options.agentId}/functions/${options.functionName}/call`;
  
  const body: AgentFunctionRequest = {
    agentId: options.agentId,
    funcNameKey: options.functionName,
    arguments: args
  };

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        ...(options.headers || {})
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    throw err;
  }
}

// Add this function to create function-based tools
export function createFunctionTool<TArgs extends Record<string, any>, TResponse>({
  description,
  agentId,
  functionName,
  argsSchema,
}: {
  description: string;
  agentId: string;
  functionName: string;
  argsSchema: z.ZodType<TArgs>;
}) {
  return tool({
    description,
    parameters: argsSchema,
    execute: async (args: TArgs) => {
      return await callAgentFunction<TResponse>({
        agentId,
        functionName,
        headers: {
          'X-Jwt-Assertion': process.env.JWT_TOKEN || ''
        }
      }, args);
    }
  });
}

// Example usage - add this with other tool definitions
export const clientUPIDTool = createFunctionTool({
  description: 'Get the UPID (Unique Party ID) for a given client name. Use this when you need to look up client identifiers.',
  agentId: process.env.CLIENT_UPID_AGENT_ID || '',
  functionName: 'Get_Client_UPID',
  argsSchema: z.object({
    client_name: z.string().describe('The name of the client to look up')
  })
});

// Export all available tools
export const researchTools = {
  marketIntelligence: marketIntelligenceAgent,
  getClientUPID: clientUPIDTool,
  // Add more tools as you define them
}; 
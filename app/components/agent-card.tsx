export interface AgentCardAgent {
  id: string;
  name: string;
  emoji: string;
  model: string;
  platforms: { name: string; accountId?: string; appId?: string }[];
  session?: {
    lastActive: number | null;
    totalTokens: number;
    contextTokens: number;
    sessionCount: number;
    todayAvgResponseMs: number;
    messageCount: number;
    weeklyResponseMs: number[];
    weeklyTokens: number[];
  };
}

export interface AgentModelTestResult {
  ok: boolean;
  text?: string;
  error?: string;
  elapsed: number;
}

export interface AgentSessionTestResult {
  ok: boolean;
  reply?: string;
  error?: string;
  elapsed: number;
}

export type PlatformTestResult = {
  ok: boolean;
  error?: string;
  elapsed: number;
} | null;

export interface AgentModelOptionGroup {
  providerId: string;
  providerName: string;
  accessMode: 'auth' | 'api_key';
  models: { id: string; name: string }[];
}

interface AgentCardProps {
  agent: AgentCardAgent;
  gatewayPort: number;
  gatewayToken?: string;
  gatewayHost?: string;
  t?: (key: string) => string;
  testResult?: AgentModelTestResult | null;
  platformTestResults?: Record<string, PlatformTestResult>;
  sessionTestResult?: AgentSessionTestResult | null;
  agentState?: string;
  dmSessionResults?: Record<string, PlatformTestResult>;
  providerAccessModeMap?: Record<string, 'auth' | 'api_key'>;
  modelOptions?: AgentModelOptionGroup[];
  onModelChange?: (agentId: string, model: string) => void;
}

export function AgentCard({}: AgentCardProps) {
  return null;
}
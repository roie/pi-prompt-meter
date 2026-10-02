export type BillingKind = 'subscription' | 'metered' | 'unknown';
export type MeterHistoryOutcome = 'completed' | 'canceled' | 'error';

export interface MeterHistoryRecordV1 {
  userEntryId: string;
  prompt: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns?: number;
  toolCalls?: number;
  compactions?: number;
  billing: BillingKind;
  outcome: MeterHistoryOutcome;
}

export interface UsageKnown {
  input: boolean;
  output: boolean;
  cacheRead: boolean;
  cacheWrite: boolean;
  cost: boolean;
}

export interface PromptHistoryRow {
  sessionId: string;
  sessionPath: string;
  userEntryId: string;
  prompt: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  durationApproximate: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns?: number;
  toolCalls?: number;
  compactions?: number;
  billing: BillingKind;
  outcome?: MeterHistoryOutcome;
  exact: boolean;
  known?: UsageKnown;
}

export interface SessionMeta {
  id: string;
  path: string;
  createdMs: number;
  modifiedMs: number;
}

export interface SessionUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SessionHistorySummary {
  sessionId: string;
  sessionPath: string;
  createdMs: number;
  modifiedMs: number;
  rows: PromptHistoryRow[];
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  durationApproximate: boolean;
  totals: SessionUsageTotals;
  totalsKnown?: UsageKnown;
}

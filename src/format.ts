export type MeterLabel = 'Working' | 'Done' | 'Canceled' | 'Error';

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface AgentActivityCounts {
  turns: number;
  toolCalls: number;
  compactions: number;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function formatTokens(value: number): string {
  const normalized = finiteNonNegative(value);
  if (normalized < 1_000) return Math.round(normalized).toString();
  if (normalized < 10_000) return `${(normalized / 1_000).toFixed(1)}k`;
  if (normalized < 1_000_000) return `${Math.round(normalized / 1_000)}k`;
  if (normalized < 10_000_000) return `${(normalized / 1_000_000).toFixed(1)}M`;
  return `${Math.round(normalized / 1_000_000)}M`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(finiteNonNegative(ms) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatCost(value: number): string {
  return `$${finiteNonNegative(value).toFixed(3)}`;
}

export function formatActivity(activity: AgentActivityCounts): string {
  return [
    `↻${Math.floor(finiteNonNegative(activity.turns))}`,
    `TC${Math.floor(finiteNonNegative(activity.toolCalls))}`,
    `Cmp${Math.floor(finiteNonNegative(activity.compactions))}`,
  ].join(' ');
}

export function formatMeter(
  label: MeterLabel,
  elapsedMs: number,
  usage: UsageTotals,
  subscription: boolean,
  activity?: AgentActivityCounts,
): string {
  const tokens = [
    `↑${formatTokens(usage.input)}`,
    `↓${formatTokens(usage.output)}`,
    `R${formatTokens(usage.cacheRead)}`,
  ];
  if (usage.cacheWrite > 0) tokens.push(`W${formatTokens(usage.cacheWrite)}`);

  const parts = [
    label,
    formatDuration(elapsedMs),
    tokens.join(' '),
  ];
  if (activity) parts.push(formatActivity(activity));
  parts.push(`${formatCost(usage.cost)}${subscription ? ' (sub)' : ''}`);
  return parts.join(' · ');
}

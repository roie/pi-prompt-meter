import { Text, type Component } from '@earendil-works/pi-tui';
import { formatMeter, type AgentActivityCounts, type MeterLabel, type UsageTotals } from '../format.ts';
import { parseMeterHistoryRecord } from '../history/record.ts';
import type { MeterHistoryOutcome, MeterHistoryRecordV1 } from '../history/types.ts';

export interface EntryThemeLike {
  fg(role: string, text: string): string;
}

function labelForOutcome(outcome: MeterHistoryOutcome): MeterLabel {
  if (outcome === 'canceled') return 'Canceled';
  if (outcome === 'error') return 'Error';
  return 'Prompt Meter';
}

function activityForRecord(record: MeterHistoryRecordV1): AgentActivityCounts | undefined {
  if (
    record.turns === undefined
    || record.toolCalls === undefined
    || record.compactions === undefined
  ) {
    return undefined;
  }
  return {
    turns: record.turns,
    toolCalls: record.toolCalls,
    compactions: record.compactions,
  };
}

export function formatMeterHistoryEntry(data: unknown): { label: MeterLabel; text: string } | undefined {
  const record = parseMeterHistoryRecord(data);
  if (!record || record.transcript !== true) return undefined;
  const activity = activityForRecord(record);
  // Incomplete counters stay history-only.
  if (!activity) return undefined;

  const label = labelForOutcome(record.outcome);
  const usage: UsageTotals = {
    input: record.input,
    output: record.output,
    cacheRead: record.cacheRead,
    cacheWrite: record.cacheWrite,
    totalTokens: record.input + record.output + record.cacheRead + record.cacheWrite,
    cost: record.cost,
  };
  return {
    label,
    text: formatMeter(
      label,
      record.durationMs,
      usage,
      record.billing === 'subscription',
      activity,
    ),
  };
}

export function renderMeterHistoryEntry(data: unknown, theme: EntryThemeLike): Component | undefined {
  const formatted = formatMeterHistoryEntry(data);
  if (!formatted) return undefined;

  let text = formatted.text;
  if (formatted.label === 'Prompt Meter') {
    try {
      text = theme.fg('dim', text);
    } catch {
      // Keep unstyled text if the theme fails.
    }
  }
  return new Text(text, 0, 0);
}

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { formatCost, formatDuration, formatTokens } from '../format.ts';
import type { PromptHistoryRow, SessionHistorySummary } from '../history/types.ts';

export type HistorySelection = {
  kind: 'prompt';
  sessionPath: string;
  rowIndex: number;
  userEntryId: string;
};

export interface MeterThemeLike {
  fg?(role: string, text: string): string;
  bg?(role: string, text: string): string;
  bold?(text: string): string;
  underline?(text: string): string;
}

function themeFg(theme: MeterThemeLike | undefined, role: string, text: string): string {
  try { return theme?.fg?.(role, text) ?? text; } catch { return text; }
}

function themeBg(theme: MeterThemeLike | undefined, role: string, text: string): string {
  try { return theme?.bg?.(role, text) ?? text; } catch { return text; }
}

function themeBold(theme: MeterThemeLike | undefined, text: string): string {
  try { return theme?.bold?.(text) ?? text; } catch { return text; }
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), '…');
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

function selectedPromptLine(
  prompt: string,
  width: number,
  theme: MeterThemeLike | undefined,
): string {
  const bodyWidth = Math.max(1, width - 6);
  const body = truncateToWidth(prompt, bodyWidth, '…');
  const line = `    ${themeFg(theme, 'accent', '› ')}${body}`;
  return themeBg(theme, 'selectedBg', padToWidth(line, width));
}

function center(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return ' '.repeat(left) + text;
}

export interface RenderHistoryOptions {
  month: string;
  sessions: SessionHistorySummary[];
  selected?: HistorySelection;
  width: number;
  theme?: MeterThemeLike;
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function sameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  let hour = d.getHours();
  const minute = String(d.getMinutes()).padStart(2, '0');
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${suffix}`;
}

function formatCompactTime(ms: number): string {
  const d = new Date(ms);
  let hour = d.getHours();
  const minute = String(d.getMinutes()).padStart(2, '0');
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute}`;
}

function monthLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return key;
  return `${MONTHS[month - 1]} ${year}`;
}

export function formatSessionRange(startedAt: number, endedAt: number): string {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (sameLocalDate(start, end)) {
    return `${formatDate(startedAt)} · ${formatTime(startedAt)}–${formatTime(endedAt)}`;
  }
  return `${formatDate(startedAt)} · ${formatTime(startedAt)} → ${formatDate(endedAt)} · ${formatTime(endedAt)}`;
}

function formatPromptRange(row: PromptHistoryRow, compact = false): string {
  if (row.startedAt === undefined && row.endedAt === undefined) return '—';
  if (row.startedAt === undefined) return `—–${compact ? formatCompactTime(row.endedAt!) : formatTime(row.endedAt!)}`;
  if (row.endedAt === undefined) return compact ? formatCompactTime(row.startedAt) : formatTime(row.startedAt);
  const a = new Date(row.startedAt);
  const b = new Date(row.endedAt);
  if (!sameLocalDate(a, b)) return compact ? `${formatDate(row.startedAt)}→${formatDate(row.endedAt)}` : `${formatDate(row.startedAt)} · ${formatTime(row.startedAt)} → ${formatDate(row.endedAt)} · ${formatTime(row.endedAt)}`;
  return compact
    ? `${formatCompactTime(row.startedAt)}–${formatCompactTime(row.endedAt)}`
    : `${formatTime(row.startedAt)}–${formatTime(row.endedAt)}`;
}

function formatHistoryDuration(row: PromptHistoryRow): string {
  if (row.durationMs === undefined) return '—';
  return `${row.durationApproximate ? '≈' : ''}${formatDuration(row.durationMs)}`;
}

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), '…');
}

function known(row: PromptHistoryRow, field: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost'): boolean {
  return row.known?.[field] !== false;
}

function metricToken(row: PromptHistoryRow, field: 'input' | 'output' | 'cacheRead' | 'cacheWrite', prefix: string): string {
  return known(row, field) ? `${prefix}${formatTokens(row[field])}` : `${prefix}—`;
}

function metricCost(row: PromptHistoryRow): string {
  return known(row, 'cost') ? formatCost(row.cost) : '$—';
}

function normalizedPrompt(row: PromptHistoryRow): string {
  return row.prompt.replace(/\s+/g, ' ').trim() || '(empty prompt)';
}

function promptMetadata(row: PromptHistoryRow, width: number): string {
  const range = formatPromptRange(row);
  const compactRange = formatPromptRange(row, true);
  const duration = formatHistoryDuration(row);
  const input = metricToken(row, 'input', '↑');
  const output = metricToken(row, 'output', '↓');
  const cache = metricToken(row, 'cacheRead', 'R');
  const write = known(row, 'cacheWrite')
    ? (row.cacheWrite > 0 ? `W${formatTokens(row.cacheWrite)}` : undefined)
    : 'W—';
  const cost = metricCost(row);

  const usageFull = [input, output, cache, write].filter((part): part is string => Boolean(part)).join(' ');
  const usageNoWrite = [input, output, cache].join(' ');
  const usageCore = [input, output].join(' ');
  const variants = [
    `${range} · ${duration} · ${usageFull} · ${cost}`,
    `${range} · ${duration} · ${usageNoWrite} · ${cost}`,
    `${range} · ${duration} · ${usageCore} · ${cost}`,
    `${range} · ${duration} · ${cost}`,
    `${compactRange} · ${duration} · ${cost}`,
    `${compactRange} · ${duration}`,
  ];

  for (const text of variants) {
    if (visibleWidth(text) <= width) return text;
  }
  return fit(`${compactRange} · ${duration}`, width);
}

function renderPrompt(
  row: PromptHistoryRow,
  selected: boolean,
  width: number,
  theme?: MeterThemeLike,
): string[] {
  const prompt = normalizedPrompt(row);
  const promptLine = selected
    ? selectedPromptLine(prompt, width, theme)
    : fit(`      ${prompt}`, width);
  const metadataWidth = Math.max(1, width - 8);
  const metadata = fit(`        ${promptMetadata(row, metadataWidth)}`, width);
  return [promptLine, themeFg(theme, 'muted', metadata)];
}

function sessionTotal(summary: SessionHistorySummary): string {
  const duration = summary.durationMs === undefined ? '—' : `${summary.durationApproximate ? '≈' : ''}${formatDuration(summary.durationMs)}`;
  const k = summary.totalsKnown;
  const usage = [
    `↑${k?.input === false ? '—' : formatTokens(summary.totals.input)}`,
    `↓${k?.output === false ? '—' : formatTokens(summary.totals.output)}`,
    `R${k?.cacheRead === false ? '—' : formatTokens(summary.totals.cacheRead)}`,
  ];
  if (k?.cacheWrite === false) usage.push('W—');
  else if (summary.totals.cacheWrite > 0) usage.push(`W${formatTokens(summary.totals.cacheWrite)}`);
  const cost = k?.cost === false ? '$—' : formatCost(summary.totals.cost);
  return `${duration} · ${usage.join(' ')} · ${cost}`;
}

export function renderHistory(options: RenderHistoryOptions): string[] {
  const width = Math.max(1, Math.floor(options.width));
  const pager = themeBold(options.theme, `‹ ${monthLabel(options.month)} ›`);
  const lines: string[] = [fit(center(pager, width), width), ''];

  if (options.sessions.length === 0) {
    lines.push(themeFg(options.theme, 'muted', fit('No history', width)));
    return lines;
  }

  options.sessions.forEach((session, sessionIndex) => {
    const start = session.startedAt ?? session.createdMs;
    const end = session.endedAt ?? start;
    lines.push(
      fit(
        `${formatSessionRange(start, end)} · ${sessionTotal(session)}`,
        width,
      ),
    );

    for (const [rowIndex, row] of session.rows.entries()) {
      const selected =
        options.selected?.sessionPath === session.sessionPath
        && options.selected.rowIndex === rowIndex;
      lines.push(...renderPrompt(row, selected, width, options.theme));
    }

    if (sessionIndex !== options.sessions.length - 1) lines.push('');
  });

  return lines.map((line) => fit(line, width));
}

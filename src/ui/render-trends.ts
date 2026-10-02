import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { formatCost, formatDuration, formatTokens } from '../format.ts';
import {
  scaleTrendActivity,
  trendGroupingLabel,
  type TrendRange,
  type TrendSummaryBucket,
} from '../trends.ts';
import type { MeterThemeLike } from './render-history.ts';

const RANGES: TrendRange[] = ['7d', '30d', '3mo', '6mo', '1y', 'all'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function themeFg(theme: MeterThemeLike | undefined, role: string, text: string): string {
  try { return theme?.fg?.(role, text) ?? text; } catch { return text; }
}

function themeBold(theme: MeterThemeLike | undefined, text: string): string {
  try { return theme?.bold?.(text) ?? text; } catch { return text; }
}

function themeUnderline(theme: MeterThemeLike | undefined, text: string): string {
  try { return theme?.underline?.(text) ?? text; } catch { return text; }
}

function activeChoice(theme: MeterThemeLike | undefined, label: string, active: boolean): string {
  if (!active) return themeFg(theme, 'muted', label);
  return themeFg(theme, 'accent', themeUnderline(theme, themeBold(theme, label)));
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function monthLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function weeklyLabel(ms: number): string {
  const start = new Date(ms);
  const end = new Date(addDays(ms, 6));
  if (sameMonth(start, end)) {
    return `${MONTHS[start.getMonth()]} ${start.getDate()}–${end.getDate()}`;
  }
  return `${MONTHS[start.getMonth()]} ${start.getDate()}–${MONTHS[end.getMonth()]} ${end.getDate()}`;
}

function bucketLabel(bucket: TrendSummaryBucket, range: TrendRange): string {
  if (range === '1y' || range === 'all') return monthLabel(bucket.startedAt);
  if (range === '3mo' || range === '6mo') return weeklyLabel(bucket.startedAt);
  return dayLabel(bucket.startedAt);
}

function formatTrendTime(bucket: TrendSummaryBucket): string {
  if (!bucket.hasActivity) return '00:00';
  if (!bucket.timeKnown) return '—';
  const value = bucket.time > 0 && bucket.time < 1_000 ? '<0:01' : formatDuration(bucket.time);
  return `${bucket.timeApproximate ? '≈' : ''}${value}`;
}

function tokenValue(
  bucket: TrendSummaryBucket,
  field: 'input' | 'output' | 'cache',
  knownField: 'inputKnown' | 'outputKnown' | 'cacheKnown',
  prefix: string,
): string {
  if (!bucket.hasActivity) return `${prefix}0`;
  if (!bucket[knownField]) return `${prefix}—`;
  return `${prefix}${formatTokens(bucket[field])}`;
}

function costValue(bucket: TrendSummaryBucket): string {
  if (!bucket.hasActivity) return '$0.000';
  return bucket.costKnown ? formatCost(bucket.cost) : '$—';
}

function padRight(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, '…');
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

function padLeft(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, '…');
  return ' '.repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
}

function compactBucketLine(
  bucket: TrendSummaryBucket,
  label: string,
  barLength: number,
  width: number,
  theme?: MeterThemeLike,
): string {
  const usage = [
    tokenValue(bucket, 'input', 'inputKnown', '↑'),
    tokenValue(bucket, 'output', 'outputKnown', '↓'),
    tokenValue(bucket, 'cache', 'cacheKnown', 'R'),
  ].join(' ');
  const bar = barLength > 0 ? themeFg(theme, 'accent', '█'.repeat(barLength)) : themeFg(theme, 'muted', '·');
  return truncateToWidth(
    `${label} · ${formatTrendTime(bucket)} · ${usage} · ${costValue(bucket)} · ${bar}`,
    width,
    '…',
  );
}

export function renderTrends(options: {
  range: TrendRange;
  buckets: TrendSummaryBucket[];
  width: number;
  theme?: MeterThemeLike;
}): string[] {
  const width = Math.max(1, Math.floor(options.width));
  const rangeChoices = RANGES
    .map((range) => activeChoice(options.theme, range === 'all' ? 'All' : range, range === options.range))
    .join('   ');
  const grouping = trendGroupingLabel(options.range);
  const lines = [
    truncateToWidth(
      `${themeFg(options.theme, 'warning', themeBold(options.theme, 'Range:'))}  ${rangeChoices}`,
      width,
      '…',
    ),
    '',
  ];

  if (options.buckets.length === 0) {
    const sectionWidth = Math.min(width, 72);
    lines.push(themeFg(options.theme, 'accent', themeBold(options.theme, `By ${grouping}`)));
    lines.push(themeFg(options.theme, 'dim', '─'.repeat(sectionWidth)));
    lines.push(themeFg(options.theme, 'muted', 'No history'));
    return lines;
  }

  const activeRows = options.buckets
    .map((bucket, index) => ({ bucket, index }))
    .filter(({ bucket }) => bucket.hasActivity);
  const activity = scaleTrendActivity(options.buckets, 20);

  if (activeRows.length === 0) {
    const sectionWidth = Math.min(width, 72);
    lines.push(themeFg(options.theme, 'accent', themeBold(options.theme, `By ${grouping}`)));
    lines.push(themeFg(options.theme, 'dim', '─'.repeat(sectionWidth)));
    lines.push(themeFg(options.theme, 'muted', 'No activity in this range'));
    return lines;
  }

  if (width < 86) {
    const sectionWidth = Math.min(width, 72);
    lines.push(themeFg(options.theme, 'accent', themeBold(options.theme, `By ${grouping}`)));
    lines.push(themeFg(options.theme, 'dim', '─'.repeat(sectionWidth)));
    for (const { bucket, index } of activeRows) {
      lines.push(
        compactBucketLine(
          bucket,
          bucketLabel(bucket, options.range),
          activity[index] ?? 0,
          width,
          options.theme,
        ),
      );
    }
    return lines;
  }

  const labels = activeRows.map(({ bucket }) => bucketLabel(bucket, options.range));
  const dateWidth = Math.min(20, Math.max(12, ...labels.map(visibleWidth)));
  const timeWidth = 11;
  const inputWidth = 9;
  const outputWidth = 9;
  const cacheWidth = 9;
  const costWidth = 10;
  const fixedWidth =
    dateWidth + timeWidth + inputWidth + outputWidth + cacheWidth + costWidth + (6 * 2);
  const activityWidth = Math.min(20, Math.max(4, width - fixedWidth));

  const header = [
    padRight('Date', dateWidth),
    padLeft('Time', timeWidth),
    padLeft('Input', inputWidth),
    padLeft('Output', outputWidth),
    padLeft('Cache', cacheWidth),
    padLeft('Cost', costWidth),
    padRight('Activity', activityWidth),
  ].join('  ');
  const tableWidth = Math.min(width, visibleWidth(header));
  lines.push(themeFg(options.theme, 'accent', themeBold(options.theme, `By ${grouping}`)));
  lines.push(themeFg(options.theme, 'dim', '─'.repeat(tableWidth)));
  lines.push(themeFg(options.theme, 'dim', truncateToWidth(header, width, '')));
  lines.push(themeFg(options.theme, 'dim', '─'.repeat(tableWidth)));

  for (let rowIndex = 0; rowIndex < activeRows.length; rowIndex++) {
    const { bucket, index } = activeRows[rowIndex]!;
    const label = labels[rowIndex]!;
    const barLength = Math.min(activityWidth, activity[index] ?? 0);
    const barText = (barLength > 0 ? '█'.repeat(barLength) : '·').padEnd(activityWidth);
    const bar = themeFg(options.theme, barLength > 0 ? 'accent' : 'muted', barText);
    const line = [
      padRight(label, dateWidth),
      padLeft(formatTrendTime(bucket), timeWidth),
      padLeft(tokenValue(bucket, 'input', 'inputKnown', '↑'), inputWidth),
      padLeft(tokenValue(bucket, 'output', 'outputKnown', '↓'), outputWidth),
      padLeft(tokenValue(bucket, 'cache', 'cacheKnown', 'R'), cacheWidth),
      padLeft(costValue(bucket), costWidth),
      bar,
    ].join('  ');
    lines.push(truncateToWidth(line, width, '…'));
  }

  return lines;
}

import type { PromptHistoryRow } from './history/types.ts';

export type TrendMetric = 'time' | 'cost' | 'input' | 'output' | 'cache';
export type TrendRange = '7d' | '30d' | '3mo' | '6mo' | '1y' | 'all';

export interface TrendBucket {
  key: string;
  startedAt: number;
  value: number;
  approximate: boolean;
}

type Granularity = 'day' | 'week' | 'month';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function bucketKey(date: Date, granularity: Granularity): string {
  if (granularity === 'month') return monthKey(date);
  if (granularity === 'week') return dayKey(startOfWeek(date));
  return dayKey(date);
}

function granularityFor(range: TrendRange): Granularity {
  if (range === '7d' || range === '30d') return 'day';
  if (range === '3mo' || range === '6mo') return 'week';
  return 'month';
}

function fixedRangeStart(range: Exclude<TrendRange, 'all'>, today: Date): Date {
  if (range === '7d' || range === '30d') {
    const start = new Date(today);
    start.setDate(start.getDate() - (range === '7d' ? 6 : 29));
    return start;
  }

  if (range === '3mo' || range === '6mo') {
    const raw = new Date(today);
    raw.setMonth(raw.getMonth() - (range === '3mo' ? 3 : 6));
    return startOfWeek(raw);
  }

  const start = startOfMonth(today);
  start.setMonth(start.getMonth() - 11);
  return start;
}

function buildBucketRange(start: Date, today: Date, granularity: Granularity): TrendBucket[] {
  const buckets: TrendBucket[] = [];
  const cursor = new Date(start);
  const endKey = bucketKey(today, granularity);

  while (true) {
    const key = bucketKey(cursor, granularity);
    buckets.push({ key, startedAt: cursor.getTime(), value: 0, approximate: false });
    if (key === endKey) break;

    if (granularity === 'day') cursor.setDate(cursor.getDate() + 1);
    else if (granularity === 'week') cursor.setDate(cursor.getDate() + 7);
    else cursor.setMonth(cursor.getMonth() + 1);
  }

  return buckets;
}

function metricValue(row: PromptHistoryRow, metric: TrendMetric): number | undefined {
  if (metric === 'time') return row.durationMs;
  if (metric === 'cost') return row.known?.cost === false ? undefined : row.cost;
  if (metric === 'input') return row.known?.input === false ? undefined : row.input;
  if (metric === 'output') return row.known?.output === false ? undefined : row.output;
  return row.known?.cacheRead === false ? undefined : row.cacheRead;
}

function addContribution(bucket: TrendBucket | undefined, row: PromptHistoryRow, metric: TrendMetric): void {
  if (!bucket) return;
  const value = metricValue(row, metric);
  if (value === undefined || !Number.isFinite(value) || value < 0) return;
  bucket.value += value;
  if (metric === 'time' && row.durationApproximate) bucket.approximate = true;
}

export function aggregateTrends(
  rows: Iterable<PromptHistoryRow>,
  metric: TrendMetric,
  range: TrendRange,
  now: Date = new Date(),
): TrendBucket[] {
  const granularity = granularityFor(range);
  const today = startOfDay(now);

  if (range !== 'all') {
    const buckets = buildBucketRange(fixedRangeStart(range, today), today, granularity);
    const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));

    for (const row of rows) {
      if (row.startedAt === undefined) continue;
      addContribution(byKey.get(bucketKey(new Date(row.startedAt), granularity)), row, metric);
    }

    return buckets;
  }

  let earliest: number | undefined;
  const contributions = new Map<string, TrendBucket>();
  const currentMonthKey = monthKey(today);

  for (const row of rows) {
    if (row.startedAt === undefined) continue;
    const rowDate = new Date(row.startedAt);
    const key = monthKey(rowDate);
    if (key > currentMonthKey) continue;

    if (earliest === undefined || row.startedAt < earliest) earliest = row.startedAt;

    let bucket = contributions.get(key);
    if (!bucket) {
      bucket = {
        key,
        startedAt: startOfMonth(rowDate).getTime(),
        value: 0,
        approximate: false,
      };
      contributions.set(key, bucket);
    }
    addContribution(bucket, row, metric);
  }

  if (earliest === undefined) return [];

  const buckets = buildBucketRange(startOfMonth(new Date(earliest)), today, 'month');
  for (const bucket of buckets) {
    const contribution = contributions.get(bucket.key);
    if (!contribution) continue;
    bucket.value = contribution.value;
    bucket.approximate = contribution.approximate;
  }
  return buckets;
}

export function scaleTrendBars(buckets: TrendBucket[], maxWidth: number): number[] {
  const width = Math.max(0, Math.floor(maxWidth));
  const max = Math.max(0, ...buckets.map((bucket) => bucket.value));
  if (width === 0 || max === 0) return buckets.map(() => 0);
  return buckets.map((bucket) => {
    if (bucket.value <= 0) return 0;
    return Math.max(1, Math.min(width, Math.round((bucket.value / max) * width)));
  });
}

export type TrendDataset = Map<string, PromptHistoryRow>;

export function createTrendDataset(): TrendDataset {
  return new Map();
}

export function addRowsToTrendDataset(dataset: TrendDataset, rows: Iterable<PromptHistoryRow>): void {
  for (const row of rows) {
    if (row.startedAt === undefined) continue;
    const key = dayKey(new Date(row.startedAt));
    let point = dataset.get(key);
    if (!point) {
      const dayStart = startOfDay(new Date(row.startedAt)).getTime();
      point = {
        sessionId: '',
        sessionPath: '',
        userEntryId: key,
        prompt: '',
        startedAt: dayStart,
        endedAt: dayStart,
        durationMs: undefined,
        durationApproximate: false,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        billing: 'unknown',
        exact: false,
        known: { input: false, output: false, cacheRead: false, cacheWrite: false, cost: false },
      };
      dataset.set(key, point);
    }
    if (row.durationMs !== undefined) {
      point.durationMs = (point.durationMs ?? 0) + row.durationMs;
      if (row.durationApproximate) point.durationApproximate = true;
    }
    if (row.known?.input !== false) {
      point.input += row.input;
      point.known!.input = true;
    }
    if (row.known?.output !== false) {
      point.output += row.output;
      point.known!.output = true;
    }
    if (row.known?.cacheRead !== false) {
      point.cacheRead += row.cacheRead;
      point.known!.cacheRead = true;
    }
    if (row.known?.cacheWrite !== false) {
      point.cacheWrite += row.cacheWrite;
      point.known!.cacheWrite = true;
    }
    if (row.known?.cost !== false) {
      point.cost += row.cost;
      point.known!.cost = true;
    }
  }
}

export function aggregateTrendDataset(
  dataset: TrendDataset,
  metric: TrendMetric,
  range: TrendRange,
  now: Date = new Date(),
): TrendBucket[] {
  return aggregateTrends(dataset.values(), metric, range, now);
}


export interface TrendSummaryBucket {
  key: string;
  startedAt: number;
  hasActivity: boolean;
  time: number;
  timeKnown: boolean;
  timeApproximate: boolean;
  input: number;
  inputKnown: boolean;
  output: number;
  outputKnown: boolean;
  cache: number;
  cacheKnown: boolean;
  cost: number;
  costKnown: boolean;
}

function emptyTrendSummaryBucket(key: string, startedAt: number): TrendSummaryBucket {
  return {
    key,
    startedAt,
    hasActivity: false,
    time: 0,
    timeKnown: false,
    timeApproximate: false,
    input: 0,
    inputKnown: false,
    output: 0,
    outputKnown: false,
    cache: 0,
    cacheKnown: false,
    cost: 0,
    costKnown: false,
  };
}

function addSummaryContribution(bucket: TrendSummaryBucket | undefined, row: PromptHistoryRow): void {
  if (!bucket) return;
  bucket.hasActivity = true;

  if (row.durationMs !== undefined && Number.isFinite(row.durationMs) && row.durationMs >= 0) {
    bucket.time += row.durationMs;
    bucket.timeKnown = true;
    if (row.durationApproximate) bucket.timeApproximate = true;
  }

  if (row.known?.input !== false && Number.isFinite(row.input) && row.input >= 0) {
    bucket.input += row.input;
    bucket.inputKnown = true;
  }
  if (row.known?.output !== false && Number.isFinite(row.output) && row.output >= 0) {
    bucket.output += row.output;
    bucket.outputKnown = true;
  }
  if (row.known?.cacheRead !== false && Number.isFinite(row.cacheRead) && row.cacheRead >= 0) {
    bucket.cache += row.cacheRead;
    bucket.cacheKnown = true;
  }
  if (row.known?.cost !== false && Number.isFinite(row.cost) && row.cost >= 0) {
    bucket.cost += row.cost;
    bucket.costKnown = true;
  }
}

function summaryRange(start: Date, today: Date, granularity: Granularity): TrendSummaryBucket[] {
  return buildBucketRange(start, today, granularity)
    .map((bucket) => emptyTrendSummaryBucket(bucket.key, bucket.startedAt));
}

export function aggregateTrendSummary(
  rows: Iterable<PromptHistoryRow>,
  range: TrendRange,
  now: Date = new Date(),
): TrendSummaryBucket[] {
  const granularity = granularityFor(range);
  const today = startOfDay(now);

  if (range !== 'all') {
    const buckets = summaryRange(fixedRangeStart(range, today), today, granularity);
    const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
    for (const row of rows) {
      if (row.startedAt === undefined) continue;
      addSummaryContribution(byKey.get(bucketKey(new Date(row.startedAt), granularity)), row);
    }
    return buckets;
  }

  let earliest: number | undefined;
  const contributions = new Map<string, TrendSummaryBucket>();
  const currentMonthKey = monthKey(today);

  for (const row of rows) {
    if (row.startedAt === undefined) continue;
    const rowDate = new Date(row.startedAt);
    const key = monthKey(rowDate);
    if (key > currentMonthKey) continue;
    if (earliest === undefined || row.startedAt < earliest) earliest = row.startedAt;

    let bucket = contributions.get(key);
    if (!bucket) {
      bucket = emptyTrendSummaryBucket(key, startOfMonth(rowDate).getTime());
      contributions.set(key, bucket);
    }
    addSummaryContribution(bucket, row);
  }

  if (earliest === undefined) return [];

  const buckets = summaryRange(startOfMonth(new Date(earliest)), today, 'month');
  for (const bucket of buckets) {
    const contribution = contributions.get(bucket.key);
    if (!contribution) continue;
    Object.assign(bucket, contribution);
  }
  return buckets;
}

export function aggregateTrendDatasetSummary(
  dataset: TrendDataset,
  range: TrendRange,
  now: Date = new Date(),
): TrendSummaryBucket[] {
  return aggregateTrendSummary(dataset.values(), range, now);
}

export function scaleTrendActivity(buckets: TrendSummaryBucket[], maxWidth: number): number[] {
  return scaleTrendBars(
    buckets.map((bucket) => ({
      key: bucket.key,
      startedAt: bucket.startedAt,
      value: bucket.timeKnown ? bucket.time : 0,
      approximate: bucket.timeApproximate,
    })),
    maxWidth,
  );
}

export function trendGroupingLabel(range: TrendRange): 'Day' | 'Week' | 'Month' {
  if (range === '7d' || range === '30d') return 'Day';
  if (range === '3mo' || range === '6mo') return 'Week';
  return 'Month';
}

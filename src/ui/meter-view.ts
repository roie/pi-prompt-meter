import { matchesKey, truncateToWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import type { ProjectHistoryCatalog } from '../history/catalog.ts';
import { monthKeyFromMs } from '../history/catalog.ts';
import type { PromptHistoryRow, SessionHistorySummary } from '../history/types.ts';
import {
  addRowsToTrendDataset,
  aggregateTrendDatasetSummary,
  createTrendDataset,
  type TrendDataset,
  type TrendRange,
  type TrendSummaryBucket,
} from '../trends.ts';
import { renderHistory, type HistorySelection, type MeterThemeLike } from './render-history.ts';
import { renderTrends } from './render-trends.ts';

export type MeterViewResult =
  | { kind: 'close' }
  | { kind: 'navigate'; sessionPath: string; userEntryId: string };

type Mode = 'history' | 'trends';
const RANGES: TrendRange[] = ['7d', '30d', '3mo', '6mo', '1y', 'all'];

interface CatalogLike {
  initialMonth(now: Date): Promise<string | undefined>;
  shiftMonth(key: string, delta: number): string;
  sessionsForMonth(key: string): Promise<SessionHistorySummary[]>;
  loadDetails(path: string): Promise<SessionHistorySummary | undefined>;
  forEachSessionRows(visit: (rows: PromptHistoryRow[]) => void | Promise<void>): Promise<void>;
  warnings?: Array<{ sessionPath: string; message: string }>;
}

function themeFg(theme: MeterThemeLike, role: string, value: string): string {
  try { return theme.fg?.(role, value) ?? value; } catch { return value; }
}

function themeBold(theme: MeterThemeLike, value: string): string {
  try { return theme.bold?.(value) ?? value; } catch { return value; }
}

function themeUnderline(theme: MeterThemeLike, value: string): string {
  try { return theme.underline?.(value) ?? value; } catch { return value; }
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

export interface MeterViewOptions {
  currentSessionPath?: string;
  now?: Date;
}

export class MeterView implements Component {
  private mode: Mode = 'history';
  private month: string;
  private sessions: SessionHistorySummary[] = [];
  private selected?: HistorySelection;
  private range: TrendRange = '30d';
  private trendDataset: TrendDataset | undefined;
  private buckets: TrendSummaryBucket[] = [];
  private pending: Promise<void> = Promise.resolve();
  private closed = false;

  private readonly tui: TUI;
  private readonly theme: MeterThemeLike;
  private readonly catalog: CatalogLike;
  private readonly done: (result: MeterViewResult) => void;
  private readonly currentSessionPath?: string;
  private readonly now: Date;

  private constructor(tui: TUI, theme: MeterThemeLike, catalog: CatalogLike, done: (result: MeterViewResult) => void, options: MeterViewOptions) {
    this.tui = tui;
    this.theme = theme;
    this.catalog = catalog;
    this.done = done;
    this.currentSessionPath = options.currentSessionPath;
    this.now = options.now ?? new Date();
    this.month = monthKeyFromMs(this.now.getTime());
  }

  static async create(
    tui: TUI,
    theme: MeterThemeLike,
    catalog: ProjectHistoryCatalog | CatalogLike,
    done: (result: MeterViewResult) => void,
    options: MeterViewOptions = {},
  ): Promise<MeterView> {
    const view = new MeterView(tui, theme, catalog as CatalogLike, done, options);
    const initial = await view.catalog.initialMonth(view.now);
    if (initial) view.month = initial;
    await view.loadMonth(false);
    return view;
  }

  snapshot() {
    return {
      mode: this.mode,
      month: this.month,
      sessions: this.sessions,
      selected: this.selected ? { ...this.selected } : undefined,
      range: this.range,
    };
  }

  whenIdle(): Promise<void> {
    return this.pending;
  }

  private setPending(work: Promise<void>): void {
    this.pending = work.catch(() => {}).then(() => { this.tui.requestRender(); });
  }

  private chooseDefaultSelection(): void {
    const preferred =
      this.sessions.find((session) => session.sessionPath === this.currentSessionPath)
      ?? this.sessions[0];
    const preferredRow = preferred?.rows[0];
    const fallback = this.sessions.flatMap((session) => session.rows)[0];
    const row = preferredRow ?? fallback;
    this.selected = row
      ? { kind: 'prompt', sessionPath: row.sessionPath, userEntryId: row.userEntryId }
      : undefined;
  }

  private async loadMonth(requestRender = true): Promise<void> {
    const headers = await this.catalog.sessionsForMonth(this.month);
    const sessions: SessionHistorySummary[] = [];
    for (const header of headers) {
      const details = await this.catalog.loadDetails(header.sessionPath);
      sessions.push(details ?? header);
    }
    this.sessions = sessions;
    this.chooseDefaultSelection();
    if (requestRender) this.tui.requestRender();
  }

  private changeMonth(delta: number): void {
    this.month = this.catalog.shiftMonth(this.month, delta);
    this.setPending(this.loadMonth(false));
  }

  private selectableItems(): HistorySelection[] {
    const items: HistorySelection[] = [];
    for (const session of this.sessions) {
      for (const row of session.rows) {
        items.push({ kind: 'prompt', sessionPath: session.sessionPath, userEntryId: row.userEntryId });
      }
    }
    return items;
  }

  private moveSelection(delta: number): void {
    const items = this.selectableItems();
    if (items.length === 0) return;
    const index = this.selected
      ? items.findIndex(
          (item) =>
            item.sessionPath === this.selected?.sessionPath
            && item.userEntryId === this.selected?.userEntryId,
        )
      : -1;
    const next = Math.max(0, Math.min(items.length - 1, (index < 0 ? 0 : index) + delta));
    this.selected = items[next];
    this.tui.requestRender();
  }

  private activateSelection(): void {
    if (!this.selected) return;
    this.closed = true;
    this.done({
      kind: 'navigate',
      sessionPath: this.selected.sessionPath,
      userEntryId: this.selected.userEntryId,
    });
  }

  private recomputeTrends(): void {
    this.buckets = this.trendDataset
      ? aggregateTrendDatasetSummary(this.trendDataset, this.range, this.now)
      : [];
  }

  private ensureTrendRows(): void {
    if (this.trendDataset) {
      this.recomputeTrends();
      return;
    }
    this.setPending((async () => {
      const dataset = createTrendDataset();
      await this.catalog.forEachSessionRows((rows) => addRowsToTrendDataset(dataset, rows));
      this.trendDataset = dataset;
      this.recomputeTrends();
    })());
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, 'escape')) {
      this.closed = true;
      this.done({ kind: 'close' });
      return;
    }
    if (matchesKey(data, 'tab')) {
      this.mode = this.mode === 'history' ? 'trends' : 'history';
      if (this.mode === 'trends') this.ensureTrendRows();
      this.tui.requestRender();
      return;
    }

    if (this.mode === 'history') {
      if (matchesKey(data, 'left')) this.changeMonth(-1);
      else if (matchesKey(data, 'right')) this.changeMonth(1);
      else if (matchesKey(data, 'up')) this.moveSelection(-1);
      else if (matchesKey(data, 'down')) this.moveSelection(1);
      else if (matchesKey(data, 'return') || matchesKey(data, 'enter')) this.activateSelection();
      return;
    }

    const rangeIndex = RANGES.indexOf(this.range);
    if (matchesKey(data, 'right')) this.range = RANGES[Math.min(RANGES.length - 1, rangeIndex + 1)]!;
    else if (matchesKey(data, 'left')) this.range = RANGES[Math.max(0, rangeIndex - 1)]!;
    else return;
    this.recomputeTrends();
    this.tui.requestRender();
  }

  private contentWidth(width: number): number {
    return Math.max(1, Math.min(Math.floor(width), 108));
  }

  private header(width: number): string[] {
    const tab = (label: string, active: boolean): string => {
      const styled = active ? themeUnderline(this.theme, themeBold(this.theme, label)) : label;
      return themeFg(this.theme, active ? 'accent' : 'muted', styled);
    };
    return [
      truncateToWidth(themeFg(this.theme, 'accent', themeBold(this.theme, 'Prompt Meter')), width, '…'),
      '',
      truncateToWidth(`${tab('History', this.mode === 'history')}   ${tab('Trends', this.mode === 'trends')}`, width, '…'),
      '',
    ];
  }

  private footer(width: number): string[] {
    const note = this.mode === 'history'
      ? '≈ marks duration reconstructed from historical session timestamps.'
      : 'Activity bars are relative to Time within the selected range.';
    const controls = this.mode === 'history'
      ? '↑↓ Navigate · ←→ Month · Enter Jump · Tab Trends · Esc Close'
      : '←→ Range · Tab History · Esc Close';
    const lines = [truncateToWidth(themeFg(this.theme, 'muted', note), width, '…')];
    const warningCount = this.catalog.warnings?.length ?? 0;
    if (warningCount > 0) {
      const warning = `⚠ ${warningCount} unreadable session${warningCount === 1 ? '' : 's'} skipped`;
      lines.push(truncateToWidth(themeFg(this.theme, 'warning', warning), width, '…'));
    }
    lines.push('');
    lines.push(truncateToWidth(themeFg(this.theme, 'muted', controls), width, '…'));
    return lines;
  }

  private availableBodyLines(footerLines: number): number | undefined {
    const terminalRows = this.tui.terminal?.rows;
    if (!terminalRows) return undefined;
    const headerLines = 4;
    const piChromeReserve = 3;
    return Math.max(4, terminalRows - headerLines - footerLines - piChromeReserve);
  }

  private historyViewport(lines: string[], maxLines: number | undefined): string[] {
    if (!maxLines || lines.length <= maxLines) return lines;
    const headerCount = Math.min(2, lines.length);
    const header = lines.slice(0, headerCount);
    const body = lines.slice(headerCount);
    const bodyLimit = Math.max(1, maxLines - headerCount);
    const selectedIndex = body.findIndex((line) => stripAnsi(line).trimStart().startsWith('› '));
    const center = selectedIndex < 0 ? 0 : selectedIndex;
    const start = Math.max(0, Math.min(body.length - bodyLimit, center - Math.floor(bodyLimit / 2)));
    return [...header, ...body.slice(start, start + bodyLimit)];
  }

  private trendsViewport(lines: string[], maxLines: number | undefined): string[] {
    if (!maxLines || lines.length <= maxLines) return lines;
    const headerCount = Math.min(4, lines.length);
    const header = lines.slice(0, headerCount);
    const body = lines.slice(headerCount);
    const bodyLimit = Math.max(1, maxLines - headerCount);
    if (body.length <= bodyLimit) return lines;
    if (bodyLimit === 1) return [...header, body.at(-1)!];
    const visibleCount = bodyLimit - 1;
    const omitted = Math.max(0, body.length - visibleCount);
    return [
      ...header,
      themeFg(this.theme, 'muted', `… ${omitted} earlier row${omitted === 1 ? '' : 's'}`),
      ...body.slice(-visibleCount),
    ];
  }

  render(width: number): string[] {
    const contentWidth = this.contentWidth(width);
    const footer = this.footer(contentWidth);
    const bodyLimit = this.availableBodyLines(footer.length);
    const body = this.mode === 'history'
      ? this.historyViewport(
          renderHistory({
            month: this.month,
            sessions: this.sessions,
            selected: this.selected,
            width: contentWidth,
            theme: this.theme,
          }),
          bodyLimit,
        )
      : this.trendsViewport(
          renderTrends({ range: this.range, buckets: this.buckets, width: contentWidth, theme: this.theme }),
          bodyLimit,
        );

    const lines = [...this.header(contentWidth), ...body];
    const terminalRows = this.tui.terminal?.rows;
    const safeRemaining = terminalRows
      ? Math.max(0, terminalRows - 3 - lines.length - footer.length)
      : 1;
    const padding = Math.max(1, Math.min(3, safeRemaining));
    for (let i = 0; i < padding; i++) lines.push('');
    return [...lines, ...footer];
  }
  invalidate(): void {}
}

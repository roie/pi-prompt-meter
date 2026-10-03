import { excludeInheritedEntries, reconstructSessionHistory } from './reconstruct.ts';
import type { PromptHistoryRow, SessionHistorySummary, SessionMeta } from './types.ts';

export type MonthKey = string;

interface SessionInfoLike {
  path: string;
  id: string;
  created: Date;
  modified: Date;
  parentSessionPath?: string;
}

export interface SessionManagerSource {
  list(cwd: string): Promise<SessionInfoLike[]>;
  open(path: string): { getEntries(): any[] };
}

interface CatalogSession extends SessionMeta {
  parentSessionPath?: string;
}

interface CachedSummary {
  modifiedMs: number;
  summary?: SessionHistorySummary;
  failed?: boolean;
}

export interface CatalogWarning {
  sessionPath: string;
  message: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function monthKeyFromMs(ms: number): MonthKey {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function monthBounds(key: MonthKey): { start: number; end: number } | undefined {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return undefined;
  const start = new Date(year, month - 1, 1).getTime();
  const end = new Date(year, month, 1).getTime() - 1;
  return { start, end };
}

async function defaultSource(): Promise<SessionManagerSource> {
  const moduleName = '@earendil-works/pi-coding-agent';
  const mod = await import(moduleName) as any;
  return {
    list: (cwd: string) => mod.SessionManager.list(cwd),
    open: (path: string) => mod.SessionManager.open(path),
  };
}

function headerOnly(summary: SessionHistorySummary): SessionHistorySummary {
  return { ...summary, rows: [] };
}

export class ProjectHistoryCatalog {
  readonly warnings: CatalogWarning[] = [];
  private readonly byPath = new Map<string, CatalogSession>();
  private readonly headerCache = new Map<string, CachedSummary>();
  private readonly detailsCache = new Map<string, CachedSummary>();
  private readonly source: SessionManagerSource;

  constructor(sessions: CatalogSession[], source: SessionManagerSource) {
    this.source = source;
    for (const session of sessions) this.byPath.set(session.path, session);
  }

  get sessionCount(): number {
    return this.byPath.size;
  }

  sessionPaths(): string[] {
    return [...this.byPath.keys()];
  }

  clear(): void {
    this.headerCache.clear();
    this.detailsCache.clear();
    this.warnings.length = 0;
  }

  updateModified(path: string, modifiedMs: number): void {
    const session = this.byPath.get(path);
    if (session) session.modifiedMs = modifiedMs;
  }

  shiftMonth(key: MonthKey, delta: number): MonthKey {
    const bounds = monthBounds(key);
    if (!bounds) return key;
    const date = new Date(bounds.start);
    date.setMonth(date.getMonth() + delta);
    return monthKeyFromMs(date.getTime());
  }

  monthFor(summary: SessionHistorySummary): MonthKey | undefined {
    return summary.startedAt === undefined ? undefined : monthKeyFromMs(summary.startedAt);
  }

  private validCached(
    cache: Map<string, CachedSummary>,
    meta: CatalogSession,
  ): CachedSummary | undefined {
    const cached = cache.get(meta.path);
    return cached?.modifiedMs === meta.modifiedMs ? cached : undefined;
  }

  private warn(path: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (!this.warnings.some((warning) => warning.sessionPath === path && warning.message === message)) {
      this.warnings.push({ sessionPath: path, message });
    }
  }

  private reconstruct(meta: CatalogSession, projectOnly = false): SessionHistorySummary {
    const manager = this.source.open(meta.path);
    let entries = manager.getEntries();
    if (projectOnly && meta.parentSessionPath && this.byPath.has(meta.parentSessionPath)) {
      const parent = this.source.open(meta.parentSessionPath);
      entries = excludeInheritedEntries(entries, parent.getEntries());
    }
    return reconstructSessionHistory(entries, meta);
  }

  async load(path: string): Promise<SessionHistorySummary | undefined> {
    const meta = this.byPath.get(path);
    if (!meta) return undefined;

    const cachedDetails = this.validCached(this.detailsCache, meta);
    if (cachedDetails) return cachedDetails.summary ? headerOnly(cachedDetails.summary) : undefined;

    const cachedHeader = this.validCached(this.headerCache, meta);
    if (cachedHeader) return cachedHeader.summary;

    try {
      const summary = headerOnly(this.reconstruct(meta));
      this.headerCache.set(path, { modifiedMs: meta.modifiedMs, summary });
      return summary;
    } catch (error) {
      this.headerCache.set(path, { modifiedMs: meta.modifiedMs, failed: true });
      this.warn(path, error);
      return undefined;
    }
  }

  private metadataCandidates(key: MonthKey): CatalogSession[] {
    const bounds = monthBounds(key);
    if (!bounds) return [];
    return [...this.byPath.values()].filter((session) => {
      const createdMonth = monthKeyFromMs(session.createdMs);
      if (createdMonth === key) return true;
      return session.createdMs <= bounds.end && session.modifiedMs >= bounds.start;
    });
  }

  async sessionsForMonth(key: MonthKey): Promise<SessionHistorySummary[]> {
    const summaries: SessionHistorySummary[] = [];
    for (const meta of this.metadataCandidates(key)) {
      const summary = await this.load(meta.path);
      if (summary && summary.startedAt !== undefined && this.monthFor(summary) === key) summaries.push(summary);
    }
    return summaries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  async loadDetails(path: string): Promise<SessionHistorySummary | undefined> {
    const meta = this.byPath.get(path);
    if (!meta) return undefined;

    const cached = this.validCached(this.detailsCache, meta);
    if (cached) return cached.summary;

    try {
      const summary = this.reconstruct(meta);
      this.detailsCache.set(path, { modifiedMs: meta.modifiedMs, summary });
      this.headerCache.set(path, { modifiedMs: meta.modifiedMs, summary: headerOnly(summary) });
      return summary;
    } catch (error) {
      this.detailsCache.set(path, { modifiedMs: meta.modifiedMs, failed: true });
      this.warn(path, error);
      return undefined;
    }
  }

  async forEachSessionRows(
    visit: (rows: PromptHistoryRow[]) => void | Promise<void>,
  ): Promise<void> {
    for (const meta of this.byPath.values()) {
      const cached = this.validCached(this.detailsCache, meta);
      if (cached && !meta.parentSessionPath) {
        if (cached.summary) await visit(cached.summary.rows);
        continue;
      }

      try {
        const details = this.reconstruct(meta, true);
        await visit(details.rows);
      } catch (error) {
        this.detailsCache.set(meta.path, { modifiedMs: meta.modifiedMs, failed: true });
        this.warn(meta.path, error);
      }
    }
  }

  async initialMonth(now: Date): Promise<MonthKey | undefined> {
    if (this.byPath.size === 0) return undefined;
    const current = monthKeyFromMs(now.getTime());
    if ((await this.sessionsForMonth(current)).length > 0) return current;

    const candidates = [...new Set([...this.byPath.values()].map((session) => monthKeyFromMs(session.createdMs)))]
      .sort()
      .reverse();
    for (const key of candidates) {
      if ((await this.sessionsForMonth(key)).length > 0) return key;
    }

    // A legacy session can have a header month different from its file creation month.
    let latest: MonthKey | undefined;
    for (const meta of [...this.byPath.values()].sort((a, b) => b.modifiedMs - a.modifiedMs)) {
      const summary = await this.load(meta.path);
      const key = summary && summary.startedAt !== undefined ? this.monthFor(summary) : undefined;
      if (key && (!latest || key > latest)) latest = key;
    }
    return latest;
  }
}

export async function listProjectHistory(
  cwd: string,
  source?: SessionManagerSource,
): Promise<ProjectHistoryCatalog> {
  const resolvedSource = source ?? await defaultSource();
  const infos = await resolvedSource.list(cwd);
  const sessions = infos.map((info): CatalogSession => ({
    id: info.id,
    path: info.path,
    createdMs: info.created.getTime(),
    modifiedMs: info.modified.getTime(),
    parentSessionPath: info.parentSessionPath,
  }));
  return new ProjectHistoryCatalog(sessions, resolvedSource);
}

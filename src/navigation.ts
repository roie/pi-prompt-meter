export interface HistoryNavigationTarget {
  sessionPath: string;
  userEntryId: string;
}

interface NavigationContext {
  ui?: { notify?(message: string, type?: 'info' | 'warning' | 'error'): void };
  sessionManager: { getSessionFile(): string | undefined };
  navigateTree(entryId: string): Promise<{ cancelled: boolean }>;
  switchSession(
    sessionPath: string,
    options?: { withSession?: (ctx: NavigationContext) => Promise<void> },
  ): Promise<{ cancelled: boolean }>;
}

export type NavigationResult = 'navigated' | 'unavailable' | 'cancelled';

function warnUnavailable(ctx: NavigationContext): void {
  try {
    ctx.ui?.notify?.('Prompt location is unavailable', 'warning');
  } catch {
    // Navigation notices are best-effort.
  }
}

export async function navigateToHistoryPrompt(
  ctx: NavigationContext,
  target: HistoryNavigationTarget,
): Promise<NavigationResult> {
  try {
    if (ctx.sessionManager.getSessionFile() === target.sessionPath) {
      try {
        const result = await ctx.navigateTree(target.userEntryId);
        return result.cancelled ? 'cancelled' : 'navigated';
      } catch {
        warnUnavailable(ctx);
        return 'unavailable';
      }
    }

    let result: NavigationResult = 'unavailable';
    const switched = await ctx.switchSession(target.sessionPath, {
      withSession: async (fresh) => {
        try {
          const navigated = await fresh.navigateTree(target.userEntryId);
          result = navigated.cancelled ? 'cancelled' : 'navigated';
        } catch {
          warnUnavailable(fresh);
          result = 'unavailable';
        }
      },
    });
    if (switched.cancelled) return 'cancelled';
    return result;
  } catch {
    warnUnavailable(ctx);
    return 'unavailable';
  }
}

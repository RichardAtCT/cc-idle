// The cc-idle mod's $.state contract: session-scoped UI state the pane draws from.
// The economy itself lives in $.store (shared by every session), not here.

/** Which screen the pane shows. */
export type IdleView = 'main' | 'tree' | 'confirm-ship';

/** Why Claude Code is waiting on the person, or '' while it isn't. */
export type IdleNeedsYou = '' | 'done' | 'permission' | 'question';

declare module 'claude-code' {
  interface PluginState {
    'cc-idle': {
      /** Bumped whenever the economy changes, so the pane redraws. */
      rev: number;
      view: IdleView;
      /** Index of the focused region, in founding order. */
      region: number;
      needsYou: IdleNeedsYou;
    };
  }
}

import fs from 'node:fs';
import { registrationsPath } from '@ccidle/shared';

export interface CcRegistration {
  pane?: string;
  cwd?: string;
  sessionId?: string;
}

export interface RegistrationsData {
  game: { pane?: string } | null;
  cc: CcRegistration[];
}

const EMPTY: RegistrationsData = { game: null, cc: [] };

/**
 * Persists pane/cwd/session registrations from `ccidle register` (PRD §3.5)
 * to registrationsPath() so they survive daemon restarts. The game pane is
 * unique ("mission control"); CC registrations map a pane and/or cwd to a
 * session, since a launcher may register a pane before that session's first
 * hook event has arrived.
 */
export class RegistrationStore {
  private data: RegistrationsData;
  private readonly path: string;

  constructor(env?: NodeJS.ProcessEnv) {
    this.path = registrationsPath(env);
    this.data = this.load();
  }

  private load(): RegistrationsData {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      return {
        game: raw?.game && typeof raw.game === 'object' ? raw.game : null,
        cc: Array.isArray(raw?.cc) ? raw.cc : []
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch {
      // best-effort — registrations are a convenience, not the source of truth
    }
  }

  setGamePane(pane: string | undefined): void {
    this.data.game = pane ? { pane } : null;
    this.persist();
  }

  getGamePane(): string | undefined {
    return this.data.game?.pane;
  }

  registerCc(entry: CcRegistration): void {
    const idx = this.data.cc.findIndex(
      (r) =>
        (entry.sessionId && r.sessionId === entry.sessionId) ||
        (entry.pane && r.pane === entry.pane) ||
        (entry.cwd && !entry.pane && r.cwd === entry.cwd)
    );
    if (idx === -1) {
      this.data.cc.push({ ...entry });
    } else {
      this.data.cc[idx] = { ...this.data.cc[idx], ...entry };
    }
    this.persist();
  }

  /** Find a registered pane id for a session by id first, falling back to cwd. */
  resolvePaneForSession(sessionId: string, cwd?: string): string | undefined {
    const byId = this.data.cc.find((r) => r.sessionId === sessionId);
    if (byId?.pane) return byId.pane;
    if (cwd) {
      const byCwd = this.data.cc.find((r) => r.cwd === cwd);
      if (byCwd?.pane) return byCwd.pane;
    }
    return undefined;
  }

  all(): RegistrationsData {
    return structuredClone(this.data);
  }
}

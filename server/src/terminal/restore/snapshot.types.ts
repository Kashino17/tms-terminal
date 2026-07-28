export interface ClaudeMark {
  /** Claude-Code-Session-ID aus ~/.claude/sessions/<pid>.json. */
  sessionId: string;
  /** 'busy' = die Sitzung wurde mitten in der Arbeit abgeschnitten. */
  status: 'busy' | 'idle' | 'shell';
}

export interface SnapshotEntry {
  /**
   * TMS-Session-ID. Wird beim Wiederherstellen WIEDERVERWENDET — die App hält
   * ihre Reiter an dieser ID fest und findet sie sonst nicht mehr.
   */
  id: string;
  /**
   * Nur für Log und Manager-Nachricht ("Shell 1 wiederhergestellt").
   * NICHT der Kartenname in der App: den hält die App selbst und verliert ihn
   * bei einem Server-Neustart gar nicht. TerminalSession trägt kein Label.
   */
  label?: string;
  cwd: string;
  cols: number;
  rows: number;
  claude?: ClaudeMark;
}

export interface Snapshot {
  capturedAt: number;
  /** Schutz davor, Terminals zu übernehmen, während ein anderer Server läuft. */
  serverPid: number;
  entries: SnapshotEntry[];
}

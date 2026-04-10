#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TmsClient } from './tms-client.js';

// ── Config ──────────────────────────────────────────────────────────────────

const HOST = process.env.TMS_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.TMS_PORT ?? '8767', 10);
const TOKEN = process.env.TMS_TOKEN ?? '';

if (!TOKEN) {
  console.error('TMS_TOKEN environment variable is required');
  process.exit(1);
}

// ── Client ──────────────────────────────────────────────────────────────────

const client = new TmsClient(HOST, PORT, TOKEN);

async function ensureConnected(): Promise<void> {
  if (!client.isConnected()) {
    await client.connect();
  }
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'tms-terminal',
  version: '1.0.0',
});

// ── Tools ───────────────────────────────────────────────────────────────────

server.tool(
  'list_sessions',
  'Liste aller aktiven Terminal-Sessions',
  {},
  async () => {
    await ensureConnected();
    const sessions = client.listSessions();
    if (sessions.length === 0) {
      return { content: [{ type: 'text', text: 'Keine aktiven Sessions.' }] };
    }
    const lines = sessions.map(s =>
      `${s.label} (${s.sessionId.slice(0, 8)}) — ${s.cols}x${s.rows}`
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'create_session',
  'Neue Terminal-Session erstellen',
  { cols: z.number().optional().describe('Spalten (default: 120)'), rows: z.number().optional().describe('Zeilen (default: 30)') },
  async ({ cols, rows }) => {
    await ensureConnected();
    const session = await client.createSession(cols ?? 120, rows ?? 30);
    return { content: [{ type: 'text', text: `Session erstellt: ${session.label} (${session.sessionId.slice(0, 8)})` }] };
  },
);

server.tool(
  'send_command',
  'Befehl an ein Terminal senden (mit Enter)',
  { session: z.string().describe('Session-Label oder ID (z.B. "Shell 1")'), command: z.string().describe('Der auszuführende Befehl') },
  async ({ session, command }) => {
    await ensureConnected();
    const s = client.resolveSession(session);
    if (!s) return { content: [{ type: 'text', text: `Session "${session}" nicht gefunden.` }] };
    client.sendCommand(s.sessionId, command);
    return { content: [{ type: 'text', text: `Befehl gesendet an ${s.label}: ${command}` }] };
  },
);

server.tool(
  'send_input',
  'Rohen Text an ein Terminal senden (ohne Enter)',
  { session: z.string().describe('Session-Label oder ID'), input: z.string().describe('Der zu sendende Text') },
  async ({ session, input }) => {
    await ensureConnected();
    const s = client.resolveSession(session);
    if (!s) return { content: [{ type: 'text', text: `Session "${session}" nicht gefunden.` }] };
    client.sendInput(s.sessionId, input);
    return { content: [{ type: 'text', text: `Input gesendet an ${s.label}` }] };
  },
);

server.tool(
  'read_output',
  'Terminal-Output einer Session lesen',
  { session: z.string().describe('Session-Label oder ID'), lines: z.number().optional().describe('Anzahl Zeichen vom Ende (default: 2000)') },
  async ({ session, lines }) => {
    await ensureConnected();
    const s = client.resolveSession(session);
    if (!s) return { content: [{ type: 'text', text: `Session "${session}" nicht gefunden.` }] };
    const output = client.readOutput(s.sessionId, lines ?? 2000);
    if (!output) return { content: [{ type: 'text', text: `${s.label}: Kein Output vorhanden.` }] };
    return { content: [{ type: 'text', text: `── ${s.label} Output ──\n${output}` }] };
  },
);

server.tool(
  'close_session',
  'Terminal-Session schließen',
  { session: z.string().describe('Session-Label oder ID') },
  async ({ session }) => {
    await ensureConnected();
    const s = client.resolveSession(session);
    if (!s) return { content: [{ type: 'text', text: `Session "${session}" nicht gefunden.` }] };
    client.closeSession(s.sessionId);
    return { content: [{ type: 'text', text: `${s.label} geschlossen.` }] };
  },
);

server.tool(
  'send_ctrl_c',
  'Ctrl+C an ein Terminal senden (Prozess abbrechen)',
  { session: z.string().describe('Session-Label oder ID') },
  async ({ session }) => {
    await ensureConnected();
    const s = client.resolveSession(session);
    if (!s) return { content: [{ type: 'text', text: `Session "${session}" nicht gefunden.` }] };
    client.sendCtrlC(s.sessionId);
    return { content: [{ type: 'text', text: `Ctrl+C gesendet an ${s.label}` }] };
  },
);

server.tool(
  'clear_output',
  'Output-Buffer einer Session leeren',
  { session: z.string().describe('Session-Label oder ID') },
  async ({ session }) => {
    await ensureConnected();
    const s = client.resolveSession(session);
    if (!s) return { content: [{ type: 'text', text: `Session "${session}" nicht gefunden.` }] };
    client.clearOutput(s.sessionId);
    return { content: [{ type: 'text', text: `Output-Buffer von ${s.label} geleert.` }] };
  },
);

server.tool(
  'overview',
  'Übersicht aller Sessions mit aktuellem Status',
  {},
  async () => {
    await ensureConnected();
    const sessions = client.listSessions();
    if (sessions.length === 0) {
      return { content: [{ type: 'text', text: 'Keine aktiven Sessions.' }] };
    }
    const parts: string[] = [];
    for (const s of sessions) {
      const output = client.readOutput(s.sessionId, 500);
      const lastLine = output.trim().split('\n').pop() ?? '';
      const status = output.length === 0 ? 'Idle' : 'Aktiv';
      parts.push(`${s.label} [${status}]: ${lastLine.slice(0, 80)}`);
    }
    return { content: [{ type: 'text', text: parts.join('\n') }] };
  },
);

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`TMS Terminal MCP Server running — connecting to ${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

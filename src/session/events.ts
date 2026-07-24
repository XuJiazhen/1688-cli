import fs from 'node:fs/promises';
import path from 'node:path';
import { eventsFile } from './paths.js';
import type { CliErrorDetails } from '../io/errors.js';
import {
  redactTextForDiagnostics,
  redactUrlForDiagnostics,
} from './redaction.js';

export type CommandEventPhase = 'start' | 'end' | 'error';
export type CommandEventStatus = 'running' | 'ok' | 'error';

export interface CommandEvent {
  ts: string;
  requestId: string;
  cmd: string;
  phase: CommandEventPhase;
  status: CommandEventStatus;
  durationMs?: number;
  profile?: string;
  artifactDir?: string;
  errorCode?: string;
  pageState?: string;
  verification?: { state: string; reason?: string; currentUrl?: string };
  warnings?: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
  retryable?: boolean;
}

interface ErrorLike {
  code?: string;
  details?: CliErrorDetails;
}

const SENSITIVE_KEY_RE = /cookie|token|password|passwd|secret|authorization|headers|body|message/i;

export function sanitizeForEvent(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) return value;
  if (key && SENSITIVE_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return key && /url$/i.test(key)
      ? redactUrlForDiagnostics(value)
      : redactTextForDiagnostics(value);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeForEvent(item));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = sanitizeForEvent(raw, key);
    }
  }
  return out;
}

export function eventFromError(input: {
  requestId: string;
  cmd: string;
  startedAt: number;
  error: unknown;
  profile?: string;
}): CommandEvent {
  const err = input.error as ErrorLike;
  const details = err?.details;
  return {
    ts: new Date().toISOString(),
    requestId: input.requestId,
    cmd: input.cmd,
    phase: 'error',
    status: 'error',
    durationMs: Date.now() - input.startedAt,
    profile: input.profile,
    artifactDir: details?.artifactDir,
    errorCode: err?.code,
    pageState: details?.pageState,
    verification: verificationFromDetails(details),
    retryable: details?.retryable,
  };
}

export function startEvent(input: {
  requestId: string;
  cmd: string;
  profile?: string;
}): CommandEvent {
  return {
    ts: new Date().toISOString(),
    requestId: input.requestId,
    cmd: input.cmd,
    phase: 'start',
    status: 'running',
    profile: input.profile,
  };
}

export function endEvent(input: {
  requestId: string;
  cmd: string;
  startedAt: number;
  profile?: string;
}): CommandEvent {
  return {
    ts: new Date().toISOString(),
    requestId: input.requestId,
    cmd: input.cmd,
    phase: 'end',
    status: 'ok',
    durationMs: Date.now() - input.startedAt,
    profile: input.profile,
  };
}

export async function appendEvent(event: CommandEvent): Promise<void> {
  const file = eventsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(sanitizeForEvent(event)) + '\n');
}

export async function appendEventBestEffort(event: CommandEvent): Promise<void> {
  await appendEvent(event).catch(() => {});
}

export async function readRecentEvents(limit = 100): Promise<CommandEvent[]> {
  const events = await readAllEvents();
  return events.slice(-Math.max(1, limit));
}

export async function readAllEvents(): Promise<CommandEvent[]> {
  const file = eventsFile();
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const events: CommandEvent[] = [];
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      events.push(JSON.parse(line) as CommandEvent);
    } catch {
      /* skip malformed historical line */
    }
  }
  return events;
}

export interface CommandEventSummary {
  requestId: string;
  cmd: string;
  status: CommandEventStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  profile?: string;
  artifactDir?: string;
  errorCode?: string;
  pageState?: string;
  verification?: CommandEvent['verification'];
  warnings?: CommandEvent['warnings'];
  events: CommandEvent[];
}

export function summarizeEvents(events: CommandEvent[]): CommandEventSummary[] {
  const byRequest = new Map<string, CommandEvent[]>();
  for (const event of events) {
    const list = byRequest.get(event.requestId) ?? [];
    list.push(event);
    byRequest.set(event.requestId, list);
  }
  return [...byRequest.entries()].map(([requestId, list]) => {
    const sorted = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
    const first = sorted[0]!;
    const last = sorted.at(-1)!;
    return {
      requestId,
      cmd: last.cmd || first.cmd,
      status: last.status,
      startedAt: sorted.find((e) => e.phase === 'start')?.ts ?? first.ts,
      endedAt: last.phase === 'start' ? undefined : last.ts,
      durationMs: last.durationMs,
      profile: last.profile ?? first.profile,
      artifactDir: last.artifactDir,
      errorCode: last.errorCode,
      pageState: last.pageState,
      verification: last.verification,
      warnings: last.warnings,
      events: sorted,
    };
  });
}

export async function readRecentEventSummaries(limit = 20): Promise<CommandEventSummary[]> {
  const summaries = summarizeEvents(await readAllEvents());
  return summaries.slice(-Math.max(1, limit));
}

function verificationFromDetails(
  details: CliErrorDetails | undefined,
): CommandEvent['verification'] | undefined {
  if (!details) return undefined;
  const currentUrl = details.currentUrl
    ? redactUrlForDiagnostics(details.currentUrl)
    : undefined;
  if (details.pageState === 'not_logged_in') {
    return {
      state: 'login_required',
      currentUrl,
    };
  }
  if (details.pageState === 'rate_limited' || details.category === 'rate_limited') {
    return {
      state: 'rate_limited',
      reason: details.pageState,
      currentUrl,
    };
  }
  if (details.category === 'risk_control') {
    return {
      state: 'risk_control',
      reason: details.pageState,
      currentUrl,
    };
  }
  if (details.currentUrl || details.pageState) {
    return {
      state: 'unknown',
      reason: details.pageState,
      currentUrl,
    };
  }
  return undefined;
}

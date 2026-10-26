// Redaction sessions: deterministic placeholders, encrypted reversible mappings, safe restore.

import { detect, type Category, type Sensitivity } from "./detect";
import { randomHex, seal, sha256Hex, unseal, vaultKey, type KV, type Sealed } from "./storage";

export interface MappingEntry {
  placeholder: string;
  category: Category;
  digest: string;
  sealed: Sealed;
}

export interface Session {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  salt: string;
  entries: MappingEntry[];
}

export interface SessionSummary {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  count: number;
  categories: Partial<Record<Category, number>>;
}

export interface Redaction {
  category: Category;
  start: number;
  end: number;
  score: number;
  placeholder: string;
  sanitizedStart: number;
  sanitizedEnd: number;
}

export interface SanitizeResult {
  sanitizedText: string;
  sessionId: string;
  redactions: Redaction[];
  placeholders: { placeholder: string; category: Category }[];
  categoryCounts: Partial<Record<Category, number>>;
}

export const PLACEHOLDER_RE = /\[([A-Z_]+)_(\d+)\]/g;
const normalise = (v: string) => v.split(/\s+/).filter(Boolean).join(" ").toLocaleLowerCase();

export class Vault {
  constructor(private kv: KV) {}

  async createSession(label?: string): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: "rs_" + randomHex(8),
      label: label?.trim() || `Session ${new Date().toLocaleString()}`,
      createdAt: now,
      updatedAt: now,
      salt: randomHex(16),
      entries: [],
    };
    await this.kv.put("sessions", session.id, session);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    return this.kv.get<Session>("sessions", id);
  }

  async list(): Promise<SessionSummary[]> {
    const all = await this.kv.entries<Session>("sessions");
    return all
      .map(([, s]) => {
        const categories: Partial<Record<Category, number>> = {};
        for (const e of s.entries) categories[e.category] = (categories[e.category] ?? 0) + 1;
        return { id: s.id, label: s.label, createdAt: s.createdAt, updatedAt: s.updatedAt, count: s.entries.length, categories };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async rename(id: string, label: string) {
    const s = await this.get(id);
    if (!s) throw new Error("Session not found.");
    s.label = label.trim().slice(0, 80) || s.label;
    await this.kv.put("sessions", id, s);
  }

  async remove(id: string) {
    await this.kv.delete("sessions", id);
  }

  async clearAll() {
    await this.kv.clear("sessions");
  }

  async sanitize(text: string, sessionId: string, categories: Category[], sensitivity: Sensitivity): Promise<SanitizeResult> {
    const session = await this.get(sessionId);
    if (!session) throw new Error("Session not found.");
    const key = await vaultKey(this.kv);
    const found = detect(text, categories, sensitivity);
    const redactions: Redaction[] = [];
    let out = "";
    let cursor = 0;
    for (const d of found) {
      const value = text.slice(d.start, d.end);
      const digest = await sha256Hex(`${session.salt}\u0000${d.category}\u0000${normalise(value)}`);
      let entry = session.entries.find((e) => e.digest === digest && e.category === d.category);
      if (!entry) {
        const n = session.entries.filter((e) => e.category === d.category).length + 1;
        entry = { placeholder: `[${d.category}_${n}]`, category: d.category, digest, sealed: await seal(key, value) };
        session.entries.push(entry);
      }
      out += text.slice(cursor, d.start);
      const sanitizedStart = out.length;
      out += entry.placeholder;
      redactions.push({ ...d, placeholder: entry.placeholder, sanitizedStart, sanitizedEnd: out.length });
      cursor = d.end;
    }
    out += text.slice(cursor);
    session.updatedAt = new Date().toISOString();
    await this.kv.put("sessions", session.id, session);

    const placeholders: SanitizeResult["placeholders"] = [];
    const categoryCounts: SanitizeResult["categoryCounts"] = {};
    for (const r of redactions) {
      categoryCounts[r.category] = (categoryCounts[r.category] ?? 0) + 1;
      if (!placeholders.some((p) => p.placeholder === r.placeholder)) placeholders.push({ placeholder: r.placeholder, category: r.category });
    }
    return { sanitizedText: out, sessionId: session.id, redactions, placeholders, categoryCounts };
  }

  /** Which of the session's placeholders appear in this text (nothing is decrypted). */
  async preview(text: string, sessionId: string) {
    const session = await this.get(sessionId);
    if (!session) return { known: [] as MappingEntry[], unknown: 0 };
    const known: MappingEntry[] = [];
    let unknown = 0;
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      const entry = session.entries.find((e) => e.placeholder === m[0]);
      if (entry) {
        if (!known.includes(entry)) known.push(entry);
      } else unknown++;
    }
    return { known, unknown };
  }

  /**
   * Replace only placeholders stored in this session. Callers must authorise first (see Gateway).
   * Placeholders that aren't part of the session are left exactly as they are.
   */
  async restoreUnchecked(text: string, sessionId: string): Promise<{ text: string; restored: number; unknown: number }> {
    const session = await this.get(sessionId);
    if (!session) throw new Error("Session not found.");
    const key = await vaultKey(this.kv);
    const values = new Map<string, string>();
    for (const e of session.entries) values.set(e.placeholder, await unseal(key, e.sealed));
    let restored = 0;
    let unknown = 0;
    const result = text.replace(PLACEHOLDER_RE, (m) => {
      const v = values.get(m);
      if (v === undefined) {
        unknown++;
        return m;
      }
      restored++;
      return v;
    });
    return { text: result, restored, unknown };
  }
}

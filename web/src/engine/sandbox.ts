// A small file sandbox stored in the visitor's browser. Tools can only reach files in here.

import type { KV } from "./storage";

export const SEED_FILES: Record<string, string> = {
  "README.txt":
    "This sandbox lives in your browser. Tools can only read and write files in here.\n\n" +
    "  notes/      readable and writable\n  outbox/     writes need your approval\n  protected/  readable, never writable\n",
  "notes/welcome.txt": "Welcome to Privara. This file is safe to read.\n",
  "notes/client-brief.txt":
    "Client brief\n\nPrimary contact: Amina Bello, amina.bello@example.org, +234 803 555 0142.\n" +
    "Budget approved: ₦1,500,000. Kick-off is next Tuesday in Kaduna.\n",
  "protected/policy-notice.txt": "Files in protected/ can be read but never written by agents.\n",
};

export const MAX_FILE_CHARS = 200_000;

export interface Resolved {
  inside: boolean;
  path: string; // normalised path inside the sandbox, or the raw request if outside
}

/** Normalise a requested path. Absolute paths, drive letters, ~ and any .. that escapes are outside. */
export function resolvePath(requested: string): Resolved {
  const raw = requested.replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~") || raw.includes("\u0000")) {
    return { inside: false, path: raw.slice(0, 200) };
  }
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return { inside: false, path: raw.slice(0, 200) };
      parts.pop();
    } else parts.push(part);
  }
  return { inside: true, path: parts.join("/") || "." };
}

export class Sandbox {
  constructor(private kv: KV) {}

  async seed(force = false) {
    const seeded = await this.kv.get<boolean>("settings", "sandboxSeeded");
    if (seeded && !force) return;
    if (force) await this.kv.clear("files");
    for (const [path, content] of Object.entries(SEED_FILES)) await this.kv.put("files", path, content);
    await this.kv.put("settings", "sandboxSeeded", true);
  }

  async list(): Promise<{ path: string; size: number }[]> {
    const entries = await this.kv.entries<string>("files");
    return entries.map(([path, content]) => ({ path, size: content.length })).sort((a, b) => a.path.localeCompare(b.path));
  }

  read(path: string) {
    return this.kv.get<string>("files", path);
  }

  write(path: string, content: string) {
    return this.kv.put("files", path, content);
  }
}

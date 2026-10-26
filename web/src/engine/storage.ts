// Key-value storage in the visitor's browser (IndexedDB), with an in-memory fallback when the
// browser blocks storage (some private-browsing modes). Nothing here talks to the network.

export type StoreName = "keys" | "sessions" | "policies" | "files" | "history" | "settings";
const STORES: StoreName[] = ["keys", "sessions", "policies", "files", "history", "settings"];

export interface KV {
  readonly persistent: boolean;
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  entries<T>(store: StoreName): Promise<[string, T][]>;
  clear(store: StoreName): Promise<void>;
}

export class MemoryKV implements KV {
  readonly persistent = false;
  private data = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));

  async get<T>(store: StoreName, key: string) {
    return this.data.get(store)!.get(key) as T | undefined;
  }
  async put(store: StoreName, key: string, value: unknown) {
    this.data.get(store)!.set(key, structuredClone(value));
  }
  async delete(store: StoreName, key: string) {
    this.data.get(store)!.delete(key);
  }
  async entries<T>(store: StoreName) {
    return [...this.data.get(store)!.entries()] as [string, T][];
  }
  async clear(store: StoreName) {
    this.data.get(store)!.clear();
  }
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedKV implements KV {
  readonly persistent = true;
  constructor(private db: IDBDatabase) {}

  static open(name = "privara"): Promise<IndexedKV> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        for (const s of STORES) if (!request.result.objectStoreNames.contains(s)) request.result.createObjectStore(s);
      };
      request.onsuccess = () => resolve(new IndexedKV(request.result));
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("storage blocked"));
    });
  }

  private tx(store: StoreName, mode: IDBTransactionMode) {
    return this.db.transaction(store, mode).objectStore(store);
  }
  get<T>(store: StoreName, key: string) {
    return promisify(this.tx(store, "readonly").get(key)) as Promise<T | undefined>;
  }
  async put(store: StoreName, key: string, value: unknown) {
    await promisify(this.tx(store, "readwrite").put(value, key));
  }
  async delete(store: StoreName, key: string) {
    await promisify(this.tx(store, "readwrite").delete(key));
  }
  async entries<T>(store: StoreName) {
    const os = this.tx(store, "readonly");
    const [keys, values] = await Promise.all([promisify(os.getAllKeys()), promisify(os.getAll())]);
    return keys.map((k, i) => [String(k), values[i] as T]) as [string, T][];
  }
  async clear(store: StoreName) {
    await promisify(this.tx(store, "readwrite").clear());
  }
}

export async function openStorage(): Promise<KV> {
  try {
    if (typeof indexedDB === "undefined") throw new Error("no indexedDB");
    return await IndexedKV.open();
  } catch {
    return new MemoryKV();
  }
}

// ---- crypto helpers ------------------------------------------------------------------------
export function randomHex(bytes = 16): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Stable JSON with sorted keys, used for hashing tool calls. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A non-extractable AES-GCM key kept in the visitor's browser. Scripts can use it, never read it. */
export async function vaultKey(kv: KV): Promise<CryptoKey> {
  const existing = await kv.get<CryptoKey>("keys", "vault");
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await kv.put("keys", "vault", key);
  return key;
}

export interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

export async function seal(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { iv, data };
}

export async function unseal(key: CryptoKey, sealed: Sealed): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, key, sealed.data);
  return new TextDecoder().decode(plain);
}

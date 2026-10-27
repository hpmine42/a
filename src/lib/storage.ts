/**
 * Where finished pages live between launches.
 *
 * A scanner that forgets the four pages you shot because you switched apps is
 * not a scanner, it is a toy. Everything here is local and unencrypted on
 * purpose: there is no server to send it to, and the browser sandbox is the same
 * fence the camera already lives behind.
 *
 * The adapter interface exists for two reasons: IndexedDB is missing in some
 * private modes (and in jsdom), and the tests need a store they can drive
 * without a browser database.
 */

import type { Quad } from "./cv";

export type StoredPage = {
  id: number;
  name: string;
  quad: Quad;
  /** 0 | 90 | 180 | 270 — applied at render time, never baked into the photo. */
  rotation: number;
  /** "Keep the whole photo": no hairline inset, the page is the frame. */
  whole?: boolean;
  optimize: boolean;
  /** Small preview so the grid is usable before any pixels are decoded. */
  thumb: string | null;
  /** The source photo, JPEG. Null only if the browser refused to encode it. */
  src: Blob | null;
};

export type StoredMeta = {
  format: "a4" | "letter" | "fit";
  filename: string;
  activeId: number;
  /** Page order; records are keyed by id. */
  ids: number[];
};

export interface ProjectStore {
  readPages(): Promise<StoredPage[]>;
  writePage(page: StoredPage): Promise<void>;
  dropPage(id: number): Promise<void>;
  readMeta(): Promise<StoredMeta | null>;
  writeMeta(meta: StoredMeta): Promise<void>;
  wipe(): Promise<void>;
}

/* ------------------------------------------------------------- in-memory */

/** A store with no database behind it — used by the tests. */
export function memoryStore(): ProjectStore {
  const pages = new Map<number, StoredPage>();
  let meta: StoredMeta | null = null;
  return {
    readPages: async () => [...pages.values()],
    writePage: async (page) => void pages.set(page.id, page),
    dropPage: async (id) => void pages.delete(id),
    readMeta: async () => meta,
    writeMeta: async (next) => void (meta = next),
    wipe: async () => {
      pages.clear();
      meta = null;
    },
  };
}

/* -------------------------------------------------------------- IndexedDB */

const DB_NAME = "scano";
const DB_VERSION = 1;
const PAGES = "pages";
const META = "meta";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAGES)) db.createObjectStore(PAGES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // another tab upgraded the schema: stop pretending this handle works
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("indexeddb blocked"));
  });
  return dbPromise;
}

function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let request: IDBRequest<T> | void;
        try {
          request = work(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export function indexedDbStore(): ProjectStore {
  return {
    readPages: async () => (await run<StoredPage[]>(PAGES, "readonly", (s) => s.getAll())) ?? [],
    writePage: async (page) => {
      await run(PAGES, "readwrite", (s) => s.put(page));
    },
    dropPage: async (id) => {
      await run(PAGES, "readwrite", (s) => s.delete(id));
    },
    readMeta: async () => {
      const row = await run<StoredMeta & { key?: string }>(META, "readonly", (s) => s.get("scan"));
      if (!row) return null;
      return {
        format: row.format,
        filename: row.filename,
        activeId: row.activeId,
        ids: row.ids ?? [],
      };
    },
    writeMeta: async (meta) => {
      await run(META, "readwrite", (s) => s.put({ ...meta, key: "scan" }));
    },
    wipe: async () => {
      await run(PAGES, "readwrite", (s) => s.clear());
      await run(META, "readwrite", (s) => s.clear());
    },
  };
}

/* ------------------------------------------------------------------ access */

let current: ProjectStore | null | undefined;

/**
 * The store this session uses: IndexedDB when the browser has it, nothing when
 * it does not. Never throws — a scanner that refuses to open because storage is
 * unavailable would be a worse trade than one that forgets.
 */
export function projectStore(): ProjectStore | null {
  if (current !== undefined) return current;
  current = null;
  try {
    if (typeof indexedDB !== "undefined" && indexedDB) current = indexedDbStore();
  } catch {
    current = null;
  }
  return current;
}

/** Swap the store (tests), or disable persistence with `null`. */
export function useProjectStore(store: ProjectStore | null): void {
  current = store;
}

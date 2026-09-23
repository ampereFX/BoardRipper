import { beforeEach, describe, expect, it } from 'vitest';

import { fileViewPrefsStore } from '../store/file-view-prefs-store';
import {
  clearOverlayDisplayPreferences,
  loadOverlayDisplayPreferences,
  setOverlayDisplayPreferences,
} from './view-preferences';

/** Minimaler Fake-IndexedDB: genau genug für open + upgrade + get/put/delete.
 *  Die Werte werden in einer Map pro Store gehalten; asynchron wie im Browser
 *  via queueMicrotask. */
type StoreData = Map<string, Record<string, unknown>>;

class FakeIDBRequest<T> {
  result: T | undefined = undefined;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeObjectStore {
  private data: StoreData;
  private keyPath: string;

  constructor(data: StoreData, keyPath: string) {
    this.data = data;
    this.keyPath = keyPath;
  }

  get(key: string): FakeIDBRequest<unknown> {
    const req = new FakeIDBRequest<unknown>();
    const value = this.data.get(key);
    queueMicrotask(() => {
      req.result = value;
      req.onsuccess?.();
    });
    return req;
  }

  put(value: Record<string, unknown>): FakeIDBRequest<undefined> {
    const req = new FakeIDBRequest<undefined>();
    this.data.set(value[this.keyPath] as string, value);
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  delete(key: string): FakeIDBRequest<undefined> {
    const req = new FakeIDBRequest<undefined>();
    this.data.delete(key);
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
}

interface FakeTransaction {
  objectStore(name: string): FakeObjectStore;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

class FakeIDBDatabase {
  stores = new Map<string, { keyPath: string; data: StoreData }>();
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };

  createObjectStore(name: string, options: { keyPath: string }): void {
    this.stores.set(name, { keyPath: options.keyPath, data: new Map() });
  }

  transaction(name: string): FakeTransaction {
    const entry = this.stores.get(name);
    const tx: FakeTransaction = {
      objectStore: () => {
        if (!entry) throw new Error(`store ${name} existiert nicht`);
        return new FakeObjectStore(entry.data, entry.keyPath);
      },
      oncomplete: null,
      onerror: null,
      onabort: null,
    };
    queueMicrotask(() => tx.oncomplete?.());
    return tx;
  }
}

/** Installiert eine frische in-memory DB pro Test. Das Upgrade (Version 1 → 2)
 *  wird simuliert: bestehende "prefs"-Daten bleiben erhalten, der neue Store
 *  kommt dazu. */
function installFakeIndexedDB(): void {
  let db: FakeIDBDatabase | null = null;
  globalThis.indexedDB = {
    open: (_name: string, _version: number) => {
      const req = new FakeIDBRequest<FakeIDBDatabase>();
      queueMicrotask(() => {
        if (!db) db = new FakeIDBDatabase();
        if (!db.stores.has('prefs')) db.createObjectStore('prefs', { keyPath: 'fileKey' });
        if (!db.stores.has('overlay-prefs')) {
          db.createObjectStore('overlay-prefs', { keyPath: 'key' });
        }
        req.result = db;
        req.onsuccess?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe('overlay display preferences', () => {
  beforeEach(() => {
    installFakeIndexedDB();
    (fileViewPrefsStore as unknown as { dbPromise: Promise<IDBDatabase> | null }).dbPromise = null;
  });

  it('returns defaults when nothing is stored', async () => {
    const prefs = await loadOverlayDisplayPreferences('board-a', 'top');
    expect(prefs).toEqual({ visible: true, opacity: 0.5 });
  });

  it('persists a preference across separate loads (reload simulation)', async () => {
    await setOverlayDisplayPreferences('board-a', 'top', { visible: false, opacity: 0.8 });
    const prefs = await loadOverlayDisplayPreferences('board-a', 'top');
    expect(prefs).toEqual({ visible: false, opacity: 0.8 });
  });

  it('separates preferences by boardKey and side', async () => {
    await setOverlayDisplayPreferences('board-a', 'top', { opacity: 0.9 });
    await setOverlayDisplayPreferences('board-a', 'bottom', { opacity: 0.1 });
    await setOverlayDisplayPreferences('board-b', 'top', { opacity: 0.3 });

    expect(await loadOverlayDisplayPreferences('board-a', 'top')).toEqual({ visible: true, opacity: 0.9 });
    expect(await loadOverlayDisplayPreferences('board-a', 'bottom')).toEqual({ visible: true, opacity: 0.1 });
    expect(await loadOverlayDisplayPreferences('board-b', 'top')).toEqual({ visible: true, opacity: 0.3 });
    expect(await loadOverlayDisplayPreferences('board-b', 'bottom')).toEqual({ visible: true, opacity: 0.5 });
  });

  it('clamps opacity into 0..1 and treats NaN as default', async () => {
    await setOverlayDisplayPreferences('board-a', 'top', { opacity: 1.7 });
    expect((await loadOverlayDisplayPreferences('board-a', 'top')).opacity).toBe(1);
    await setOverlayDisplayPreferences('board-a', 'top', { opacity: -0.4 });
    expect((await loadOverlayDisplayPreferences('board-a', 'top')).opacity).toBe(0);
    await setOverlayDisplayPreferences('board-a', 'top', { opacity: Number.NaN });
    expect((await loadOverlayDisplayPreferences('board-a', 'top')).opacity).toBe(0.5);
  });

  it('preserves existing file-view prefs untouched', async () => {
    await fileViewPrefsStore.put('test-board.gbr', 123, 456, { rotation: 90 });
    await setOverlayDisplayPreferences('board-a', 'top', { opacity: 0.2 });

    const filePrefs = await fileViewPrefsStore.get('test-board.gbr', 123, 456);
    expect(filePrefs?.rotation).toBe(90);
    const overlayPrefs = await loadOverlayDisplayPreferences('board-a', 'top');
    expect(overlayPrefs.opacity).toBe(0.2);
  });

  it('clear deletes and reload returns defaults again', async () => {
    await setOverlayDisplayPreferences('board-a', 'top', { visible: false, opacity: 0.2 });
    await clearOverlayDisplayPreferences('board-a', 'top');
    const prefs = await loadOverlayDisplayPreferences('board-a', 'top');
    expect(prefs).toEqual({ visible: true, opacity: 0.5 });
  });
});

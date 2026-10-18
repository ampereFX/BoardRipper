import { Emitter } from '../store/emitter';
import { resolveBoardIdentity } from './board-identity';

const DB_NAME = 'boardripper-markers';
const STORE_NAME = 'markers';
const DB_VERSION = 1;

export interface Marker {
  id: string;
  fileKey: string;
  subboardKey: string;
  /** Normalized board-relative coordinates, each in the range 0..1. */
  x: number;
  y: number;
  side: MarkerSide;
  name: string;
  net: string | null;
  note: string;
  color: string;
  context: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MarkerSide = 'top' | 'bottom' | 'both';

export type MarkerCreateInput = Omit<Marker, 'id' | 'createdAt' | 'updatedAt'>;
export type MarkerUpdate = Partial<Omit<Marker, 'id' | 'fileKey' | 'subboardKey' | 'createdAt' | 'updatedAt'>>;
export type MarkerStatus = 'pending' | 'saved' | 'error';

export interface MarkerRuntimeState {
  status: MarkerStatus;
  error: string | null;
  retryCount: number;
}

export interface MarkerStoreSnapshot {
  markers: Marker[];
  runtime: Readonly<Record<string, MarkerRuntimeState>>;
  selectedMarkerId: string | null;
}

/** Adapter keeps the store's ordering/error behavior independently testable. */
export interface MarkerPersistence {
  getAll(): Promise<Marker[]>;
  put(marker: Marker): Promise<void>;
  delete(id: string): Promise<void>;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB-Anfrage fehlgeschlagen.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB-Transaktion fehlgeschlagen.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB-Transaktion abgebrochen.'));
  });
}

class IndexedDbMarkerPersistence implements MarkerPersistence {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB ist in dieser Umgebung nicht verfügbar.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error ?? new Error('Marker-Datenbank konnte nicht geöffnet werden.'));
      };
      request.onblocked = () => {
        this.dbPromise = null;
        reject(new Error('Marker-Datenbank ist durch einen anderen Tab blockiert.'));
      };
    });
    return this.dbPromise;
  }

  async getAll(): Promise<Marker[]> {
    const db = await this.openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const done = transactionDone(tx);
    const values = await requestResult(tx.objectStore(STORE_NAME).getAll() as IDBRequest<Marker[]>);
    await done;
    return values;
  }

  async put(marker: Marker): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_NAME).put(marker);
    await done;
  }

  async delete(id: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_NAME).delete(id);
    await done;
  }
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const savedState = (): MarkerRuntimeState => ({ status: 'saved', error: null, retryCount: 0 });

export class MarkerStore extends Emitter {
  private readonly persistence: MarkerPersistence;
  private readonly channel: BroadcastChannel | null;
  private markers = new Map<string, Marker>();
  private runtime = new Map<string, MarkerRuntimeState>();
  private writes = new Map<string, Promise<void>>();
  private writeVersions = new Map<string, number>();
  private recordVersions = new Map<string, number>();
  private selectedMarkerId: string | null = null;
  private snapshot: MarkerStoreSnapshot = { markers: [], runtime: {}, selectedMarkerId: null };
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;

  constructor(persistence: MarkerPersistence = new IndexedDbMarkerPersistence()) {
    super();
    this.persistence = persistence;
    let channel: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(DB_NAME);
    } catch {
      channel = null;
    }
    this.channel = channel;
    if (this.channel) this.channel.onmessage = () => { void this.hydrate(); };
  }

  subscribe(listener: (snapshot: MarkerStoreSnapshot) => void): () => void {
    const unsubscribe = super.subscribe(() => listener(this.getSnapshot()));
    return unsubscribe;
  }

  getSnapshot(): MarkerStoreSnapshot {
    return this.snapshot;
  }

  private publish(): void {
    this.snapshot = {
      markers: [...this.markers.values()],
      runtime: Object.fromEntries(this.runtime),
      selectedMarkerId: this.selectedMarkerId,
    };
    this.notify();
  }

  private setRuntime(id: string, state: MarkerRuntimeState): void {
    this.runtime.set(id, state);
    this.publish();
  }

  private bumpRecordVersion(id: string): void {
    this.recordVersions.set(id, (this.recordVersions.get(id) ?? 0) + 1);
  }

  private enqueue(id: string, operation: () => Promise<void>): { promise: Promise<void>; version: number } {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const version = (this.writeVersions.get(id) ?? 0) + 1;
    this.writeVersions.set(id, version);
    this.writes.set(id, current);
    void current.finally(() => {
      if (this.writes.get(id) === current) this.writes.delete(id);
    }).catch(() => {});
    return { promise: current, version };
  }

  private async save(id: string, operation: () => Promise<void>): Promise<boolean> {
    const current = this.runtime.get(id) ?? savedState();
    this.setRuntime(id, { ...current, status: 'pending', error: null });
    const queued = this.enqueue(id, operation);
    try {
      await queued.promise;
      if (this.writeVersions.get(id) === queued.version) {
        this.setRuntime(id, { ...savedState(), retryCount: current.retryCount });
      }
      this.channel?.postMessage({ type: 'changed' });
      return true;
    } catch (error) {
      if (this.writeVersions.get(id) === queued.version) {
        this.setRuntime(id, { status: 'error', error: errorMessage(error), retryCount: current.retryCount });
      }
      return false;
    }
  }

  getForTab(_tabId: number, fileKey: string, subboardKey?: string): Marker[] {
    return [...this.markers.values()].filter((marker) =>
      marker.fileKey === fileKey && (subboardKey === undefined || marker.subboardKey === subboardKey),
    );
  }

  getById(id: string): Marker | null {
    return this.markers.get(id) ?? null;
  }

  async resolveIdentity(tabId: number, subboardIndex: number | null) {
    return resolveBoardIdentity(tabId, subboardIndex);
  }

  hydrate(): Promise<void> {
    if (this.hydratePromise) return this.hydratePromise;
    const operation = this.readAndMerge();
    this.hydratePromise = operation;
    void operation.finally(() => {
      if (this.hydratePromise === operation) this.hydratePromise = null;
    }).catch(() => {});
    return operation;
  }

  private async readAndMerge(): Promise<void> {
    const versionsAtStart = new Map(this.recordVersions);
    try {
      const records = await this.persistence.getAll();
      const next = new Map<string, Marker>();
      for (const marker of records) {
        const id = marker.id;
        const versionChanged = (this.recordVersions.get(id) ?? 0) !== (versionsAtStart.get(id) ?? 0);
        if (!versionChanged) next.set(id, marker);
      }
      for (const [id, marker] of this.markers) {
        const status = this.runtime.get(id)?.status;
        const versionChanged = (this.recordVersions.get(id) ?? 0) !== (versionsAtStart.get(id) ?? 0);
        if (versionChanged || status === 'pending' || status === 'error') next.set(id, marker);
      }
      for (const [id, startVersion] of versionsAtStart) {
        const versionChanged = (this.recordVersions.get(id) ?? 0) !== startVersion;
        if (versionChanged && !this.markers.has(id)) next.delete(id);
      }
      this.markers = next;
      for (const marker of records) {
        if (!this.runtime.has(marker.id)) this.runtime.set(marker.id, savedState());
      }
      for (const id of this.runtime.keys()) {
        if (id !== '$database' && !this.markers.has(id)) this.runtime.delete(id);
      }
      this.runtime.delete('$database');
      if (this.selectedMarkerId && !this.markers.has(this.selectedMarkerId)) this.selectedMarkerId = null;
      this.hydrated = true;
      this.publish();
    } catch (error) {
      this.hydrated = false;
      this.setRuntime('$database', { status: 'error', error: errorMessage(error), retryCount: 0 });
    }
  }

  isHydrated(): boolean {
    return this.hydrated;
  }

  createOptimistic(input: MarkerCreateInput): { marker: Marker; persisted: Promise<void> } {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.x > 1 || input.y < 0 || input.y > 1) {
      throw new RangeError('Marker-Koordinaten müssen zwischen 0 und 1 liegen.');
    }
    const now = Date.now();
    const marker: Marker = { ...input, id: createId(), createdAt: now, updatedAt: now };
    this.bumpRecordVersion(marker.id);
    this.markers.set(marker.id, marker);
    this.runtime.set(marker.id, { status: 'pending', error: null, retryCount: 0 });
    this.publish();
    const persisted = this.save(marker.id, () => this.persistence.put(marker)).then(() => undefined);
    return { marker, persisted };
  }

  async create(input: MarkerCreateInput): Promise<Marker> {
    const { marker, persisted } = this.createOptimistic(input);
    await persisted;
    return marker;
  }

  async update(id: string, patch: MarkerUpdate): Promise<Marker | null> {
    const current = this.markers.get(id);
    if (!current) return null;
    const marker = { ...current, ...patch, updatedAt: Date.now() };
    if (!Number.isFinite(marker.x) || !Number.isFinite(marker.y) || marker.x < 0 || marker.x > 1 || marker.y < 0 || marker.y > 1) {
      throw new RangeError('Marker-Koordinaten müssen zwischen 0 und 1 liegen.');
    }
    this.bumpRecordVersion(id);
    this.markers.set(id, marker);
    this.publish();
    await this.save(id, () => this.persistence.put(marker));
    return marker;
  }

  async remove(id: string): Promise<Marker | null> {
    const marker = this.markers.get(id);
    if (!marker) return null;
    this.bumpRecordVersion(id);
    const previous = this.runtime.get(id) ?? savedState();
    this.setRuntime(id, { ...previous, status: 'pending', error: null });
    const queued = this.enqueue(id, async () => {
      await this.persistence.delete(id);
    });
    try {
      await queued.promise;
      if (this.writeVersions.get(id) === queued.version) {
        this.markers.delete(id);
        this.runtime.delete(id);
        if (this.selectedMarkerId === id) this.selectedMarkerId = null;
        this.publish();
      }
      this.channel?.postMessage({ type: 'changed' });
      return marker;
    } catch (error) {
      if (this.writeVersions.get(id) === queued.version) {
        this.setRuntime(id, { status: 'error', error: errorMessage(error), retryCount: previous.retryCount });
      }
      return null;
    }
  }

  async restore(marker: Marker): Promise<void> {
    this.bumpRecordVersion(marker.id);
    this.markers.set(marker.id, marker);
    this.runtime.set(marker.id, { status: 'pending', error: null, retryCount: 0 });
    this.publish();
    await this.save(marker.id, () => this.persistence.put(marker));
  }

  async retry(id: string): Promise<void> {
    const marker = this.markers.get(id);
    if (!marker) {
      if (id === '$database') await this.hydrate();
      return;
    }
    const previous = this.runtime.get(id) ?? savedState();
    this.bumpRecordVersion(id);
    this.runtime.set(id, { status: 'pending', error: null, retryCount: previous.retryCount + 1 });
    this.publish();
    const queued = this.enqueue(id, () => this.persistence.put(marker));
    try {
      await queued.promise;
      if (this.writeVersions.get(id) === queued.version) {
        this.setRuntime(id, { status: 'saved', error: null, retryCount: previous.retryCount + 1 });
      }
      this.channel?.postMessage({ type: 'changed' });
    } catch (error) {
      if (this.writeVersions.get(id) === queued.version) {
        this.setRuntime(id, { status: 'error', error: errorMessage(error), retryCount: previous.retryCount + 1 });
      }
    }
  }

  selectMarker(id: string | null): void {
    if (id !== null && !this.markers.has(id)) return;
    if (id === this.selectedMarkerId) return;
    this.selectedMarkerId = id;
    this.publish();
  }
}

export const markerStore = new MarkerStore();

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __markerStore?: typeof markerStore }).__markerStore = markerStore;
}

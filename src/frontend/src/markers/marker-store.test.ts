import { describe, expect, it } from 'vitest';
import { MarkerStore, type Marker, type MarkerPersistence } from './marker-store';

class MemoryPersistence implements MarkerPersistence {
  records = new Map<string, Marker>();
  failNext: Error | null = null;
  async getAll(): Promise<Marker[]> { return [...this.records.values()]; }
  async put(marker: Marker): Promise<void> {
    if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; }
    this.records.set(marker.id, marker);
  }
  async delete(id: string): Promise<void> {
    if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; }
    this.records.delete(id);
  }
}

const input = (subboardKey = 'sub-a') => ({
  fileKey: 'board.brd:100:5', subboardKey, x: 0.25, y: 0.75,
  side: 'top' as const, name: 'U1', net: 'GND', note: 'Inspect', color: '#ff0000', context: null,
});

describe('MarkerStore', () => {
  it('creates and filters persistent markers by file and optional subboard identity', async () => {
    const persistence = new MemoryPersistence();
    const store = new MarkerStore(persistence);
    const first = await store.create(input());
    const second = await store.create(input('sub-b'));

    expect(store.getForTab(3, first.fileKey)).toHaveLength(2);
    expect(store.getForTab(3, first.fileKey, 'sub-a')).toEqual([first]);
    expect(persistence.records.size).toBe(2);
    expect(store.getSnapshot().runtime[first.id].status).toBe('saved');
    expect(second.side).toBe('top');
  });

  it('exposes an optimistic marker id before IndexedDB completes', async () => {
    const persistence = new MemoryPersistence();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalPut = persistence.put.bind(persistence);
    persistence.put = async (marker) => { await gate; await originalPut(marker); };
    const store = new MarkerStore(persistence);
    const pending = store.createOptimistic(input());
    expect(store.getById(pending.marker.id)).toEqual(pending.marker);
    expect(store.getSnapshot().runtime[pending.marker.id].status).toBe('pending');
    release();
    await pending.persisted;
    expect(store.getSnapshot().runtime[pending.marker.id].status).toBe('saved');
  });

  it('updates, removes, and restores a marker with the same id', async () => {
    const persistence = new MemoryPersistence();
    const store = new MarkerStore(persistence);
    const marker = await store.create(input());
    const updated = await store.update(marker.id, { note: 'Check again' });
    expect(updated?.note).toBe('Check again');

    const removed = await store.remove(marker.id);
    expect(removed?.id).toBe(marker.id);
    expect(store.getSnapshot().markers).toEqual([]);
    await store.restore(removed!);
    expect(store.getSnapshot().markers[0].id).toBe(marker.id);
    expect(persistence.records.get(marker.id)?.note).toBe('Check again');
  });

  it('serializes rapid edits and remove/restore so the latest intent wins', async () => {
    const persistence = new MemoryPersistence();
    const store = new MarkerStore(persistence);
    const marker = await store.create(input());
    const originalPut = persistence.put.bind(persistence);
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    persistence.put = async (value) => {
      if (value.note === 'first edit') { markStarted(); await gate; }
      await originalPut(value);
    };

    const firstEdit = store.update(marker.id, { note: 'first edit' });
    await started;
    const lastEdit = store.update(marker.id, { note: 'last edit' });
    release();
    await Promise.all([firstEdit, lastEdit]);
    expect(persistence.records.get(marker.id)?.note).toBe('last edit');

    let deleteStarted!: () => void;
    let releaseDelete!: () => void;
    const startedDelete = new Promise<void>((resolve) => { deleteStarted = resolve; });
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const originalDelete = persistence.delete.bind(persistence);
    persistence.delete = async (id) => { deleteStarted(); await deleteGate; await originalDelete(id); };
    const removal = store.remove(marker.id);
    await startedDelete;
    const restore = store.restore(store.getById(marker.id)!);
    releaseDelete();
    await Promise.all([removal, restore]);
    expect(persistence.records.get(marker.id)?.note).toBe('last edit');
    expect(store.getById(marker.id)?.note).toBe('last edit');
  });

  it('exposes persistence errors and does not report a failed deletion as undoable', async () => {
    const persistence = new MemoryPersistence();
    const store = new MarkerStore(persistence);
    const marker = await store.create(input());
    persistence.failNext = new Error('disk full');
    expect(await store.remove(marker.id)).toBeNull();
    expect(store.getSnapshot().markers).toHaveLength(1);
    expect(store.getSnapshot().runtime[marker.id]).toMatchObject({ status: 'error', error: 'disk full' });

    await store.retry(marker.id);
    expect(store.getSnapshot().runtime[marker.id].status).toBe('saved');
  });

  it('keeps local failed records while hydrating a database snapshot', async () => {
    const persistence = new MemoryPersistence();
    const store = new MarkerStore(persistence);
    persistence.failNext = new Error('offline');
    const marker = await store.create(input());
    await store.hydrate();
    expect(store.getSnapshot().markers.map((entry) => entry.id)).toContain(marker.id);
    expect(store.getSnapshot().runtime[marker.id].status).toBe('error');
  });

  it('deduplicates hydration and keeps a create made while the read is in flight', async () => {
    const persistence = new MemoryPersistence();
    let finishRead!: (records: Marker[]) => void;
    persistence.getAll = () => new Promise((resolve) => { finishRead = resolve; });
    const store = new MarkerStore(persistence);
    const hydration = store.hydrate();
    expect(store.hydrate()).toBe(hydration);
    const marker = await store.create(input());
    finishRead([]);
    await hydration;
    expect(store.getById(marker.id)).toEqual(marker);
  });

  it('keeps a pending local edit when a cross-tab hydration sees the older database value', async () => {
    const persistence = new MemoryPersistence();
    const store = new MarkerStore(persistence);
    const marker = await store.create(input());
    const originalPut = persistence.put.bind(persistence);
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    persistence.put = async (value) => {
      if (value.note === 'pending local edit') { markStarted(); await gate; }
      await originalPut(value);
    };

    const edit = store.update(marker.id, { note: 'pending local edit' });
    await started;
    await store.hydrate();
    expect(store.getById(marker.id)?.note).toBe('pending local edit');
    release();
    await edit;
    expect(persistence.records.get(marker.id)?.note).toBe('pending local edit');
  });

  it('reconciles edits to different markers across two stores sharing persistence', async () => {
    const persistence = new MemoryPersistence();
    const tabA = new MarkerStore(persistence);
    const markerA = await tabA.create(input('sub-a'));
    const markerB = await tabA.create(input('sub-b'));
    const tabB = new MarkerStore(persistence);
    await tabB.hydrate();

    await Promise.all([
      tabA.update(markerA.id, { note: 'edited in tab A' }),
      tabB.update(markerB.id, { note: 'edited in tab B' }),
    ]);
    await Promise.all([tabA.hydrate(), tabB.hydrate()]);

    expect(tabA.getById(markerA.id)?.note).toBe('edited in tab A');
    expect(tabA.getById(markerB.id)?.note).toBe('edited in tab B');
    expect(tabB.getById(markerA.id)?.note).toBe('edited in tab A');
    expect(tabB.getById(markerB.id)?.note).toBe('edited in tab B');
  });

  it('publishes selection changes without persisting them', async () => {
    const persistence = new MemoryPersistence();
    const store = new MarkerStore(persistence);
    const marker = await store.create(input());
    let selected: string | null = null;
    const unsubscribe = store.subscribe((snapshot) => { selected = snapshot.selectedMarkerId; });
    store.selectMarker(marker.id);
    expect(selected).toBe(marker.id);
    expect(persistence.records.get(marker.id)).not.toHaveProperty('selectedMarkerId');
    unsubscribe();
  });
});

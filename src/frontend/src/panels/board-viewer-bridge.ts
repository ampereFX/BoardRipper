/**
 * Cross-panel bridge for board viewer panels.
 *
 * Lives in a sibling file (not BoardViewerPanel.tsx) so the panel module can
 * keep `react-refresh/only-export-components` happy. Consumers (Toolbar,
 * ContextMenu, PdfViewerPanel, useKeyboardShortcuts, cross-target-search,
 * BoardRenderer) import the named functions from here; BoardViewerPanel
 * registers/unregisters its per-tab handlers via the *register* APIs.
 */

import { boardStore } from '../store/board-store';

type SearchHandler = (query: string) => void;
type SidebarTabName = 'layers' | 'info' | 'search' | 'worklist' | 'revisions' | 'markers';
type SidebarTabHandler = (tab: SidebarTabName) => void;
type MarkerNavigationHandler = (markerId: string) => void;
type MarkerPanelHandler = (markerId?: string, focusNote?: boolean) => void;

const searchHandlers = new Map<number, SearchHandler>();
const sidebarTabHandlers = new Map<number, SidebarTabHandler>();
const markerNavigationHandlers = new Map<number, MarkerNavigationHandler>();
const pendingMarkerNavigation = new Map<number, string>();
const markerPanelHandlers = new Map<number, MarkerPanelHandler>();
const pendingMarkerPanel = new Map<number, { markerId?: string; focusNote: boolean }>();

export function registerBoardSearchHandler(tabId: number, fn: SearchHandler): () => void {
  searchHandlers.set(tabId, fn);
  return () => { searchHandlers.delete(tabId); };
}

export function registerBoardSidebarTabHandler(tabId: number, fn: SidebarTabHandler): () => void {
  sidebarTabHandlers.set(tabId, fn);
  return () => { sidebarTabHandlers.delete(tabId); };
}

/** Register the live renderer callback used by marker rows and marker clicks.
 *  A navigation request made before the board renderer mounts is replayed once
 *  the matching tab registers. */
export function registerBoardMarkerNavigationHandler(tabId: number, fn: MarkerNavigationHandler): () => void {
  markerNavigationHandlers.set(tabId, fn);
  const pending = pendingMarkerNavigation.get(tabId);
  if (pending) {
    pendingMarkerNavigation.delete(tabId);
    fn(pending);
  }
  return () => {
    if (markerNavigationHandlers.get(tabId) === fn) markerNavigationHandlers.delete(tabId);
  };
}

export function navigateToMarker(tabId: number, markerId: string): void {
  const handler = markerNavigationHandlers.get(tabId);
  if (handler) handler(markerId);
  else pendingMarkerNavigation.set(tabId, markerId);
}

/** Register the panel callback used to focus a selected marker or open the
 *  marker panel for a create-at-location request. */
export function registerBoardMarkerPanelHandler(tabId: number, fn: MarkerPanelHandler): () => void {
  markerPanelHandlers.set(tabId, fn);
  if (pendingMarkerPanel.has(tabId)) {
    const pending = pendingMarkerPanel.get(tabId);
    pendingMarkerPanel.delete(tabId);
    fn(pending?.markerId, pending?.focusNote);
  }
  return () => {
    if (markerPanelHandlers.get(tabId) === fn) markerPanelHandlers.delete(tabId);
  };
}

export function openMarkerPanel(tabId: number, markerId?: string, focusNote = false): void {
  openBoardSidebarTab('markers', tabId);
  const handler = markerPanelHandlers.get(tabId);
  if (handler) handler(markerId, focusNote);
  else pendingMarkerPanel.set(tabId, { markerId, focusNote });
}

export function openBoardSearch(query: string, tabId?: number): void {
  if (tabId != null) {
    searchHandlers.get(tabId)?.(query);
  } else {
    const activeId = boardStore.activeTabId;
    if (activeId != null) searchHandlers.get(activeId)?.(query);
  }
}

export function openBoardSidebarTab(tab: SidebarTabName, tabId?: number): void {
  if (tabId != null) {
    sidebarTabHandlers.get(tabId)?.(tab);
  } else {
    const activeId = boardStore.activeTabId;
    if (activeId != null) sidebarTabHandlers.get(activeId)?.(tab);
  }
}

export type { SidebarTabName };

import type {
  DetailsSectionId,
  MonitorState,
  OverviewSectionId,
  PanelLayoutState,
  PanelSectionId,
  PanelTabId,
} from '../types.ts';
import { renderBottomPanelBodyHtml, renderBottomPanelHtml, type PanelUiState } from './bottomPanelHtml.ts';

const DEFAULT_TAB_ORDER: PanelTabId[] = ['overview', 'details'];
const DEFAULT_OVERVIEW_SECTIONS: OverviewSectionId[] = ['quota', 'sessions', 'forecast', 'unattached'];
const DEFAULT_DETAILS_SECTIONS: DetailsSectionId[] = ['sessionSummary', 'breakdown', 'subagents', 'contextChart'];
const ALL_SECTIONS: PanelSectionId[] = [...DEFAULT_OVERVIEW_SECTIONS, ...DEFAULT_DETAILS_SECTIONS];

export const DEFAULT_PANEL_LAYOUT: PanelLayoutState = {
  tabOrder: [...DEFAULT_TAB_ORDER],
  sectionOrder: {
    overview: [...DEFAULT_OVERVIEW_SECTIONS],
    details: [...DEFAULT_DETAILS_SECTIONS],
  },
  collapsedTabs: [],
  collapsedSections: [],
};

function mergeOrder<T extends string>(candidate: unknown, defaults: readonly T[]): T[] {
  const validSet = new Set<T>(defaults);
  const result: T[] = [];
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      if (typeof item === 'string' && validSet.has(item as T) && !result.includes(item as T)) {
        result.push(item as T);
      }
    }
  }
  for (const item of defaults) {
    if (!result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

function filterValid<T extends string>(candidate: unknown, defaults: readonly T[]): T[] {
  if (!Array.isArray(candidate)) return [];
  const validSet = new Set<T>(defaults);
  const result: T[] = [];
  for (const item of candidate) {
    if (typeof item === 'string' && validSet.has(item as T) && !result.includes(item as T)) {
      result.push(item as T);
    }
  }
  return result;
}

export function sanitizePanelLayout(input?: Partial<PanelLayoutState> | null): PanelLayoutState {
  return {
    tabOrder: mergeOrder(input?.tabOrder, DEFAULT_TAB_ORDER),
    sectionOrder: {
      overview: mergeOrder(input?.sectionOrder?.overview, DEFAULT_OVERVIEW_SECTIONS),
      details: mergeOrder(input?.sectionOrder?.details, DEFAULT_DETAILS_SECTIONS),
    },
    collapsedTabs: filterValid(input?.collapsedTabs, DEFAULT_TAB_ORDER),
    collapsedSections: filterValid(input?.collapsedSections, ALL_SECTIONS),
  };
}

export interface WebviewLike {
  html: string;
  postMessage(message: unknown): Thenable<boolean> | Promise<boolean> | boolean;
  onDidReceiveMessage(listener: (message: any) => void): { dispose(): void };
  cspSource?: string;
  options?: any;
}

export interface WebviewViewLike {
  visible: boolean;
  webview: WebviewLike;
  onDidChangeVisibility(listener: () => void): { dispose(): void };
  onDidDispose(listener: () => void): { dispose(): void };
}

export interface BottomPanelCallbacks {
  onSelectSession: (sessionId: string) => void;
  onPinSession: (sessionId: string) => void;
  onUnpinSession: () => void;
  onToggleScope: () => void;
  onRefresh: () => void;
  initialLayout?: Partial<PanelLayoutState>;
  onLayoutChange?: (layout: PanelLayoutState) => void;
}

function generateNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class BottomPanelController {
  private view: WebviewViewLike | null = null;
  private initialized = false;
  private latestState: MonitorState | null = null;
  private disposables: Array<{ dispose(): void }> = [];
  private callbacks: BottomPanelCallbacks;
  private activeTab: PanelTabId = 'overview';
  private expandedIds = new Set<string>();
  private breakdownOpen = false;
  private openHelpIds = new Set<string>();
  private expandedLists = new Set<string>();
  private layout: PanelLayoutState;
  private lastPushedBodyHtml: string | null = null;

  constructor(callbacks: BottomPanelCallbacks) {
    this.callbacks = callbacks;
    this.layout = sanitizePanelLayout(callbacks.initialLayout);
  }

  public setTab(tab: PanelTabId): void {
    this.activeTab = tab;
    this.pushCurrentBody();
  }

  public getLayout(): PanelLayoutState {
    return this.layout;
  }

  public getUiState(): PanelUiState {
    return {
      activeTab: this.activeTab,
      expandedIds: this.expandedIds,
      breakdownOpen: this.breakdownOpen,
      openHelpIds: this.openHelpIds,
      expandedLists: this.expandedLists,
      layout: this.layout,
    };
  }

  public setView(view: WebviewViewLike): void {
    // Clean up previous view listeners if re-setting view
    this.disposeViewListeners();

    this.view = view;
    this.initialized = false;

    this.disposables.push(
      view.onDidChangeVisibility(() => {
        this.handleVisibilityChange();
      }),
    );

    this.disposables.push(
      view.webview.onDidReceiveMessage((message: any) => {
        this.handleInboundMessage(message);
      }),
    );

    this.disposables.push(
      view.onDidDispose(() => {
        this.disposeViewListeners();
        this.view = null;
        this.initialized = false;
        this.lastPushedBodyHtml = null;
      }),
    );

    if (view.visible && this.latestState) {
      this.renderFullHtml();
    }
  }

  public update(state: MonitorState): void {
    this.latestState = state;
    this.pushCurrentBody();
  }

  private pushCurrentBody(): void {
    // Do NOT render HTML or postMessage while hidden or if view not set
    if (!this.view || !this.view.visible || !this.latestState) {
      return;
    }

    if (!this.initialized) {
      this.renderFullHtml();
      return;
    }

    const bodyHtml = renderBottomPanelBodyHtml(this.latestState, this.getUiState());
    // Skip no-op postMessage when the rendered body is unchanged
    if (bodyHtml === this.lastPushedBodyHtml) {
      return;
    }
    this.lastPushedBodyHtml = bodyHtml;
    // Targeted update: the webview applies only bodyHtml, so the unused state payload is not posted
    this.view.webview.postMessage({
      type: 'updateState',
      bodyHtml,
    });
  }

  private handleVisibilityChange(): void {
    if (!this.view || !this.view.visible || !this.latestState) {
      return;
    }

    this.pushCurrentBody();
  }

  private renderFullHtml(): void {
    if (!this.view || !this.latestState) return;
    const nonce = generateNonce();
    const cspSource = this.view.webview.cspSource || '';
    const uiState = this.getUiState();
    this.view.webview.html = renderBottomPanelHtml(this.latestState, nonce, cspSource, uiState);
    this.lastPushedBodyHtml = renderBottomPanelBodyHtml(this.latestState, uiState);
    this.initialized = true;
  }

  private handleInboundMessage(message: any): void {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'selectSession' && typeof message.sessionId === 'string') {
      this.activeTab = 'details';
      this.callbacks.onSelectSession(message.sessionId);
      this.pushCurrentBody();
    } else if (message.type === 'switchTab') {
      this.activeTab = message.tab === 'details' ? 'details' : 'overview';
      this.pushCurrentBody();
    } else if (message.type === 'toggleExpand' && typeof message.sessionId === 'string') {
      if (this.expandedIds.has(message.sessionId)) {
        this.expandedIds.delete(message.sessionId);
      } else {
        this.expandedIds.add(message.sessionId);
      }
      this.pushCurrentBody();
    } else if (message.type === 'toggleListExpand' && (message.list === 'sessions' || message.list === 'unattached')) {
      const key = message.list;
      if (this.expandedLists.has(key)) this.expandedLists.delete(key);
      else this.expandedLists.add(key);
      this.pushCurrentBody();
    } else if (message.type === 'toggleBreakdown') {
      this.breakdownOpen = typeof message.open === 'boolean' ? message.open : !this.breakdownOpen;
      this.pushCurrentBody();
    } else if (message.type === 'toggleHelp' && typeof message.helpId === 'string') {
      const isOpen = typeof message.open === 'boolean' ? message.open : !this.openHelpIds.has(message.helpId);
      if (isOpen) {
        this.openHelpIds.add(message.helpId);
      } else {
        this.openHelpIds.delete(message.helpId);
      }
      this.pushCurrentBody();
    } else if (message.type === 'toggleTabCollapse' && (message.tab === 'overview' || message.tab === 'details')) {
      const tab = message.tab as PanelTabId;
      const collapsed = new Set(this.layout.collapsedTabs);
      if (collapsed.has(tab)) {
        collapsed.delete(tab);
      } else {
        collapsed.add(tab);
      }
      this.updateLayout({ ...this.layout, collapsedTabs: [...collapsed] });
    } else if (message.type === 'toggleSectionCollapse' && typeof message.sectionId === 'string') {
      const id = message.sectionId as PanelSectionId;
      if (ALL_SECTIONS.includes(id)) {
        const collapsed = new Set(this.layout.collapsedSections);
        if (collapsed.has(id)) {
          collapsed.delete(id);
        } else {
          collapsed.add(id);
        }
        this.updateLayout({ ...this.layout, collapsedSections: [...collapsed] });
      }
    } else if (message.type === 'reorderTabs' && Array.isArray(message.order)) {
      this.updateLayout({
        ...this.layout,
        tabOrder: mergeOrder(message.order, DEFAULT_TAB_ORDER),
      });
    } else if (
      message.type === 'reorderSections' &&
      (message.tab === 'overview' || message.tab === 'details') &&
      Array.isArray(message.order)
    ) {
      const tab = message.tab as PanelTabId;
      this.updateLayout({
        ...this.layout,
        sectionOrder: {
          ...this.layout.sectionOrder,
          [tab]:
            tab === 'overview'
              ? mergeOrder(message.order, DEFAULT_OVERVIEW_SECTIONS)
              : mergeOrder(message.order, DEFAULT_DETAILS_SECTIONS),
        },
      });
    } else if (message.type === 'pinSession' && typeof message.sessionId === 'string') {
      this.callbacks.onPinSession(message.sessionId);
    } else if (message.type === 'unpinSession') {
      this.callbacks.onUnpinSession();
    } else if (message.type === 'toggleScope') {
      this.callbacks.onToggleScope();
    } else if (message.type === 'refresh') {
      this.callbacks.onRefresh();
    }
  }

  private updateLayout(next: PanelLayoutState): void {
    this.layout = sanitizePanelLayout(next);
    this.callbacks.onLayoutChange?.(this.layout);
    this.pushCurrentBody();
  }

  private disposeViewListeners(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  public dispose(): void {
    this.disposeViewListeners();
    this.view = null;
    this.initialized = false;
    this.lastPushedBodyHtml = null;
    this.openHelpIds.clear();
  }
}

export function createBottomPanelProvider(
  _vscodeApi: any,
  callbacks: BottomPanelCallbacks,
): {
  controller: BottomPanelController;
  resolveWebviewView(
    webviewView: any,
    context?: any,
    token?: any,
  ): void | Promise<void>;
} {
  const controller = new BottomPanelController(callbacks);

  return {
    controller,
    resolveWebviewView(webviewView: any): void {
      if (webviewView.webview) {
        webviewView.webview.options = {
          enableScripts: true,
        };
      }
      controller.setView(webviewView);
    },
  };
}

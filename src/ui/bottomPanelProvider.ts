import type { MonitorState } from '../types.ts';
import { renderBottomPanelBodyHtml, renderBottomPanelHtml, type PanelUiState } from './bottomPanelHtml.ts';

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
  private activeTab: 'overview' | 'details' = 'overview';
  private expandedIds = new Set<string>();
  private breakdownOpen = false;
  private lastPushedBodyHtml: string | null = null;

  constructor(callbacks: BottomPanelCallbacks) {
    this.callbacks = callbacks;
  }

  public setTab(tab: 'overview' | 'details'): void {
    this.activeTab = tab;
    this.pushCurrentBody();
  }

  public getUiState(): PanelUiState {
    return {
      activeTab: this.activeTab,
      expandedIds: this.expandedIds,
      breakdownOpen: this.breakdownOpen,
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
    } else if (message.type === 'toggleBreakdown') {
      this.breakdownOpen = typeof message.open === 'boolean' ? message.open : !this.breakdownOpen;
      this.pushCurrentBody();
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

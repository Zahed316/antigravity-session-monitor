import type * as vscode from 'vscode';
import type { MonitorState } from '../types.ts';
import { renderBottomPanelBodyHtml, renderBottomPanelHtml } from './bottomPanelHtml.ts';

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

  constructor(callbacks: BottomPanelCallbacks) {
    this.callbacks = callbacks;
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
      }),
    );

    if (view.visible && this.latestState) {
      this.renderFullHtml();
    }
  }

  public update(state: MonitorState): void {
    this.latestState = state;

    // Do NOT render HTML or postMessage while hidden or if view not set
    if (!this.view || !this.view.visible) {
      return;
    }

    if (!this.initialized) {
      this.renderFullHtml();
    } else {
      this.view.webview.postMessage({
        type: 'updateState',
        state,
        bodyHtml: renderBottomPanelBodyHtml(state),
      });
    }
  }

  private handleVisibilityChange(): void {
    if (!this.view || !this.view.visible || !this.latestState) {
      return;
    }

    if (!this.initialized) {
      this.renderFullHtml();
    } else {
      this.view.webview.postMessage({
        type: 'updateState',
        state: this.latestState,
        bodyHtml: renderBottomPanelBodyHtml(this.latestState),
      });
    }
  }

  private renderFullHtml(): void {
    if (!this.view || !this.latestState) return;
    const nonce = generateNonce();
    const cspSource = this.view.webview.cspSource || '';
    this.view.webview.html = renderBottomPanelHtml(this.latestState, nonce, cspSource);
    this.initialized = true;
  }

  private handleInboundMessage(message: any): void {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'selectSession' && typeof message.sessionId === 'string') {
      this.callbacks.onSelectSession(message.sessionId);
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

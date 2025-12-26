/**
 * 聊天视图提供者 - 在侧边栏内显示聊天对话框
 */

import * as vscode from 'vscode';
import { ChatService, ChatMessage } from '../services/ChatService';
import { IndexProgressUpdate } from '../index/manager';
import { getVSCodeConfig } from '../utils/VSCodeAdapter';

/**
 * 聊天 WebviewView 提供者
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ace-sidebar.chatView';

  private _view?: vscode.WebviewView;
  private chatService?: ChatService;
  private messages: ChatMessage[] = [];
  private lastIndexProgress: IndexProgressUpdate | null = null;
  private isFirstVisit: boolean = false;
  private isConfigured: boolean = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    // 检测是否首次访问（同步检查）
    this.checkFirstVisit();
  }

  /**
   * 设置 ChatService 实例
   */
  public setChatService(chatService: ChatService): void {
    this.chatService = chatService;
    // 设置进度报告器
    chatService.setProgressReporter((update) => {
      this.reportIndexProgress(update);
    });
  }

  /**
   * 设置配置状态
   */
  public setConfigured(configured: boolean): void {
    this.isConfigured = configured;
    this.updateWebview();
  }

  /**
   * 检查是否首次访问
   */
  private checkFirstVisit(): void {
    const hasVisited = this._context.globalState.get<boolean>('ace-sidebar.hasVisited', false);
    if (!hasVisited) {
      this.isFirstVisit = true;
      // 异步更新状态，但不等待
      this._context.globalState.update('ace-sidebar.hasVisited', true).then(() => {
        // 状态已更新
      });
    }
  }

  /**
   * 检查配置状态
   */
  private checkConfigState(): void {
    try {
      getVSCodeConfig();
      this.isConfigured = true;
    } catch {
      this.isConfigured = false;
    }
  }

  /**
   * 解析 WebviewView
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    // 在解析时检查配置状态
    this.checkConfigState();

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this.getWebviewContent(webviewView.webview);

    // 处理来自 WebView 的消息
    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'sendMessage':
            await this.handleUserMessage(message.text);
            break;
          case 'codebaseSearch':
            await this.handleCodebaseSearch(message.text);
            break;
          case 'promptEnhancement':
            await this.handlePromptEnhancement(message.text);
            break;
          case 'clearChat':
            this.clearChat();
            break;
          case 'openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'ace-sidebar');
            break;
          case 'dismissFirstVisit':
            this.isFirstVisit = false;
            // 保存用户已查看过引导的状态
            this._context.globalState.update('ace-sidebar.hasVisited', true);
            this.updateWebview();
            break;
        }
      }
    );

    // 发送初始状态（包括首次访问状态和配置状态）
    this.updateWebview();

    if (this.lastIndexProgress) {
      this.reportIndexProgress(this.lastIndexProgress);
    }
  }

  /**
   * 处理代码搜索
   */
  private async handleCodebaseSearch(userMessage: string): Promise<void> {
    if (!userMessage.trim() || !this.chatService) {
      return;
    }

    // 如果未配置，不允许发送消息
    if (!this.isConfigured) {
      vscode.window.showWarningMessage('请先完成配置才能使用代码搜索功能', '打开设置').then((selection) => {
        if (selection === '打开设置') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'ace-sidebar');
        }
      });
      return;
    }

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: this.generateMessageId(),
      role: 'user',
      content: `[代码搜索] ${userMessage}`,
      timestamp: Date.now()
    };
    this.messages.push(userMsg);
    this.updateWebview();

    // 显示加载状态
    const loadingMsg: ChatMessage = {
      id: this.generateMessageId(),
      role: 'assistant',
      content: '正在搜索代码库...',
      timestamp: Date.now()
    };
    this.messages.push(loadingMsg);
    this.updateWebview();

    try {
      // 使用 ChatService 处理代码搜索
      const result = await this.chatService!.handleCodebaseSearch(userMessage);

      // 移除加载消息，添加实际回复
      this.messages.pop();
      const assistantMsg: ChatMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: result || '抱歉，没有找到相关信息。',
        timestamp: Date.now()
      };
      this.messages.push(assistantMsg);
      this.updateWebview();
    } catch (error) {
      // 移除加载消息，添加错误消息
      this.messages.pop();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const friendlyMessage = this.getFriendlyErrorMessage(errorMessage);
      const errorMsg: ChatMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: `❌ 错误: ${friendlyMessage}`,
        timestamp: Date.now()
      };
      this.messages.push(errorMsg);
      this.updateWebview();
    }
  }

  /**
   * 处理提示词增强
   */
  private async handlePromptEnhancement(userMessage: string): Promise<void> {
    if (!userMessage.trim() || !this.chatService) {
      return;
    }

    // 如果未配置，不允许发送消息
    if (!this.isConfigured) {
      vscode.window.showWarningMessage('请先完成配置才能使用提示词增强功能', '打开设置').then((selection) => {
        if (selection === '打开设置') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'ace-sidebar');
        }
      });
      return;
    }

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: this.generateMessageId(),
      role: 'user',
      content: `[提示词增强] ${userMessage}`,
      timestamp: Date.now()
    };
    this.messages.push(userMsg);
    this.updateWebview();

    // 显示加载状态
    const loadingMsg: ChatMessage = {
      id: this.generateMessageId(),
      role: 'assistant',
      content: '正在增强提示词...',
      timestamp: Date.now()
    };
    this.messages.push(loadingMsg);
    this.updateWebview();

    try {
      // 使用 ChatService 处理提示词增强
      const result = await this.chatService!.handlePromptEnhancement(userMessage);

      // 移除加载消息，添加实际回复
      this.messages.pop();
      const assistantMsg: ChatMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: result || '抱歉，提示词增强失败。',
        timestamp: Date.now()
      };
      this.messages.push(assistantMsg);
      this.updateWebview();
    } catch (error) {
      // 移除加载消息，添加错误消息
      this.messages.pop();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const friendlyMessage = this.getFriendlyErrorMessage(errorMessage);
      const errorMsg: ChatMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: `❌ 错误: ${friendlyMessage}`,
        timestamp: Date.now()
      };
      this.messages.push(errorMsg);
      this.updateWebview();
    }
  }

  /**
   * 处理用户消息（保持向后兼容）
   */
  private async handleUserMessage(userMessage: string): Promise<void> {
    // 如果未配置，不允许发送消息
    if (!this.isConfigured) {
      vscode.window.showWarningMessage('请先完成配置才能使用聊天功能', '打开设置').then((selection) => {
        if (selection === '打开设置') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'ace-sidebar');
        }
      });
      return;
    }

    if (!userMessage.trim() || !this.chatService) {
      return;
    }

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: this.generateMessageId(),
      role: 'user',
      content: userMessage,
      timestamp: Date.now()
    };
    this.messages.push(userMsg);
    this.updateWebview();

    // 显示加载状态
    const loadingMsg: ChatMessage = {
      id: this.generateMessageId(),
      role: 'assistant',
      content: '正在思考...',
      timestamp: Date.now()
    };
    this.messages.push(loadingMsg);
    this.updateWebview();

    try {
      // 使用 ChatService 处理消息
      const result = await this.chatService!.handleMessageForView(userMessage);

      // 移除加载消息，添加实际回复
      this.messages.pop();
      const assistantMsg: ChatMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: result || '抱歉，没有找到相关信息。',
        timestamp: Date.now()
      };
      this.messages.push(assistantMsg);
      this.updateWebview();
    } catch (error) {
      // 移除加载消息，添加错误消息
      this.messages.pop();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const friendlyMessage = this.getFriendlyErrorMessage(errorMessage);
      const errorMsg: ChatMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: `❌ 错误: ${friendlyMessage}`,
        timestamp: Date.now()
      };
      this.messages.push(errorMsg);
      this.updateWebview();
    }
  }

  /**
   * 清空聊天记录
   */
  private clearChat(): void {
    this.messages = [];
    this.updateWebview();
  }

  /**
   * 更新 WebView 内容
   */
  private updateWebview(): void {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'updateMessages',
        messages: this.messages,
        isFirstVisit: this.isFirstVisit,
        isConfigured: this.isConfigured
      });
    }
  }

  /**
   * 报告索引进度
   */
  public reportIndexProgress(update: IndexProgressUpdate): void {
    this.lastIndexProgress = update;
    if (this._view) {
      this._view.webview.postMessage({
        command: 'indexProgress',
        update
      });
    }
  }

  /**
   * 获取友好的错误消息
   */
  private getFriendlyErrorMessage(errorMessage: string): string {
    if (errorMessage.includes('No workspace folder') || errorMessage.includes('工作区文件夹')) {
      return '未检测到工作区文件夹，请先打开一个文件夹';
    }
    if (errorMessage.includes('Token')) {
      return '认证失败，请检查配置中的 token 是否正确';
    }
    if (errorMessage.includes('baseUrl') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
      return '无法连接到服务器，请检查配置中的 baseUrl 是否正确';
    }
    if (errorMessage.includes('SSL') || errorMessage.includes('certificate')) {
      return 'SSL 证书验证失败，请检查 baseUrl 配置';
    }
    if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      return '请求超时，请检查网络连接或稍后重试';
    }
    return errorMessage;
  }

  /**
   * 生成消息 ID
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取 WebView HTML 内容
   */
  private getWebviewContent(webview: vscode.Webview): string {
    // 内联 SVG 图标
    const settingsIcon: string = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    const trashIcon: string = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
    const searchIcon: string = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>`;
    const sparklesIcon: string = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path><path d="M5 3v4"></path><path d="M19 17v4"></path><path d="M3 5h4"></path><path d="M17 19h4"></path></svg>`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ace Sidebar - Chat</title>
    <style>
        :root {
            --surface: var(--vscode-editor-background);
            --surface-alt: var(--vscode-input-background);
            --border: var(--vscode-panel-border);
            --text: var(--vscode-foreground);
            --muted: var(--vscode-descriptionForeground);
            --accent: var(--vscode-button-background);
            --accent-text: var(--vscode-button-foreground);
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            padding: 0;
            height: 100vh;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--text);
            background-color: var(--surface);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .app {
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            padding: 10px 16px;
            border-bottom: 1px solid var(--border);
            background: var(--vscode-titleBar-activeBackground);
            flex-shrink: 0;
        }

        .header-actions {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .header-actions button {
            background: transparent;
            color: var(--vscode-icon-foreground);
            border: none;
            padding: 4px 8px;
            min-width: 28px;
            min-height: 28px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background-color 0.2s ease;
        }

        .header-actions button:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }

        .header-actions button:focus {
            outline: none;
        }

        .header-actions button:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }

        .header-actions button svg {
            width: 16px;
            height: 16px;
            stroke-width: 2;
        }

        .body {
            flex: 1;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .messages-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .first-visit-guide {
            margin: 16px;
            padding: 16px;
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-inputValidation-infoBorder);
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .first-visit-guide h3 {
            margin: 0;
            font-size: 14px;
            color: var(--vscode-inputValidation-infoForeground);
        }

        .first-visit-guide p {
            margin: 0;
            font-size: 12px;
            color: var(--muted);
        }

        .first-visit-guide button {
            align-self: flex-start;
            padding: 6px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }

        .first-visit-guide button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .message {
            display: flex;
            flex-direction: column;
            max-width: 85%;
            animation: fadeIn 0.25s ease-in;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(6px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message.user { align-self: flex-end; }
        .message.assistant { align-self: flex-start; }

        .message-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 4px;
            font-size: 11px;
            color: var(--muted);
        }

        .message-content {
            padding: 10px 12px;
            border-radius: 8px;
            line-height: 1.5;
            word-wrap: break-word;
            white-space: pre-wrap;
        }

        .message.user .message-content {
            background-color: var(--vscode-inputValidation-infoBackground);
            color: var(--vscode-inputValidation-infoForeground);
            border: 1px solid var(--vscode-inputValidation-infoBorder);
        }

        .message.assistant .message-content {
            background-color: var(--vscode-textBlockQuote-background);
            color: var(--text);
            border: 1px solid var(--border);
        }

        .message-content pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
            border: 1px solid var(--border);
        }

        .message-content code {
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }

        .empty-state {
            margin: auto;
            text-align: center;
            color: var(--muted);
            padding: 40px;
        }

        .empty-state h3 {
            margin: 0 0 6px 0;
            font-size: 14px;
            color: var(--text);
        }

        .foot-input {
            border-top: 1px solid var(--border);
            background-color: var(--surface-alt);
            padding: 12px 16px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            flex-shrink: 0;
        }

        .index-status {
            display: flex;
            flex-direction: column;
            gap: 6px;
            font-size: 11px;
            color: var(--muted);
        }

        .progress-track {
            height: 4px;
            background: var(--border);
            border-radius: 999px;
            overflow: hidden;
        }

        .progress-bar {
            height: 100%;
            width: 0;
            background: var(--vscode-progressBar-background, var(--accent));
            transition: width 0.2s ease;
        }

        .progress-bar.error {
            background: var(--vscode-inputValidation-errorBorder);
        }

        .input-row {
            display: flex;
            align-items: flex-end;
            position: relative;
        }

        .input-wrapper {
            flex: 1;
            position: relative;
            display: flex;
            flex-direction: column;
        }

        .input-row textarea {
            flex: 1;
            padding: 12px 16px;
            padding-right: 100px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.5;
            resize: none;
            min-height: 72px;
            max-height: 180px;
            width: 100%;
            box-sizing: border-box;
            transition: all 0.2s ease;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        }

        .input-row textarea:focus {
            outline: 2px solid var(--vscode-focusBorder);
            outline-offset: -2px;
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 3px rgba(var(--vscode-focusBorder-rgb, 0, 122, 204), 0.1);
        }

        .input-row textarea:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        .input-actions {
            position: absolute;
            right: 8px;
            bottom: 8px;
            display: flex;
            gap: 6px;
            align-items: center;
        }

        .input-actions button {
            padding: 6px;
            background-color: transparent;
            color: var(--vscode-icon-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
            width: 28px;
            height: 28px;
        }

        .input-actions button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .input-actions button:active {
            transform: scale(0.95);
        }

        .input-actions button:disabled {
            opacity: 0.4;
            cursor: not-allowed;
            transform: none;
        }

        .input-actions button svg {
            width: 16px;
            height: 16px;
            stroke-width: 2;
        }
    </style>
</head>
<body>
    <div class="app">
        <header class="header">
            <div class="header-actions">
                <button id="settingsBtn" title="Open Settings">
                    ${settingsIcon}
                </button>
                <button id="clearBtn" title="Clear chat" tabindex="-1">
                    ${trashIcon}
                </button>
            </div>
        </header>

        <main class="body">
            <div class="messages-container" id="messagesContainer">
                <div class="empty-state">
                    <h3>Start a conversation</h3>
                    <p>Ask a question to search your codebase.</p>
                </div>
            </div>
        </main>

        <footer class="foot-input">
            <div class="index-status">
                <div class="status-text" id="indexStatusText">Index idle</div>
                <div class="progress-track">
                    <div class="progress-bar" id="indexProgressBar"></div>
                </div>
            </div>
            <div class="input-row">
                <div class="input-wrapper">
                    <textarea
                        id="messageInput"
                        placeholder="Ask about your code... (Enter to search, Shift+Enter for newline)"
                        rows="3"
                    ></textarea>
                    <div class="input-actions">
                        <button id="codebaseSearchBtn" title="代码搜索">
                            ${searchIcon}
                        </button>
                        <button id="promptEnhanceBtn" title="提示词增强">
                            ${sparklesIcon}
                        </button>
                    </div>
                </div>
            </div>
        </footer>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const messagesContainer = document.getElementById('messagesContainer');
        const messageInput = document.getElementById('messageInput');
        const clearBtn = document.getElementById('clearBtn');
        const settingsBtn = document.getElementById('settingsBtn');
        const codebaseSearchBtn = document.getElementById('codebaseSearchBtn');
        const promptEnhanceBtn = document.getElementById('promptEnhanceBtn');
        const indexStatusText = document.getElementById('indexStatusText');
        const indexProgressBar = document.getElementById('indexProgressBar');
        let isProcessing = false;
        let isFirstVisit = false;
        let isConfigured = false; // 初始值，会在 updateMessages 时更新

        function formatTime(timestamp) {
            const date = new Date(timestamp);
            return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        }

        function updateIndexProgress(update) {
            if (!update) {
                return;
            }
            const percent = typeof update.percent === 'number' ? update.percent : 0;
            const safePercent = Math.max(0, Math.min(100, percent));
            indexStatusText.textContent = update.message || 'Indexing...';
            indexProgressBar.style.width = safePercent + '%';
            indexProgressBar.className = update.stage === 'error' ? 'progress-bar error' : 'progress-bar';
        }

        function renderConfigRequired() {
            if (isConfigured) {
                return '';
            }
            return \`
                <div class="first-visit-guide" style="border-color: var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground);">
                    <h3 style="color: var(--vscode-inputValidation-errorForeground);">必须完成配置</h3>
                    <p style="color: var(--vscode-inputValidation-errorForeground);">使用此功能前，必须先配置 API 地址和认证令牌。请点击下方按钮进入设置页面完成配置。</p>
                    <button onclick="vscode.postMessage({ command: 'openSettings' })" style="background: var(--vscode-button-background); color: var(--vscode-button-foreground);">立即配置</button>
                </div>
            \`;
        }

        function renderFirstVisitGuide() {
            if (!isFirstVisit || !isConfigured) {
                return '';
            }
            return \`
                <div class="first-visit-guide">
                    <h3>欢迎使用 Ace Sidebar</h3>
                    <p>首次使用需要配置 API 地址和认证令牌。请点击下方按钮进入设置页面完成初始配置。</p>
                    <button onclick="vscode.postMessage({ command: 'openSettings' })">打开设置</button>
                    <button onclick="vscode.postMessage({ command: 'dismissFirstVisit' })" style="background: transparent; color: var(--muted);">稍后提醒</button>
                </div>
            \`;
        }

        function renderMessages(messages) {
            const configRequiredHtml = renderConfigRequired();
            const guideHtml = isConfigured ? renderFirstVisitGuide() : '';
            
            if (messages.length === 0) {
                messagesContainer.innerHTML = configRequiredHtml + guideHtml + (isConfigured ? \`
                    <div class="empty-state">
                        <h3>Start a conversation</h3>
                        <p>Ask a question to search your codebase.</p>
                    </div>
                \` : '');
                return;
            }

            messagesContainer.innerHTML = configRequiredHtml + guideHtml + messages.map(msg => {
                const roleText = msg.role === 'user' ? 'You' : 'Ace Sidebar';
                const roleClass = msg.role;
                return \`
                    <div class="message \${roleClass}">
                        <div class="message-header">
                            <span class="message-role">\${roleText}</span>
                            <span class="message-time">\${formatTime(msg.timestamp)}</span>
                        </div>
                        <div class="message-content">\${escapeHtml(msg.content)}</div>
                    </div>
                \`;
            }).join('');

            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            let html = div.innerHTML;

            html = html.replace(/\`\`\`(\\w+)?\\n([\\s\\S]*?)\`\`\`/g, (match, lang, code) => {
                return '<pre><code class="language-' + (lang || 'text') + '">' + escapeHtml(code) + '</code></pre>';
            });

            html = html.replace(/\\n/g, '<br>');

            return html;
        }

        function sendMessage() {
            if (!isConfigured) {
                vscode.postMessage({ command: 'openSettings' });
                return;
            }
            
            const text = messageInput.value.trim();
            if (!text || isProcessing) {
                return;
            }

            isProcessing = true;
            messageInput.disabled = true;
            codebaseSearchBtn.disabled = true;
            promptEnhanceBtn.disabled = true;

            // 默认使用代码搜索
            vscode.postMessage({
                command: 'codebaseSearch',
                text: text
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        function updateUIState() {
            if (!isConfigured) {
                messageInput.disabled = true;
                codebaseSearchBtn.disabled = true;
                promptEnhanceBtn.disabled = true;
                messageInput.placeholder = '请先完成配置才能使用...';
            } else {
                messageInput.disabled = false;
                codebaseSearchBtn.disabled = false;
                promptEnhanceBtn.disabled = false;
                messageInput.placeholder = 'Ask about your code... (Enter to search, Shift+Enter for newline)';
            }
        }

        function triggerCodebaseSearch() {
            if (!isConfigured) {
                vscode.postMessage({ command: 'openSettings' });
                return;
            }
            
            const text = messageInput.value.trim();
            if (!text || isProcessing) {
                return;
            }

            isProcessing = true;
            codebaseSearchBtn.disabled = true;
            promptEnhanceBtn.disabled = true;
            messageInput.disabled = true;

            vscode.postMessage({
                command: 'codebaseSearch',
                text: text
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        function triggerPromptEnhancement() {
            if (!isConfigured) {
                vscode.postMessage({ command: 'openSettings' });
                return;
            }
            
            const text = messageInput.value.trim();
            if (!text || isProcessing) {
                return;
            }

            isProcessing = true;
            codebaseSearchBtn.disabled = true;
            promptEnhanceBtn.disabled = true;
            messageInput.disabled = true;

            vscode.postMessage({
                command: 'promptEnhancement',
                text: text
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        clearBtn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'clearChat'
            });
        });

        settingsBtn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'openSettings'
            });
        });

        codebaseSearchBtn.addEventListener('click', triggerCodebaseSearch);
        promptEnhanceBtn.addEventListener('click', triggerPromptEnhancement);

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + 'px';
        });

        window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.command) {
                case 'updateMessages':
                    isFirstVisit = message.isFirstVisit || false;
                    isConfigured = message.isConfigured || false;
                    renderMessages(message.messages || []);
                    isProcessing = false;
                    updateUIState();
                    if (isConfigured) {
                        messageInput.focus();
                    }
                    break;
                case 'indexProgress':
                    updateIndexProgress(message.update);
                    break;
            }
        });

        // 页面加载时初始化 UI 状态
        updateUIState();
    </script>
</body>
</html>`;
  }
}


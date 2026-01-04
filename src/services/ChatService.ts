/**
 * 聊天服务 - 管理聊天界面和消息处理
 */

import * as vscode from 'vscode';
import { IndexManager, IndexProgressUpdate } from '../index/manager';
import { Config } from '../config';
import { sendLog } from '../utils/VSCodeAdapter';

/**
 * 消息类型
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * 聊天服务类
 */
export class ChatService {
  private panel: vscode.WebviewPanel | undefined;
  private messages: ChatMessage[] = [];
  private config: Config;
  private projectRoot: string | undefined;

  private hasAutoIndexed: boolean = false;
  private lastIndexProgress: IndexProgressUpdate | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  public updateConfig(config: Config): void {
    this.config = config;
    this.hasAutoIndexed = false;
  }

  /**
   * 创建或显示聊天面板
   */
  public createOrShowChatPanel(context: vscode.ExtensionContext): void {
    const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!projectRoot) {
      vscode.window.showErrorMessage(
        'Ace Sidebar: 未检测到工作区文件夹。请先打开一个文件夹（File > Open Folder），然后再试。',
        '打开文件夹'
      ).then((selection) => {
        if (selection === '打开文件夹') {
          vscode.commands.executeCommand('workbench.action.files.openFolder');
        }
      });
      return;
    }
    if (this.projectRoot !== projectRoot) {
      this.projectRoot = projectRoot;
      this.hasAutoIndexed = false;
    }

    // 如果面板已存在，直接显示
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    // 创建新的 WebView 面板
    this.panel = vscode.window.createWebviewPanel(
      'aceSidebarChat',
      'Ace Sidebar - Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );

    // 设置初始 HTML 内容
    this.panel.webview.html = this.getWebviewContent();

    // 处理来自 WebView 的消息
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'sendMessage':
            await this.handleUserMessage(message.text);
            break;
          case 'clearChat':
            this.clearChat();
            break;
          case 'openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'ace-sidebar');
            break;
        }
      },
      undefined,
      context.subscriptions
    );

    // 面板关闭时清理
    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      null,
      context.subscriptions
    );

    // 发送初始消息（如果有历史消息）
    if (this.messages.length > 0) {
      this.updateWebview();
    }

    if (this.lastIndexProgress) {
      this.reportIndexProgress(this.lastIndexProgress);
    }

    this.runAutoIndex();
  }

  /**
   * 处理代码搜索（用于 WebviewView）
   * 返回处理结果字符串
   */
  public async handleCodebaseSearch(userMessage: string): Promise<string> {
    if (!userMessage.trim()) {
      throw new Error('消息不能为空');
    }

    // 检查工作区是否仍然有效
    const currentProjectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!currentProjectRoot) {
      throw new Error('未检测到工作区文件夹。请先打开一个文件夹，然后重试。');
    }

    // 更新项目根路径
    if (this.projectRoot !== currentProjectRoot) {
      this.projectRoot = currentProjectRoot;
      this.hasAutoIndexed = false;
    }

    try {
      // 使用 IndexManager 进行代码搜索（不启用提示词增强）
      const indexManager = new IndexManager(
        this.projectRoot,
        this.config.baseUrl,
        this.config.token,
        this.config.textExtensions,
        this.config.batchSize,
        this.config.maxLinesPerBlob,
        this.config.excludePatterns,
        this.config.userGuidelines || ''
      );

      sendLog('info', `🔍 代码搜索: ${userMessage}`);

      // 执行代码搜索
      const result = await indexManager.searchCodebase(userMessage, {
        reporter: (update: IndexProgressUpdate) => {
          this.reportIndexProgress(update);
        }
      });

      sendLog('info', '✅ 代码搜索完成');
      return result || '抱歉，没有找到相关信息。';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const friendlyMessage = this.getFriendlyErrorMessage(errorMessage);
      sendLog('error', `❌ 代码搜索失败: ${errorMessage}`);
      throw new Error(friendlyMessage);
    }
  }

  /**
   * 执行代码搜索并在独立 WebView 面板中显示结果（用于命令调用）
   */
  public async searchAndShowInPanel(projectRoot: string, query: string): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Ace Sidebar',
        cancellable: false
      },
      async (progress: vscode.Progress<{ increment: number; message: string }>) => {
        try {
          sendLog('info', `🔍 搜索代码库: ${projectRoot}`);

          const indexManager = new IndexManager(
            projectRoot,
            this.config.baseUrl,
            this.config.token,
            this.config.textExtensions,
            this.config.batchSize,
            this.config.maxLinesPerBlob,
            this.config.excludePatterns,
            this.config.userGuidelines || ''
          );

          sendLog('info', `🔍 搜索查询: ${query}`);

          let lastPercent = 0;
          const reporter = (update: IndexProgressUpdate) => {
            const percent = typeof update.percent === 'number' ? update.percent : lastPercent;
            const increment = Math.max(0, percent - lastPercent);
            lastPercent = Math.max(lastPercent, percent);
            progress.report({ increment, message: update.message });
          };

          // 执行代码搜索
          const result = await indexManager.searchCodebase(query, { reporter });

          if (lastPercent < 100) {
            progress.report({ increment: 100 - lastPercent, message: 'Complete' });
          }

          // 显示结果
          await this.showResultInWebView(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendLog('error', `搜索失败: ${message}`);
          vscode.window.showErrorMessage(`Ace Sidebar Error: ${message}`);
        }
      }
    );
  }

  /**
   * 在 WebView 面板中显示搜索结果
   */
  private async showResultInWebView(result: string): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'aceSidebarResult',
      'Ace Sidebar - Search Result',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    // 转义 HTML 特殊字符
    const escapedResult = result
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    // 将代码块转换为 HTML
    const formattedResult = escapedResult
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (match: string, lang: string | undefined, code: string) => {
        return `<pre><code class="language-${lang || 'text'}">${code}</code></pre>`;
      })
      .replace(/\n/g, '<br>');

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ace Sidebar - Search Result</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        pre {
            background-color: var(--vscode-textBlockQuote-background);
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
        }
        code {
            font-family: var(--vscode-editor-font-family);
        }
    </style>
</head>
<body>
    <h2>Search Result</h2>
    <div>${formattedResult}</div>
</body>
</html>`;
  }

  /**
   * 处理提示词增强（用于 WebviewView）
   * 返回增强后的提示词
   */
  public async handlePromptEnhancement(userMessage: string): Promise<string> {
    if (!userMessage.trim()) {
      throw new Error('消息不能为空');
    }

    // 检查工作区是否仍然有效
    const currentProjectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!currentProjectRoot) {
      throw new Error('未检测到工作区文件夹。请先打开一个文件夹，然后重试。');
    }

    // 更新项目根路径
    if (this.projectRoot !== currentProjectRoot) {
      this.projectRoot = currentProjectRoot;
      this.hasAutoIndexed = false;
    }

    try {
      // 使用 IndexManager 进行提示词增强
      const indexManager = new IndexManager(
        this.projectRoot,
        this.config.baseUrl,
        this.config.token,
        this.config.textExtensions,
        this.config.batchSize,
        this.config.maxLinesPerBlob,
        this.config.excludePatterns,
        this.config.userGuidelines || ''
      );

      sendLog('info', `✨ 提示词增强: ${userMessage}`);

      // 执行提示词增强
      const enhancedQuery = await indexManager.enhancePrompt(userMessage, {
        reporter: (update: IndexProgressUpdate) => {
          this.reportIndexProgress(update);
        }
      });

      sendLog('info', '✅ 提示词增强完成');
      return enhancedQuery;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const friendlyMessage = this.getFriendlyErrorMessage(errorMessage);
      sendLog('error', `❌ 提示词增强失败: ${errorMessage}`);
      throw new Error(friendlyMessage);
    }
  }

  /**
   * 处理用户消息（用于 WebviewView）
   * 返回处理结果字符串（仅执行代码搜索）
   */
  public async handleMessageForView(userMessage: string): Promise<string> {
    if (!userMessage.trim()) {
      throw new Error('消息不能为空');
    }

    // 检查工作区是否仍然有效
    const currentProjectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!currentProjectRoot) {
      throw new Error('未检测到工作区文件夹。请先打开一个文件夹，然后重试。');
    }

    // 更新项目根路径
    if (this.projectRoot !== currentProjectRoot) {
      this.projectRoot = currentProjectRoot;
      this.hasAutoIndexed = false;
    }

    try {
      // 使用 IndexManager 进行搜索
      const indexManager = new IndexManager(
        this.projectRoot,
        this.config.baseUrl,
        this.config.token,
        this.config.textExtensions,
        this.config.batchSize,
        this.config.maxLinesPerBlob,
        this.config.excludePatterns,
        this.config.userGuidelines || ''
      );

      sendLog('info', `💬 用户消息: ${userMessage}`);

      // 执行代码搜索
      const result = await indexManager.searchCodebase(userMessage, {
        reporter: (update: IndexProgressUpdate) => {
          this.reportIndexProgress(update);
        }
      });

      sendLog('info', '✅ 聊天回复已生成');
      return result || '抱歉，没有找到相关信息。';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const friendlyMessage = this.getFriendlyErrorMessage(errorMessage);
      sendLog('error', `❌ 聊天处理失败: ${errorMessage}`);
      throw new Error(friendlyMessage);
    }
  }

  /**
   * 处理用户消息（用于 WebviewPanel）
   */
  private async handleUserMessage(userMessage: string): Promise<void> {
    if (!userMessage.trim()) {
      return;
    }

    // 检查工作区是否仍然有效
    const currentProjectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!currentProjectRoot) {
      const errorMsg: ChatMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: '❌ 错误: 未检测到工作区文件夹。请先打开一个文件夹，然后重试。',
        timestamp: Date.now()
      };
      this.messages.push({
        id: this.generateMessageId(),
        role: 'user',
        content: userMessage,
        timestamp: Date.now()
      });
      this.messages.push(errorMsg);
      this.updateWebview();
      vscode.window.showErrorMessage('请先打开一个工作区文件夹');
      return;
    }

    // 更新项目根路径（可能在面板打开后工作区发生了变化）
    this.projectRoot = currentProjectRoot;

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
      // 使用 IndexManager 进行搜索
      const indexManager = new IndexManager(
        this.projectRoot,
        this.config.baseUrl,
        this.config.token,
        this.config.textExtensions,
        this.config.batchSize,
        this.config.maxLinesPerBlob,
        this.config.excludePatterns,
        this.config.userGuidelines || ''
      );

      sendLog('info', `💬 用户消息: ${userMessage}`);

      // 执行代码搜索
      const result = await indexManager.searchCodebase(userMessage, {
        reporter: (update: IndexProgressUpdate) => this.reportIndexProgress(update)
      });

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

      sendLog('info', '✅ 聊天回复已生成');
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

      sendLog('error', `❌ 聊天处理失败: ${errorMessage}`);
    }
  }

  /**
   * 获取友好的错误消息
   */
  private getFriendlyErrorMessage(errorMessage: string): string {
    // 处理常见的错误消息，使其更友好
    if (errorMessage.includes('No workspace folder')) {
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
    if (this.panel) {
      this.panel.webview.postMessage({
        command: 'updateMessages',
        messages: this.messages
      });
    }
  }

  private progressReporter?: (update: IndexProgressUpdate) => void;

  /**
   * 设置进度报告器（用于 WebviewView）
   */
  public setProgressReporter(reporter: (update: IndexProgressUpdate) => void): void {
    this.progressReporter = reporter;
  }

  public reportIndexProgress(update: IndexProgressUpdate): void {
    this.lastIndexProgress = update;
    if (this.panel) {
      this.panel.webview.postMessage({
        command: 'indexProgress',
        update
      });
    }
    // 同时报告给 WebviewView（如果有）
    if (this.progressReporter) {
      this.progressReporter(update);
    }
  }

  private async runAutoIndex(): Promise<void> {
    if (this.hasAutoIndexed || !this.projectRoot) {
      return;
    }

    this.hasAutoIndexed = true;

    try {
      const indexManager = new IndexManager(
        this.projectRoot,
        this.config.baseUrl,
        this.config.token,
        this.config.textExtensions,
        this.config.batchSize,
        this.config.maxLinesPerBlob,
        this.config.excludePatterns,
        this.config.userGuidelines || ''
      );

      await indexManager.indexProject((update) => this.reportIndexProgress(update));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.reportIndexProgress({
        stage: 'error',
        message: errorMessage,
        percent: 100
      });
    }
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
  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
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
        }

        .app {
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 16px;
            border-bottom: 1px solid var(--border);
            background: var(--vscode-titleBar-activeBackground);
        }

        .title {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .title-text {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-titleBar-activeForeground);
        }

        .title-sub {
            font-size: 11px;
            color: var(--vscode-titleBar-activeForeground);
            opacity: 0.75;
        }

        .header-actions {
            display: flex;
            gap: 8px;
        }

        .header-actions button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 10px;
            border-radius: 2px;
            cursor: pointer;
            font-size: 12px;
        }

        .header-actions button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .body {
            flex: 1;
            overflow: hidden;
        }

        .messages-container {
            height: 100%;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
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
            gap: 8px;
            align-items: flex-end;
        }

        .input-row textarea {
            flex: 1;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            resize: none;
            min-height: 42px;
            max-height: 140px;
        }

        .input-row textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        .input-row button {
            padding: 8px 16px;
            background-color: var(--accent);
            color: var(--accent-text);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            white-space: nowrap;
        }

        .input-row button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .input-row button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
    </style>
</head>
<body>
    <div class="app">
        <header class="header">
            <div class="title">
                <span class="title-text">Ace Sidebar</span>
                <span class="title-sub">Chat + Code Search</span>
            </div>
            <div class="header-actions">
                <button id="settingsBtn" title="Open Settings">Settings</button>
                <button id="clearBtn" title="Clear chat">Clear</button>
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
                <textarea
                    id="messageInput"
                    placeholder="Ask about your code... (Enter to send, Shift+Enter for newline)"
                    rows="1"
                ></textarea>
                <button id="sendBtn">Send</button>
            </div>
        </footer>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const messagesContainer = document.getElementById('messagesContainer');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        const clearBtn = document.getElementById('clearBtn');
        const settingsBtn = document.getElementById('settingsBtn');
        const indexStatusText = document.getElementById('indexStatusText');
        const indexProgressBar = document.getElementById('indexProgressBar');
        let isProcessing = false;

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

        function renderMessages(messages) {
            if (messages.length === 0) {
                messagesContainer.innerHTML = \`
                    <div class="empty-state">
                        <h3>Start a conversation</h3>
                        <p>Ask a question to search your codebase.</p>
                    </div>
                \`;
                return;
            }

            messagesContainer.innerHTML = messages.map(msg => {
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
            const text = messageInput.value.trim();
            if (!text || isProcessing) {
                return;
            }

            isProcessing = true;
            sendBtn.disabled = true;
            messageInput.disabled = true;

            vscode.postMessage({
                command: 'sendMessage',
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

        sendBtn.addEventListener('click', sendMessage);

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 140) + 'px';
        });

        window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.command) {
                case 'updateMessages':
                    renderMessages(message.messages || []);
                    isProcessing = false;
                    sendBtn.disabled = false;
                    messageInput.disabled = false;
                    messageInput.focus();
                    break;
                case 'indexProgress':
                    updateIndexProgress(message.update);
                    break;
            }
        });
    </script>
</body>
</html>`;
  }


  /**
   * 销毁聊天面板
   */
  public dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    this.messages = [];
  }
}


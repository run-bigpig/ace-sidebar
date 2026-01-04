/**
 * 聊天视图提供者 - 在侧边栏内显示聊天对话框
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ChatService, ChatMessage } from '../services/ChatService';
import { IndexProgressUpdate } from '../index/manager';
import { getVSCodeConfig } from '../utils/VSCodeAdapter';

/**
 * MCP Server 状态接口
 */
export interface McpServerStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  endpoint: string;
}

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
  private workspaceName: string = ''; // 缓存工作区名称
  private editorChangeDisposable?: vscode.Disposable; // 编辑器变化监听器
  private getMcpStatus: () => McpServerStatus; // MCP 状态获取函数

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    getMcpStatus: () => McpServerStatus
  ) {
    this.getMcpStatus = getMcpStatus;
    // 检测是否首次访问（同步检查）
    this.checkFirstVisit();
    
    // 初始化工作区名称（在插件启动时固定获取）
    this.initializeWorkspaceName();
    
    // 监听编辑器切换事件，实时更新当前文件显示
    this.setupEditorChangeListener();
  }

  /**
   * 设置 ChatService 实例
   * 【修复问题2】添加检查，避免重复设置相同的 chatService 实例
   */
  public setChatService(chatService: ChatService): void {
    // 如果是同一个实例，无需重复设置
    if (this.chatService === chatService) {
      return;
    }
    
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
   * 初始化工作区名称（在插件启动时固定获取）
   */
  private initializeWorkspaceName(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      this.workspaceName = path.basename(workspaceFolders[0].uri.fsPath);
    } else {
      this.workspaceName = 'No Workspace';
    }
  }

  /**
   * 设置编辑器变化监听器，实时同步当前文件显示
   * 【修复问题3】文件切换时只更新编辑器上下文，不重新渲染整个消息列表
   */
  private setupEditorChangeListener(): void {
    // 监听活动编辑器变化事件
    this.editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
      // 当编辑器切换或关闭时，只更新编辑器上下文信息
      // 不重新发送整个消息列表，避免前端重新渲染聊天记录
      this.updateEditorContextOnly();
    });
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
   * 获取当前编辑器的上下文信息用于 UI 显示
   * 【修复问题2&3】workspaceName 和 fileName 分离处理
   * - workspaceName: 始终返回（项目目录应始终显示）
   * - fileName: 仅当有文件打开时返回，否则为 null
   */
  private getEditorContextForUI(): { workspaceName: string; fileName: string | null } {
    const activeEditor = vscode.window.activeTextEditor;
    
    // workspaceName 始终使用缓存的工作区名称（在插件启动时固定获取）
    // 这确保了项目目录始终显示，不受文件打开/关闭状态影响
    
    // fileName 仅在有有效的文件打开时才显示
    let fileName: string | null = null;
    
    if (activeEditor) {
      const document = activeEditor.document;
      // 只处理文件系统中的文件，排除输出面板、终端等
      if (document.uri.scheme === 'file') {
        fileName = path.basename(document.uri.fsPath);
      }
    }
    
    return {
      workspaceName: this.workspaceName, // 始终返回工作区名称
      fileName: fileName // 当没有打开文件时为 null
    };
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
          case 'getMcpStatus':
            // 返回 MCP 状态
            const status = this.getMcpStatus();
            webviewView.webview.postMessage({
              command: 'mcpStatus',
              status
            });
            break;
          case 'copyMcpConfig':
            // 复制 MCP 配置到剪贴板
            await this.handleCopyMcpConfig();
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
      content: userMessage,
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
      content: userMessage,
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
   * 更新 WebView 内容（完整更新，包括消息列表）
   */
  private updateWebview(): void {
    if (this._view) {
      const editorContext = this.getEditorContextForUI();
      const mcpStatus = this.getMcpStatus();
      this._view.webview.postMessage({
        command: 'updateMessages',
        messages: this.messages,
        isFirstVisit: this.isFirstVisit,
        isConfigured: this.isConfigured,
        editorContext: editorContext,
        mcpStatus: mcpStatus
      });
    }
  }

  /**
   * 仅更新编辑器上下文信息（不重新渲染消息列表）
   * 【修复问题3】文件切换时使用此方法，避免聊天记录重新渲染
   */
  private updateEditorContextOnly(): void {
    if (this._view) {
      const editorContext = this.getEditorContextForUI();
      this._view.webview.postMessage({
        command: 'updateEditorContext',
        editorContext: editorContext
      });
    }
  }

  /**
   * 处理复制 MCP 配置
   * 只复制 URL 地址
   */
  private async handleCopyMcpConfig(): Promise<void> {
    const status = this.getMcpStatus();
    
    if (!status.enabled) {
      vscode.window.showWarningMessage('MCP Server 未启用，请先在设置中启用');
      return;
    }
    
    if (!status.running) {
      vscode.window.showWarningMessage('MCP Server 未运行');
      return;
    }
    
    try {
      await vscode.env.clipboard.writeText(status.endpoint);
      vscode.window.showInformationMessage(`已复制: ${status.endpoint}`);
    } catch (error) {
      vscode.window.showErrorMessage('复制失败');
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
    const copyIcon: string = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2h8c1.1 0 2 .9 2 2"></path></svg>`;
    const checkIcon: string = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    const folderIcon: string = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
    const fileIcon: string = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;

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
            position: relative;
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

        .message-content-wrapper {
            position: relative;
        }

        .message-content {
            padding: 10px 12px;
            border-radius: 8px;
            line-height: 1.5;
            word-wrap: break-word;
            white-space: pre-wrap;
        }

        .message-copy-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 6px;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s ease, background-color 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            z-index: 10;
        }

        .message:hover .message-copy-btn {
            opacity: 1;
        }

        .message-copy-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .message-copy-btn:active {
            transform: scale(0.95);
        }

        .message-copy-btn.copied {
            opacity: 1;
            background: var(--vscode-inputValidation-infoBackground);
            color: var(--vscode-inputValidation-infoForeground);
        }

        .message-copy-btn svg {
            width: 14px;
            height: 14px;
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
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
        }

        .input-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--border);
            font-size: 11px;
        }

        .context-info {
            display: flex;
            align-items: center;
            gap: 12px;
            color: var(--muted);
        }

        .context-item {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .context-icon {
            display: flex;
            align-items: center;
            color: var(--muted);
            opacity: 0.7;
        }

        .context-icon svg {
            width: 14px;
            height: 14px;
        }

        .context-value {
            color: var(--text);
            font-weight: 500;
        }

        .progress-info {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--muted);
            font-size: 11px;
        }

        .progress-percent {
            font-weight: 600;
            color: var(--accent);
            min-width: 35px;
            text-align: right;
        }

        .progress-percent.error {
            color: var(--vscode-inputValidation-errorBorder);
        }

        .context-info-hidden {
            visibility: hidden;
        }

        .input-row {
            display: flex;
            align-items: flex-end;
            position: relative;
            padding: 12px 16px;
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

        /* MCP 状态显示器样式 */
        .mcp-status-bar {
            padding: 6px 16px;
            background-color: var(--vscode-editor-background);
            border-top: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 11px;
            cursor: pointer;
            transition: background-color 0.2s ease;
        }

        .mcp-status-bar:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .mcp-status-left {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .mcp-status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            transition: background-color 0.3s ease;
        }

        .mcp-status-indicator.running {
            background-color: #4caf50;
            box-shadow: 0 0 4px #4caf50;
        }

        .mcp-status-indicator.stopped {
            background-color: #757575;
        }

        .mcp-status-indicator.disabled {
            background-color: #f44336;
        }

        .mcp-status-text {
            color: var(--muted);
        }

        .mcp-status-endpoint {
            color: var(--text);
            font-family: var(--vscode-editor-font-family);
            font-size: 10px;
        }

        .mcp-copy-icon {
            color: var(--muted);
            opacity: 0.6;
            display: flex;
            align-items: center;
            transition: opacity 0.2s ease;
        }

        .mcp-status-bar:hover .mcp-copy-icon {
            opacity: 1;
        }

        .mcp-copy-icon svg {
            width: 14px;
            height: 14px;
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
                    <h3>Ask a question to search your codebase or enhance your prompts </h3>
                </div>
            </div>
        </main>

        <footer class="foot-input">
            <div class="input-header">
                <div class="context-info" id="contextInfo">
                    <div class="context-item">
                        <span class="context-icon">${folderIcon}</span>
                        <span class="context-value" id="workspaceName">-</span>
                    </div>
                    <div class="context-item" id="fileContextItem" style="display: none;">
                        <span class="context-icon">${fileIcon}</span>
                        <span class="context-value" id="fileName">-</span>
                    </div>
                </div>
                <div class="progress-info">
                    <span id="progressMessage">Ready</span>
                    <span class="progress-percent" id="progressPercent">0%</span>
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
            <div class="mcp-status-bar" id="mcpStatusBar" title="点击复制 MCP 端点 URL">
                <div class="mcp-status-left">
                    <div class="mcp-status-indicator stopped" id="mcpStatusIndicator"></div>
                    <span class="mcp-status-text" id="mcpStatusText">MCP Server: 未启用</span>
                    <span class="mcp-status-endpoint" id="mcpStatusEndpoint"></span>
                </div>
                <span class="mcp-copy-icon">${copyIcon}</span>
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
        const contextInfo = document.getElementById('contextInfo');
        const workspaceName = document.getElementById('workspaceName');
        const fileName = document.getElementById('fileName');
        const fileContextItem = document.getElementById('fileContextItem');
        const progressMessage = document.getElementById('progressMessage');
        const progressPercent = document.getElementById('progressPercent');
        const mcpStatusBar = document.getElementById('mcpStatusBar');
        const mcpStatusIndicator = document.getElementById('mcpStatusIndicator');
        const mcpStatusText = document.getElementById('mcpStatusText');
        const mcpStatusEndpoint = document.getElementById('mcpStatusEndpoint');
        let isProcessing = false;
        let isFirstVisit = false;
        let isConfigured = false; // 初始值，会在 updateMessages 时更新

        /**
         * 更新 MCP 状态显示
         */
        function updateMcpStatus(status) {
            if (!status) return;
            
            // 更新指示器状态
            mcpStatusIndicator.className = 'mcp-status-indicator';
            
            if (!status.enabled) {
                mcpStatusIndicator.classList.add('disabled');
                mcpStatusText.textContent = 'MCP Server: 未启用';
                mcpStatusEndpoint.textContent = '';
            } else if (status.running) {
                mcpStatusIndicator.classList.add('running');
                mcpStatusText.textContent = 'MCP Server: 运行中';
                mcpStatusEndpoint.textContent = status.endpoint;
            } else {
                mcpStatusIndicator.classList.add('stopped');
                mcpStatusText.textContent = 'MCP Server: 已停止';
                mcpStatusEndpoint.textContent = '';
            }
        }

        /**
         * 处理 MCP 状态栏点击事件
         */
        mcpStatusBar.addEventListener('click', () => {
            vscode.postMessage({ command: 'copyMcpConfig' });
        });

        function updateEditorContext(context) {
            // 【修复问题2&3】独立处理 workspaceName 和 fileName 的显示
            // workspaceName: 始终显示项目目录，不受文件打开/关闭状态影响
            // fileName: 仅当有文件打开时显示，否则隐藏整个文件区域
            
            if (context && context.workspaceName) {
                // 项目目录始终显示
                workspaceName.textContent = context.workspaceName;
            } else {
                workspaceName.textContent = 'No Workspace';
            }
            
            // 当前文件：仅当有文件打开时显示文件图标和文件名
            if (context && context.fileName) {
                fileName.textContent = context.fileName;
                fileContextItem.style.display = 'flex'; // 显示文件图标和文件名
            } else {
                fileName.textContent = '';
                fileContextItem.style.display = 'none'; // 隐藏文件图标和文件名
            }
            
            // context-info 区域始终可见（不再隐藏）
            contextInfo.classList.remove('context-info-hidden');
        }

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
            progressMessage.textContent = update.message || 'Processing...';
            progressPercent.textContent = safePercent.toFixed(0) + '%';
            
            if (update.stage === 'error') {
                progressPercent.classList.add('error');
            } else {
                progressPercent.classList.remove('error');
            }
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

        function cleanMessageContent(content) {
            if (!content) return '';
            
            let cleaned = content;
            
            // 移除 "增强后的提示词：" 及其后的换行（支持多种格式）
            cleaned = cleaned.replace(/\\*\\*增强后的提示词：\\*\\*\\s*\\n\\n?/g, '');
            cleaned = cleaned.replace(/增强后的提示词：\\s*\\n\\n?/g, '');
            
            // 移除 ### BEGIN RESPONSE ### 和 ### END RESPONSE ### 标记
            cleaned = cleaned.replace(/###\\s*BEGIN\\s*RESPONSE\\s*###/gi, '');
            cleaned = cleaned.replace(/###\\s*END\\s*RESPONSE\\s*###/gi, '');
            
            // 移除 <augment-enhanced-prompt> 标签，但保留标签内的内容
            cleaned = cleaned.replace(/<augment-enhanced-prompt>/gi, '');
            cleaned = cleaned.replace(/<\\/augment-enhanced-prompt>/gi, '');
            
            // 移除其他可能的元数据标记和说明文本
            cleaned = cleaned.replace(/Here is an enhanced version of the original instruction that is more specific and clear:/gi, '');
            cleaned = cleaned.replace(/Here is an enhanced version of the original instruction:/gi, '');
            
            // 清理多余的空白行（保留最多两个连续换行）
            cleaned = cleaned.replace(/\\n{3,}/g, '\\n\\n');
            
            // 清理行首行尾的空白
            cleaned = cleaned.split('\\n').map(line => line.trim()).join('\\n');
            
            // 去除首尾空白
            cleaned = cleaned.trim();
            
            return cleaned;
        }

        function renderMessages(messages) {
            const configRequiredHtml = renderConfigRequired();
            const guideHtml = isConfigured ? renderFirstVisitGuide() : '';
            
            if (messages.length === 0) {
                messagesContainer.innerHTML = configRequiredHtml + guideHtml + (isConfigured ? \`
                    <div class="empty-state">
                         <h3>Ask a question to search your codebase or enhance your prompts </h3>
                    </div>
                \` : '');
                return;
            }

            messagesContainer.innerHTML = configRequiredHtml + guideHtml + messages.map((msg, index) => {
                const roleText = msg.role === 'user' ? 'You' : 'Ace Sidebar';
                const roleClass = msg.role;
                const cleanedContent = cleanMessageContent(msg.content);
                const messageId = 'msg-' + index;
                // 将内容转义为 HTML 属性值
                const escapedContent = cleanedContent
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
                return \`
                    <div class="message \${roleClass}">
                        <div class="message-header">
                            <span class="message-role">\${roleText}</span>
                            <span class="message-time">\${formatTime(msg.timestamp)}</span>
                        </div>
                        <div class="message-content-wrapper">
                            <div class="message-content" id="content-\${messageId}">\${escapeHtml(cleanedContent)}</div>
                            <button class="message-copy-btn" 
                                    data-message-id="\${messageId}" 
                                    data-content="\${escapedContent}"
                                    title="复制消息">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2h8c1.1 0 2 .9 2 2"></path></svg>
                            </button>
                        </div>
                    </div>
                \`;
            }).join('');

            // 绑定复制按钮事件
            messagesContainer.querySelectorAll('.message-copy-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const button = e.target.closest('.message-copy-btn');
                    const content = button.getAttribute('data-content');
                    const textContent = decodeHtmlEntities(content);
                    
                    try {
                        await navigator.clipboard.writeText(textContent);
                        button.classList.add('copied');
                        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                        setTimeout(() => {
                            button.classList.remove('copied');
                            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2h8c1.1 0 2 .9 2 2"></path></svg>';
                        }, 2000);
                    } catch (err) {
                        // 降级方案：使用传统方法
                        const textArea = document.createElement('textarea');
                        textArea.value = textContent;
                        textArea.style.position = 'fixed';
                        textArea.style.opacity = '0';
                        document.body.appendChild(textArea);
                        textArea.select();
                        try {
                            document.execCommand('copy');
                            button.classList.add('copied');
                            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                            setTimeout(() => {
                                button.classList.remove('copied');
                                button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2h8c1.1 0 2 .9 2 2"></path></svg>';
                            }, 2000);
                        } catch (fallbackErr) {
                            console.error('复制失败:', fallbackErr);
                        }
                        document.body.removeChild(textArea);
                    }
                });
            });

            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function decodeHtmlEntities(text) {
            const div = document.createElement('div');
            div.innerHTML = text;
            return div.textContent || div.innerText || '';
        }

        function escapeHtml(text) {
            if (!text) return '';
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
                    updateEditorContext(message.editorContext);
                    updateMcpStatus(message.mcpStatus);
                    isProcessing = false;
                    updateUIState();
                    if (isConfigured) {
                        messageInput.focus();
                    }
                    break;
                case 'updateEditorContext':
                    // 【修复问题3】仅更新编辑器上下文，不重新渲染消息列表
                    updateEditorContext(message.editorContext);
                    break;
                case 'indexProgress':
                    updateIndexProgress(message.update);
                    break;
                case 'mcpStatus':
                    updateMcpStatus(message.status);
                    break;
            }
        });

        // 页面加载时初始化 UI 状态
        updateUIState();
        
        // 请求初始 MCP 状态
        vscode.postMessage({ command: 'getMcpStatus' });
    </script>
</body>
</html>`;
  }

  /**
   * 清理资源
   */
  public dispose(): void {
    // 清理编辑器变化监听器
    if (this.editorChangeDisposable) {
      this.editorChangeDisposable.dispose();
      this.editorChangeDisposable = undefined;
    }
  }
}


import * as vscode from 'vscode';
import { ChatService } from './services/ChatService';
import { IndexManager } from './index/manager';
import { Config } from './config';
import { getVSCodeConfig, sendLog } from './utils/VSCodeAdapter';
import { SidebarProvider } from './views/SidebarProvider';
import { ChatViewProvider } from './views/ChatViewProvider';
import { MCPServer } from './mcp/server';

let chatService: ChatService | null = null;
let sidebarProvider: SidebarProvider | null = null;
let chatViewProvider: ChatViewProvider | null = null;
let mcpServer: MCPServer | null = null;
let isConfigured = false;
let statusBarItem: vscode.StatusBarItem | null = null;
let chatStatusBarItem: vscode.StatusBarItem | null = null;

// 索引同步优化相关变量
let isIndexing = false; // 标志位：是否正在进行索引同步
let indexDebounceTimers: Map<string, NodeJS.Timeout> = new Map(); // 防抖定时器映射表
const INDEX_DEBOUNCE_DELAY = 500; // 防抖延迟时间（毫秒）

function openSettings(): void {
  vscode.commands.executeCommand('workbench.action.openSettings', 'ace-sidebar');
}

function promptForSettings(message: string): void {
  vscode.window.showWarningMessage(message, 'Open Settings').then((selection) => {
    if (selection === 'Open Settings') {
      openSettings();
    }
  });
}

function loadConfig(showPrompt: boolean): Config | null {
  try {
    return getVSCodeConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendLog('error', `Config error: ${message}`);
    if (showPrompt) {
      promptForSettings(`Ace Sidebar: ${message}`);
    }
    return null;
  }
}

function updateStatusBar(): void {
  if (statusBarItem) {
    if (isConfigured) {
      statusBarItem.command = 'ace-sidebar.searchContext';
      statusBarItem.text = '$(search) Ace Sidebar';
      statusBarItem.tooltip = 'Search codebase context';
    } else {
      statusBarItem.command = 'ace-sidebar.openSettings';
      statusBarItem.text = '$(gear) Ace Sidebar Setup';
      statusBarItem.tooltip = 'Configure Ace Sidebar';
    }
  }

  if (chatStatusBarItem) {
    if (isConfigured) {
      chatStatusBarItem.command = 'ace-sidebar.openChat';
      chatStatusBarItem.text = '$(comment-discussion) Chat';
      chatStatusBarItem.tooltip = 'Open Ace Sidebar Chat';
    } else {
      chatStatusBarItem.command = 'ace-sidebar.openSettings';
      chatStatusBarItem.text = '$(gear) Chat Setup';
      chatStatusBarItem.tooltip = 'Configure Ace Sidebar';
    }
  }
}

function updateConfigState(config: Config | null): void {
  isConfigured = !!config;
  sidebarProvider?.setConfigured(isConfigured);
  chatViewProvider?.setConfigured(isConfigured);
  updateStatusBar();
}

function ensureServices(config: Config): void {
  if (chatService) {
    chatService.updateConfig(config);
  } else {
    chatService = new ChatService(config);
  }

  // 将 ChatService 设置到 ChatViewProvider
  if (chatViewProvider && chatService) {
    chatViewProvider.setChatService(chatService);
  }

  // 管理 MCP Server
  manageMcpServer(config);
}

/**
 * 管理 MCP Server 的启动和停止
 */
async function manageMcpServer(config: Config): Promise<void> {
  const shouldEnable = config.enableMcpServer !== false; // 默认为 true
  const port = config.mcpServerPort || 13000;

  if (shouldEnable) {
    // 需要启动或重启 MCP Server
    if (mcpServer) {
      const status = mcpServer.getStatus();
      if (status.isRunning && status.port !== port) {
        // 端口变化，需要重启
        await mcpServer.stop();
        mcpServer = null;
      } else if (status.isRunning) {
        // 已经在运行，无需操作
        return;
      }
    }

    // 创建并启动新的 MCP Server
    if (!mcpServer) {
      mcpServer = new MCPServer(port);
    }

    try {
      await mcpServer.start(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendLog('error', `启动 MCP Server 失败: ${message}`);
      mcpServer = null;
    }
  } else {
    // 需要停止 MCP Server
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = null;
    }
  }
}

/**
 * 执行文件索引同步（带防抖和去重机制）
 * @param filePath 文件路径
 * @param config 配置对象
 */
async function indexFileWithDebounce(filePath: string, config: Config): Promise<void> {
  // 清除该文件之前的防抖定时器
  const existingTimer = indexDebounceTimers.get(filePath);
  if (existingTimer) {
    clearTimeout(existingTimer);
    indexDebounceTimers.delete(filePath);
  }

  // 创建新的防抖定时器
  const timer = setTimeout(async () => {
    // 移除已完成的定时器
    indexDebounceTimers.delete(filePath);

    // 检查是否已有正在进行的索引任务
    if (isIndexing) {
      sendLog('info', `跳过索引同步，当前有正在进行的索引任务: ${filePath}`);
      return;
    }

    // 设置索引标志
    isIndexing = true;

    try {
      const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!projectRoot) {
        return;
      }

      const indexManager = new IndexManager(
        projectRoot,
        config.baseUrl,
        config.token,
        config.textExtensions,
        config.batchSize,
        config.maxLinesPerBlob,
        config.excludePatterns,
        config.userGuidelines || ''
      );

      sendLog('info', `开始索引文件: ${filePath}`);
      
      await indexManager.indexFile(filePath, (update) => {
        chatService?.reportIndexProgress(update);
        chatViewProvider?.reportIndexProgress(update);
      });

      sendLog('info', `文件索引完成: ${filePath}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sendLog('error', `索引同步失败: ${message}`);
    } finally {
      // 重置索引标志
      isIndexing = false;
    }
  }, INDEX_DEBOUNCE_DELAY);

  // 保存定时器
  indexDebounceTimers.set(filePath, timer);
}

export function activate(context: vscode.ExtensionContext) {
  // Sidebar
  sidebarProvider = new SidebarProvider();
  const treeView = vscode.window.createTreeView('aceSidebar', {
    treeDataProvider: sidebarProvider,
    showCollapseAll: false
  });
  context.subscriptions.push(treeView);

  // Chat View Provider (侧边栏内的聊天对话框)
  chatViewProvider = new ChatViewProvider(context.extensionUri, context);
  const chatViewDisposable = vscode.window.registerWebviewViewProvider(
    ChatViewProvider.viewType,
    chatViewProvider,
    {
      // 【关键修复】启用 retainContextWhenHidden，防止标签页切换时 webview 重新加载
      // 这会使 webview 在隐藏时保持其 DOM 状态，避免重复渲染
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }
  );
  context.subscriptions.push(chatViewDisposable);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  chatStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBarItem.show();
  chatStatusBarItem.show();
  context.subscriptions.push(statusBarItem, chatStatusBarItem);

  // Config bootstrap
  const initialConfig = loadConfig(true);
  updateConfigState(initialConfig);
  if (initialConfig) {
    try {
      ensureServices(initialConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendLog('error', `Service initialization failed: ${message}`);
      vscode.window.showErrorMessage(`Ace Sidebar: Failed to initialize services - ${message}`);
      return;
    }
  }

  // Commands
  const searchCommand = vscode.commands.registerCommand('ace-sidebar.searchContext', async () => {
    const latestConfig = loadConfig(true);
    updateConfigState(latestConfig);
    if (!latestConfig) {
      vscode.window.showWarningMessage('请先完成配置才能使用搜索功能', '打开设置').then((selection) => {
        if (selection === '打开设置') {
          openSettings();
        }
      });
      return;
    }
    ensureServices(latestConfig);

    const query = await vscode.window.showInputBox({
      prompt: 'Enter your search query',
      placeHolder: 'e.g., Where is the authentication function?',
      validateInput: (value: string | undefined) => {
        if (!value || value.trim().length === 0) {
          return 'Query cannot be empty';
        }
        return null;
      }
    });

    if (!query) {
      return;
    }

    const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!projectRoot) {
      vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
      return;
    }

    await chatService!.searchAndShowInPanel(projectRoot, query);
  });

  const chatCommand = vscode.commands.registerCommand('ace-sidebar.openChat', async () => {
    try {
      const latestConfig = loadConfig(false);
      updateConfigState(latestConfig);
      
      // 显示侧边栏内的聊天视图
      // 首先确保侧边栏视图容器可见
      await vscode.commands.executeCommand('workbench.view.extension.ace-sidebar');
      // 然后聚焦到聊天视图
      await vscode.commands.executeCommand('ace-sidebar.chatView.focus');
      
      if (latestConfig) {
        ensureServices(latestConfig);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Ace Sidebar Chat Error: ${message}`);
      sendLog('error', `Open chat failed: ${message}`);
    }
  });

  // 注册聚焦聊天视图的命令
  const focusChatViewCommand = vscode.commands.registerCommand('ace-sidebar.chatView.focus', async () => {
    // 确保侧边栏视图容器可见
    await vscode.commands.executeCommand('workbench.view.extension.ace-sidebar');
    // 这个命令由 VS Code 自动处理，用于聚焦 webviewView
  });

  const openSettingsCommand = vscode.commands.registerCommand('ace-sidebar.openSettings', () => {
    openSettings();
  });

  const refreshCommand = vscode.commands.registerCommand('ace-sidebar.refresh', () => {
    sidebarProvider?.refresh();
  });

  context.subscriptions.push(searchCommand, chatCommand, openSettingsCommand, refreshCommand, focusChatViewCommand);

  // Config change listener
  const configChange = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('ace-sidebar')) {
      return;
    }
    const latestConfig = loadConfig(false);
    updateConfigState(latestConfig);
    if (!latestConfig) {
      return;
    }
    ensureServices(latestConfig);
    
    // 如果 MCP Server 相关配置变化，需要重新管理
    if (
      event.affectsConfiguration('ace-sidebar.enableMcpServer') ||
      event.affectsConfiguration('ace-sidebar.mcpServerPort')
    ) {
      manageMcpServer(latestConfig);
    }
  });
  context.subscriptions.push(configChange);

  // File save listener for incremental indexing (with debounce and deduplication)
  const fileSave = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (document.uri.scheme !== 'file') {
      return;
    }
    const latestConfig = loadConfig(false);
    updateConfigState(latestConfig);
    if (!latestConfig) {
      return;
    }

    ensureServices(latestConfig);
    const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!projectRoot) {
      return;
    }

    // 使用防抖机制触发索引
    await indexFileWithDebounce(document.uri.fsPath, latestConfig);
  });
  context.subscriptions.push(fileSave);
}

export async function deactivate() {
  // 清理所有防抖定时器
  indexDebounceTimers.forEach((timer) => {
    clearTimeout(timer);
  });
  indexDebounceTimers.clear();

  // 停止 MCP Server
  if (mcpServer) {
    await mcpServer.stop();
    mcpServer = null;
  }

  if (chatService) {
    chatService.dispose();
    chatService = null;
  }
  
  if (chatViewProvider) {
    chatViewProvider.dispose();
    chatViewProvider = null;
  }
  
  sidebarProvider = null;
}

import * as vscode from 'vscode';
import { ChatService } from './services/ChatService';
import { IndexManager } from './index/manager';
import { Config } from './config';
import { getVSCodeConfig, sendLog } from './utils/VSCodeAdapter';
import { SidebarProvider } from './views/SidebarProvider';
import { ChatViewProvider } from './views/ChatViewProvider';

let chatService: ChatService | null = null;
let sidebarProvider: SidebarProvider | null = null;
let chatViewProvider: ChatViewProvider | null = null;
let isConfigured = false;
let statusBarItem: vscode.StatusBarItem | null = null;
let chatStatusBarItem: vscode.StatusBarItem | null = null;

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
    chatViewProvider
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
  });
  context.subscriptions.push(configChange);

  // File save listener for incremental indexing
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

    try {
      const indexManager = new IndexManager(
        projectRoot,
        latestConfig.baseUrl,
        latestConfig.token,
        latestConfig.textExtensions,
        latestConfig.batchSize,
        latestConfig.maxLinesPerBlob,
        latestConfig.excludePatterns,
        latestConfig.userGuidelines || ''
      );

      await indexManager.indexFile(document.uri.fsPath, (update) => {
        chatService?.reportIndexProgress(update);
        chatViewProvider?.reportIndexProgress(update);
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sendLog('error', `Index on save failed: ${message}`);
    }
  });
  context.subscriptions.push(fileSave);
}

export function deactivate() {
  if (chatService) {
    chatService.dispose();
    chatService = null;
  }
  sidebarProvider = null;
  chatViewProvider = null;
}

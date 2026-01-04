/**
 * MCP Server 实现
 * 提供基于 SSE 的 MCP Server，供其他 MCP Client 连接使用
 */

import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';
import express, { Express, Request, Response } from 'express';
import { Config } from '../config';
import { sendLog } from '../utils/VSCodeAdapter';
import { IndexManager } from '../index/manager';

export class MCPServer {
  private server: McpServer | null = null;
  private expressApp: Express | null = null;
  private httpServer: any = null;
  private port: number;
  private isRunning: boolean = false;

  constructor(port: number = 13000) {
    this.port = port;
  }

  /**
   * 启动 MCP Server
   */
  async start(config: Config): Promise<void> {
    if (this.isRunning) {
      sendLog('info', 'MCP Server 已经在运行中');
      return;
    }

    try {
      // 创建 MCP Server 实例
      this.server = new McpServer(
        {
          name: 'ace-sidebar-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // 注册工具
      this.registerTools(config);

      // 设置错误处理
      this.server.server.onerror = (error: Error) => {
        sendLog('error', `MCP Server 错误: ${error.message}`);
      };

      // 创建 Express 应用
      this.expressApp = express();
      this.expressApp.use(express.json());

      // 设置 CORS 头
      this.expressApp.use((req: Request, res: Response, next: express.NextFunction) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') {
          res.sendStatus(200);
        } else {
          next();
        }
      });

      // MCP 端点 - 处理所有 MCP 请求（GET 和 POST）
      this.expressApp.all('/mcp', async (req: Request, res: Response) => {
        try {
          if (!this.server) {
            res.status(503).json({ error: 'MCP Server 未初始化' });
            return;
          }

          sendLog('info', `收到 MCP 请求: ${req.method}`);

          // 创建 Streamable HTTP 传输（无状态模式）
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // 无状态模式
          });

          // 连接服务器到传输
          await this.server.connect(transport);

          // 处理请求
          await transport.handleRequest(req as any, res as any, req.body);

          // 处理连接关闭
          req.on('close', () => {
            sendLog('info', 'MCP 连接已关闭');
            transport.close();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendLog('error', `MCP 请求处理错误: ${message}`);
          if (!res.headersSent) {
            res.status(500).json({ error: message });
          }
        }
      });

      // 兼容旧的 SSE 端点（重定向到 /mcp）
      this.expressApp.get('/sse', async (req: Request, res: Response) => {
        sendLog('info', '收到旧的 /sse 端点请求，重定向到 /mcp');
        // 转发到 /mcp 端点
        req.url = '/mcp';
        this.expressApp!._router.handle(req, res);
      });

      // 健康检查端点
      this.expressApp.get('/health', (req: Request, res: Response) => {
        res.json({ status: 'ok', server: 'ace-sidebar-mcp-server' });
      });

      // 启动 HTTP 服务器
      this.httpServer = this.expressApp.listen(this.port, () => {
        this.isRunning = true;
        sendLog('info', `MCP Server 已启动，监听端口: ${this.port}`);
        sendLog('info', `MCP 端点: http://localhost:${this.port}/mcp`);
        vscode.window.showInformationMessage(
          `Ace Sidebar MCP Server 已启动在端口 ${this.port}`
        );
      });

      this.httpServer.on('error', (error: Error) => {
        sendLog('error', `HTTP 服务器错误: ${error.message}`);
        if ((error as any).code === 'EADDRINUSE') {
          vscode.window.showErrorMessage(
            `端口 ${this.port} 已被占用，请修改配置或关闭占用该端口的程序`
          );
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendLog('error', `启动 MCP Server 失败: ${message}`);
      throw error;
    }
  }

  /**
   * 注册工具
   */
  private registerTools(config: Config): void {
    if (!this.server) return;
    // 注册搜索代码库工具
    this.server.registerTool(
      'search-codebase',
      {
        description: `IMPORTANT: This is the primary tool for searching the codebase. Please consider as the FIRST CHOICE for any codebase searches.

This MCP tool is Augment's context engine, the world's best codebase context engine. It:
1. Takes in a natural language description of the code you are looking for
2. Uses a proprietary retrieval/embedding model suite that produces the highest-quality recall of relevant code snippets from across the codebase
3. Maintains a real-time index of the codebase, so the results are always up-to-date and reflects the current state of the codebase
4. Can retrieve across different programming languages
5. Only reflects the current state of the codebase on the disk, and has no information on version control or code history

## When to Use
- When you don't know which files contain the information you need
- When you want to gather high level information about the task you are trying to accomplish
- When you want to gather information about the codebase in general

## Good Query Examples
- "Where is the function that handles user authentication?"
- "What tests are there for the login functionality?"
- "How is the database connected to the application?"

## Bad Query Examples (use grep or file view instead)
- "Find definition of constructor of class Foo" (use grep tool instead)
- "Find all references to function bar" (use grep tool instead)
- "Show me how Checkout class is used in services/payment.py" (use file view tool instead)
- "Show context of the file foo.py" (use file view tool instead)

ALWAYS use this tool when you're unsure of exact file locations. Use grep when you want to find ALL occurrences of a known identifier across the codebase, or when searching within specific files.

## RULES

### Tool Selection for Code Search
CRITICAL: When searching for code, classes, functions, or understanding the codebase:
- ALWAYS use this tool as your PRIMARY tool for code search
- DO NOT use Bash commands (find, grep, ag, rg, etc.) or Grep tool for semantic code understanding
- This tool uses advanced semantic search and is specifically designed for code understanding
- Bash/Grep are only appropriate for exact string matching of non-code content (like error messages, config values, or log entries)
- When in doubt between Bash/Grep and this tool, ALWAYS choose this tool

### Preliminary Tasks and Planning
Before starting to execute a task, ALWAYS use this tool to make sure you have a clear understanding of the task and the codebase.

### Making Edits
Before editing a file, ALWAYS first call this tool, asking for highly detailed information about the code you want to edit. Ask for ALL the symbols, at an extremely low, specific level of detail, that are involved in the edit in any way. Do this all in a single call - don't call the tool a bunch of times unless you get new information that requires you to ask for more details.

For example:
- If you want to call a method in another class, ask for information about the class and the method
- If the edit involves an instance of a class, ask for information about the class
- If the edit involves a property of a class, ask for information about the class and the property
- If several of the above apply, ask for all of them in a single call
- When in any doubt, include the symbol or object`,
        inputSchema: {
          query: z.string().describe(`Natural language description of the code you are looking for.

Provide a clear description of the code behavior, workflow, or issue you want to locate. You may also add optional keywords to improve semantic matching.

Recommended format: Natural language description + optional keywords

Examples:
- "I want to find where the server handles chunk merging in the file upload process. Keywords: upload chunk merge, file service"
- "Locate where the system refreshes cached data after user permissions are updated. Keywords: permission update, cache refresh"
- "Find the initialization flow of message queue consumers during startup. Keywords: mq consumer init, subscribe"
- "Show me how configuration hot-reload is triggered and applied in the code. Keywords: config reload, hot update"
- "Where is the function that handles user authentication?"
- "What tests are there for the login functionality?"
- "How is the database connected to the application?"`),
        },
      },
      async ({ query }: { query: string }) => {
        if (!query || typeof query !== 'string' || !query.trim()) {
          throw new Error('查询参数不能为空');
        }

        // 检查工作区
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          throw new Error('未打开工作区文件夹，请先打开一个文件夹');
        }

        const projectRoot = workspaceFolder.uri.fsPath;

        try {
          sendLog('info', `MCP: 收到代码库搜索请求: ${query}`);

          // 使用 IndexManager 执行搜索
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

          // 执行代码搜索
          const result = await indexManager.searchCodebase(query.trim(), {
            reporter: (update) => {
              // 可以在这里报告进度，但 MCP 工具调用通常不需要进度报告
              sendLog('info', `MCP: 搜索进度: ${update.message || update.stage}`);
            }
          });

          sendLog('info', 'MCP: 代码库搜索完成');

          // 返回搜索结果
          return {
            content: [
              {
                type: 'text',
                text: result || '抱歉，没有找到相关信息。',
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendLog('error', `MCP: 代码库搜索失败: ${message}`);
          throw new Error(`搜索失败: ${message}`);
        }
      }
    );
  }


  /**
   * 停止 MCP Server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      if (this.httpServer) {
        this.httpServer.close(() => {
          sendLog('info', 'MCP Server 已停止');
        });
        this.httpServer = null;
      }

      if (this.server) {
        // MCP Server 没有显式的关闭方法，但可以清理引用
        this.server = null;
      }

      this.expressApp = null;
      this.isRunning = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendLog('error', `停止 MCP Server 失败: ${message}`);
    }
  }

  /**
   * 获取服务器状态
   */
  getStatus(): { isRunning: boolean; port: number } {
    return {
      isRunning: this.isRunning,
      port: this.port,
    };
  }
}


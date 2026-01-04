# Ace Sidebar

一个强大的 VS Code 扩展，提供智能代码库索引、语义搜索和 AI 聊天功能，帮助开发者更高效地理解和探索代码库。

## ✨ 核心特性

### 🔍 智能代码库搜索
- **语义搜索**：使用自然语言查询代码库，无需精确匹配关键词
- **实时索引**：自动扫描并索引项目文件，保持代码库信息最新
- **增量更新**：基于 SHA-256 哈希的增量索引，只上传新增或修改的文件
- **多语言支持**：支持 Python、JavaScript、TypeScript、Go、Rust、Java 等 30+ 种编程语言

### 💬 AI 聊天助手
- **上下文感知**：基于代码库上下文进行智能对话
- **侧边栏集成**：在 VS Code 侧边栏中直接使用，无需切换窗口
- **自定义指南**：支持配置用户指南，定制 AI 助手的行为和响应方式

### 🔌 MCP Server
- **SSE 传输**：内置基于 Server-Sent Events 的 MCP Server
- **标准协议**：遵循 Model Context Protocol 标准，可与其他 MCP 客户端连接
- **工具提供**：提供 `search-codebase` 工具，供其他 MCP 客户端调用

### 🛠️ 开发体验优化
- **多编码支持**：自动识别并处理 UTF-8、GBK、GB2312、Latin1 等编码格式
- **Gitignore 支持**：自动遵循 `.gitignore` 规则，排除不需要索引的文件
- **防抖优化**：文件保存时自动触发索引，采用防抖机制避免频繁更新
- **批量上传**：支持配置批量大小，优化网络传输效率

## 📋 系统要求

- **VS Code**：1.80.0 或更高版本
- **Node.js**：18.0.0 或更高版本

## 🚀 快速开始

### 安装

1. 克隆仓库
```bash
git clone <repository-url>
cd ace-sidebar
```

2. 安装依赖
```bash
npm install
```

3. 编译项目
```bash
npm run compile
```

4. 在 VS Code 中调试
   - 按 `F5` 打开新的 VS Code 窗口，扩展将自动加载
   - 或使用 `Ctrl+Shift+P` (Mac: `Cmd+Shift+P`) 打开命令面板，选择 "Developer: Reload Window"

### 配置

在 VS Code 设置中配置扩展（`File > Preferences > Settings` 或 `Ctrl+,`）：

```json
{
  "ace-sidebar.baseUrl": "https://api.example.com",
  "ace-sidebar.token": "your-api-token",
  "ace-sidebar.batchSize": 10,
  "ace-sidebar.maxLinesPerBlob": 800,
  "ace-sidebar.enableLog": false,
  "ace-sidebar.enableMcpServer": true,
  "ace-sidebar.mcpServerPort": 13000,
  "ace-sidebar.userGuidelines": ""
}
```

#### 配置选项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `ace-sidebar.baseUrl` | string | `""` | **必填** - API 服务的基础 URL 地址 |
| `ace-sidebar.token` | string | `""` | **必填** - API 认证令牌 |
| `ace-sidebar.batchSize` | number | `10` | 每批上传的文件切片数量（1-100） |
| `ace-sidebar.maxLinesPerBlob` | number | `800` | 单个文件切片的最大行数（100-2000） |
| `ace-sidebar.textExtensions` | array | 见下方 | 需要索引的文件扩展名列表 |
| `ace-sidebar.excludePatterns` | array | 见下方 | 索引时排除的路径或通配符模式 |
| `ace-sidebar.enableLog` | boolean | `false` | 是否开启详细日志输出 |
| `ace-sidebar.userGuidelines` | string | `""` | 用户指南，用于自定义 AI 助手的行为 |
| `ace-sidebar.enableMcpServer` | boolean | `true` | 是否启用 MCP Server（SSE 端点） |
| `ace-sidebar.mcpServerPort` | number | `13000` | MCP Server 监听端口（1024-65535） |

**默认索引的文件扩展名**：
`.py`, `.js`, `.ts`, `.jsx`, `.tsx`, `.java`, `.go`, `.rs`, `.cpp`, `.c`, `.h`, `.hpp`, `.cs`, `.rb`, `.php`, `.swift`, `.kt`, `.scala`, `.clj`, `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.ini`, `.conf`, `.html`, `.css`, `.scss`, `.sass`, `.less`, `.sql`, `.sh`, `.bash`, `.ps1`, `.bat`, `.vue`, `.svelte`

**默认排除模式**：
`.venv`, `venv`, `.env`, `env`, `node_modules`, `.git`, `.svn`, `.hg`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.tox`, `.eggs`, `*.egg-info`, `dist`, `build`, `target`, `out`, `.idea`, `.vscode`, `.vs`, `.DS_Store`, `Thumbs.db`, `*.pyc`, `*.pyo`, `*.pyd`, `*.so`, `*.dll`, `.ace-tool`

## 📖 使用指南

### 代码库搜索

1. 打开工作区文件夹（`File > Open Folder`）
2. 使用以下任一方式触发搜索：
   - 点击状态栏的搜索图标
   - 使用命令面板（`Ctrl+Shift+P`），输入 "Ace Sidebar: Search Context"
   - 使用快捷键（如果已配置）
3. 输入自然语言查询，例如：
   - "Where is the authentication function?"
   - "What tests are there for the login functionality?"
   - "How is the database connected to the application?"
4. 查看搜索结果，结果会显示在通知或 WebView 面板中

### AI 聊天

1. 点击状态栏的聊天图标，或使用命令 "Ace Sidebar: Open Chat"
2. 在侧边栏的聊天视图中与 AI 助手对话
3. AI 助手会自动使用代码库上下文回答您的问题
4. 首次使用时，系统会自动进行代码库索引

### 自动索引

- 扩展会在文件保存时自动触发增量索引
- 使用防抖机制，避免频繁更新
- 只索引新增或修改的文件，提高效率

## 🔌 MCP Server

### 概述

Ace Sidebar 内置了一个符合 Model Context Protocol (MCP) 标准的服务器，使用 Server-Sent Events (SSE) 作为传输协议。其他 MCP 客户端可以连接到此服务器，使用其提供的代码库搜索功能。

### 配置

MCP Server 默认启用，监听端口为 `13000`。可以在 VS Code 设置中修改：

```json
{
  "ace-sidebar.enableMcpServer": true,
  "ace-sidebar.mcpServerPort": 13000
}
```

### 端点

- **MCP 端点**：`http://localhost:13000/mcp` - 主要的 MCP 请求端点（支持 GET 和 POST）
- **兼容端点**：`http://localhost:13000/sse` - 重定向到 `/mcp`，保持向后兼容
- **健康检查**：`http://localhost:13000/health` - 服务器健康状态检查

### 连接配置

从其他 MCP 客户端连接到此服务器，使用以下配置：

```json
{
  "mcpServers": {
    "ace-sidebar": {
      "type": "sse",
      "url": "http://localhost:13000/mcp"
    }
  }
}
```

### 可用工具

#### `search-codebase`

搜索代码库的自然语言查询工具。

**参数**：
- `query` (string, 必填) - 自然语言查询，例如："Where is the authentication function?"

**返回**：
- 格式化的文本结果，包含相关的代码片段和上下文信息

**使用示例**：
```json
{
  "tool": "search-codebase",
  "arguments": {
    "query": "Where is the user authentication function implemented?"
  }
}
```

**最佳实践**：
- 使用自然语言描述代码行为、工作流或问题
- 可以添加可选关键词以提高语义匹配
- 推荐格式：自然语言描述 + 可选关键词

**示例查询**：
- "I want to find where the server handles chunk merging in the file upload process. Keywords: upload chunk merge, file service"
- "Locate where the system refreshes cached data after user permissions are updated. Keywords: permission update, cache refresh"
- "Where is the function that handles user authentication?"

## 🏗️ 项目结构

```
ace-sidebar/
├── src/                          # 源代码目录
│   ├── extension.ts              # 扩展入口点
│   ├── config.ts                 # 配置类型定义
│   ├── services/                 # 服务层
│   │   └── ChatService.ts        # 聊天服务
│   ├── index/                    # 索引管理
│   │   └── manager.ts            # 核心索引逻辑
│   ├── mcp/                      # MCP Server
│   │   └── server.ts             # MCP 服务器实现
│   ├── utils/                    # 工具类
│   │   ├── VSCodeAdapter.ts      # VS Code API 适配器
│   │   └── projectDetector.ts   # 项目根目录检测
│   └── views/                    # 视图提供者
│       ├── ChatViewProvider.ts   # 聊天视图提供者
│       └── SidebarProvider.ts    # 侧边栏提供者
├── out/                          # 编译输出目录
├── package.json                  # 项目配置和依赖
├── tsconfig.json                 # TypeScript 配置
└── README.md                     # 项目文档
```

## 🛠️ 开发指南

### 构建项目

```bash
# 编译 TypeScript
npm run compile

# 监听模式（自动编译）
npm run watch
```

### 代码检查

```bash
# 运行 ESLint
npm run lint
```

### 测试

```bash
# 运行测试（需要先编译）
npm test
```

### 调试

1. 在 VS Code 中打开项目
2. 按 `F5` 启动调试
3. 新的 VS Code 窗口将打开，扩展已加载
4. 在调试窗口中测试扩展功能
5. 使用 VS Code 的调试工具查看日志和断点

### 日志查看

如果启用了 `ace-sidebar.enableLog`，可以在 VS Code 的输出面板中查看详细日志：
1. 打开输出面板（`View > Output` 或 `Ctrl+Shift+U`）
2. 在下拉菜单中选择 "Ace Sidebar"

## 📝 命令列表

| 命令 | 说明 |
|------|------|
| `ace-sidebar.searchContext` | 搜索代码库上下文 |
| `ace-sidebar.openChat` | 打开聊天界面 |
| `ace-sidebar.refresh` | 刷新侧边栏 |
| `ace-sidebar.openSettings` | 打开设置页面 |
| `ace-sidebar.chatView.focus` | 聚焦聊天视图 |

## 🔧 故障排除

### 常见问题

**1. 扩展无法启动**
- 检查 VS Code 版本是否满足要求（≥1.80.0）
- 检查 Node.js 版本是否满足要求（≥18.0.0）
- 查看输出面板中的错误日志

**2. 搜索功能不工作**
- 确认已配置 `baseUrl` 和 `token`
- 检查网络连接是否正常
- 查看日志输出（启用 `enableLog`）

**3. MCP Server 无法启动**
- 检查端口是否被占用
- 确认 `enableMcpServer` 设置为 `true`
- 查看输出面板中的错误信息

**4. 索引速度慢**
- 调整 `batchSize` 参数（增大可提高速度，但会增加内存使用）
- 检查 `excludePatterns` 是否正确配置，排除不必要的文件
- 确认网络连接稳定

## 🤝 贡献指南

欢迎贡献代码！请遵循以下步骤：

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

### 代码规范

- 遵循 TypeScript 官方编码规范
- 使用 ESLint 进行代码检查
- 提交前运行 `npm run lint` 确保代码质量
- 添加适当的注释，特别是复杂逻辑

## 📄 许可证

本项目采用 MIT 许可证。详情请参阅 [LICENSE](LICENSE) 文件。

## 🙏 致谢

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 协议标准
- [VS Code Extension API](https://code.visualstudio.com/api) - VS Code 扩展开发框架

## 📮 反馈与支持

如有问题或建议，请通过以下方式联系：

- 提交 [Issue](https://github.com/your-repo/ace-sidebar/issues)
- 发送 Pull Request
- 查看项目文档

---

**Ace Sidebar** - 让代码探索更智能、更高效 🚀

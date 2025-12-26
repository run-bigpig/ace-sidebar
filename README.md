# Ace Sidebar

A VSCode extension for codebase indexing and semantic search.

## Features

- **Codebase Indexing**: Automatically scan and index project files
- **Incremental Indexing**: Only upload new or changed files using SHA-256 hashing
- **Semantic Search**: Search codebase using natural language queries
- **Multi-encoding Support**: Supports UTF-8, GBK, GB2312, and Latin1 encodings
- **Gitignore Support**: Automatically respects `.gitignore` rules

## Requirements

- VSCode 1.80.0 or higher
- Node.js 18.0.0 or higher

## Installation

1. Clone this repository
2. Run `npm install` to install dependencies
3. Press `F5` to open a new VSCode window with the extension loaded

## Configuration

Configure the extension in VSCode settings (File > Preferences > Settings):

```json
{
  "ace-sidebar.baseUrl": "https://api.example.com",
  "ace-sidebar.token": "your-api-token",
  "ace-sidebar.batchSize": 10,
  "ace-sidebar.maxLinesPerBlob": 800,
  "ace-sidebar.enableLog": false
}
```

### Configuration Options

- `ace-sidebar.baseUrl` (required): API base URL for codebase retrieval service
- `ace-sidebar.token` (required): Authentication token for API access
- `ace-sidebar.batchSize` (default: 10): Number of file chunks to upload in each batch
- `ace-sidebar.maxLinesPerBlob` (default: 800): Maximum number of lines per file chunk
- `ace-sidebar.textExtensions` (default: see package.json): File extensions to index
- `ace-sidebar.excludePatterns` (default: see package.json): Patterns to exclude from indexing
- `ace-sidebar.enableLog` (default: false): Enable detailed logging to output channel

## Usage

1. Open a workspace folder in VSCode
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac) to open the command palette
3. Type "Ace Sidebar: Search Context" and select it
4. Enter your search query (e.g., "Where is the authentication function?")
5. Wait for indexing and search to complete
6. View results in the notification or WebView panel

You can also click the status bar button to quickly access the search command.

## Development

### Project Structure

```
ace-sidebar/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── config.ts             # Configuration types
│   ├── services/
│   │   └── SearchService.ts  # Search service layer
│   ├── utils/
│   │   ├── VSCodeAdapter.ts  # VSCode API adapter
│   │   └── projectDetector.ts # Project root detection
│   └── index/
│       └── manager.ts        # Core indexing logic
├── package.json
├── tsconfig.json
└── README.md
```

### Building

```bash
npm run compile
```

### Watching

```bash
npm run watch
```

### Testing

```bash
npm test
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.


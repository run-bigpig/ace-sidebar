/**
 * VSCode API 适配层
 * 将 VSCode Extension API 适配到现有代码结构
 */

import * as vscode from 'vscode';
import { Config } from '../config';

// 创建输出通道
const outputChannel = vscode.window.createOutputChannel('Ace Sidebar');

/**
 * 从 VSCode 配置获取配置对象
 */
export function getVSCodeConfig(): Config {
  const config = vscode.workspace.getConfiguration('ace-sidebar');
  
  const baseUrlInput = (config.get<string>('baseUrl', '') || '').trim();
  const token = (config.get<string>('token', '') || '').trim();

  if (!baseUrlInput) {
    throw new Error('baseUrl 不能为空，请在设置中填写 API 基础地址');
  }
  if (!token) {
    throw new Error('token 不能为空，请在设置中填写认证令牌');
  }

  // 确保 baseUrl 包含协议前缀
  let normalizedBaseUrl = baseUrlInput;
  if (!normalizedBaseUrl.startsWith('http://') && !normalizedBaseUrl.startsWith('https://')) {
    normalizedBaseUrl = `https://${normalizedBaseUrl}`;
  }
  normalizedBaseUrl = normalizedBaseUrl.replace(/\/$/, ''); // 移除末尾斜杠
  try {
    const parsedUrl = new URL(normalizedBaseUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('baseUrl 必须使用 http 或 https 协议');
    }
    if (!parsedUrl.hostname) {
      throw new Error('baseUrl 缺少有效的主机名');
    }
  } catch {
    throw new Error('baseUrl 格式不正确，请填写完整的 URL，例如 https://api.example.com');
  }

  return {
    baseUrl: normalizedBaseUrl,
    token,
    batchSize: config.get<number>('batchSize', 10),
    maxLinesPerBlob: config.get<number>('maxLinesPerBlob', 800),
    textExtensions: new Set(
      (config.get<string[]>('textExtensions', []) || [])
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    ),
    excludePatterns: (config.get<string[]>('excludePatterns', []) || [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    enableLog: config.get<boolean>('enableLog', false),
    userGuidelines: (config.get<string>('userGuidelines', '') || '').trim() || undefined
  };
}

/**
 * 发送日志到 VSCode Output Channel
 */
export function sendLog(level: 'debug' | 'info' | 'warning' | 'error', message: string): void {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const levelStr = level.toUpperCase().padEnd(7);
  const logLine = `[${timestamp}] [${levelStr}] ${message}`;
  
  outputChannel.appendLine(logLine);
  
  // 错误级别自动显示输出通道
  if (level === 'error') {
    outputChannel.show(true);
  }
}

/**
 * 获取项目根目录
 */
export function getProjectRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * 获取输出通道（用于外部访问）
 */
export function getOutputChannel(): vscode.OutputChannel {
  return outputChannel;
}


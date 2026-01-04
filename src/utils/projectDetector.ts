/**
 * 项目根目录检测工具
 * 适配 VSCode 工作区
 */

import fs from 'fs';
import path from 'path';

/**
 * 检测项目根目录
 * 优先级：.ace-tool/ > .git/
 *
 * @param workspacePath VSCode 工作区路径
 * @returns 项目根目录路径
 */
export function detectProjectRoot(workspacePath: string): string {
  let currentDir = workspacePath;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 优先检查 .ace-tool 目录
    const acePath = path.join(currentDir, '.ace-tool');
    if (fs.existsSync(acePath) && fs.statSync(acePath).isDirectory()) {
      return currentDir;
    }

    // 其次检查 .git 目录
    const gitPath = path.join(currentDir, '.git');
    if (fs.existsSync(gitPath)) {
      return currentDir;
    }

    // 向上一级目录
    const parentDir = path.dirname(currentDir);

    // 已到达根目录
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  // 如果找不到 .ace-tool 或 .git，使用工作区路径
  return workspacePath;
}

/**
 * 获取项目的 .ace-tool 目录路径
 * 如果不存在则创建
 *
 * @param projectRoot 项目根目录
 * @returns .ace-tool 目录路径
 */
export function getAceDir(projectRoot: string): string {
  const aceDir = path.join(projectRoot, '.ace-tool');

  if (!fs.existsSync(aceDir)) {
    fs.mkdirSync(aceDir, { recursive: true });

    // 尝试将 .ace-tool 添加到 .gitignore
    addToGitignore(projectRoot);
  }

  return aceDir;
}

/**
 * 将 .ace-tool 添加到 .gitignore
 */
function addToGitignore(projectRoot: string): void {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');

      // 检查是否已经包含 .ace-tool
      if (content.includes('.ace-tool')) {
        return;
      }
    }

    // 添加 .ace-tool 到 .gitignore
    const newContent = content.endsWith('\n') || content === ''
      ? `${content}.ace-tool/\n`
      : `${content}\n.ace-tool/\n`;

    fs.writeFileSync(gitignorePath, newContent, 'utf-8');
  } catch (error) {
    // 静默处理错误
  }
}

/**
 * 获取索引文件路径
 *
 * @param projectRoot 项目根目录
 * @returns index.json 文件路径
 */
export function getIndexFilePath(projectRoot: string): string {
  const aceDir = getAceDir(projectRoot);
  return path.join(aceDir, 'index.json');
}

/**
 * 规范化路径，统一使用正斜杠
 */
export function normalizePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}


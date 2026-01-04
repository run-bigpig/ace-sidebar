/**
 * 索引管理器 - 管理文件收集、索引和搜索操作
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import iconv from 'iconv-lite';
import ignore from 'ignore';
import * as vscode from 'vscode';
import { sendLog } from '../utils/VSCodeAdapter';
import { getIndexFilePath } from '../utils/projectDetector';

type IgnoreInstance = ReturnType<typeof ignore>;

export interface IndexProgressUpdate {
  stage: 'idle' | 'scanning' | 'hashing' | 'uploading' | 'saving' | 'enhancing' | 'searching' | 'complete' | 'error';
  message: string;
  percent?: number;
}

type IndexProgressReporter = (update: IndexProgressUpdate) => void;

interface IndexStore {
  version: number;
  blob_names: string[];
  file_map: Record<string, string[]>;
}

interface SearchOptions {
  reporter?: IndexProgressReporter;
}

/**
 * Blob 接口
 */
interface Blob {
  path: string;
  content: string;
  sourcePath: string;
}

/**
 * 编辑器上下文信息接口
 */
export interface EditorContext {
  // 文件相关信息
  filePath: string;          // 文件的相对路径
  fileName: string;          // 文件名（含扩展名）
  absolutePath: string;      // 文件的绝对路径
  languageId: string;        // 编程语言标识符
  
  // 代码内容
  prefix: string;            // 选中代码前的内容
  selectedCode: string;      // 选中的代码
  suffix: string;            // 选中代码后的内容
  
  // 工作区信息
  workspaceName: string;     // 工作区目录名
  hasSelection: boolean;     // 是否有选中内容
}

/**
 * 索引结果接口
 */
interface IndexResult {
  status: string;
  message: string;
  stats?: {
    total_blobs: number;
    existing_blobs: number;
    new_blobs: number;
  };
}

/**
 * 使用多种编码尝试读取文件
 */
async function readFileWithEncoding(filePath: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  const encodings = ['utf-8', 'gbk', 'gb2312', 'latin1'];

  for (const encoding of encodings) {
    try {
      const content = iconv.decode(buffer, encoding);
      const replacementChars = (content.match(/\uFFFD/g) || []).length;

      if (content.length > 0) {
        if (content.length < 100) {
          if (replacementChars > 5) continue;
        } else {
          if (replacementChars / content.length > 0.05) continue;
        }
      }

      if (encoding !== 'utf-8') {
        // 非 UTF-8 编码，静默处理
      }
      return content;
    } catch {
      continue;
    }
  }

  const content = iconv.decode(buffer, 'utf-8');
  return content;
}

/**
 * 计算 blob 名称（SHA-256 哈希）
 */
function calculateBlobName(filePath: string, content: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(filePath, 'utf-8');
  hash.update(content, 'utf-8');
  return hash.digest('hex');
}

/**
 * 睡眠工具函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 索引管理器类
 */
export class IndexManager {
  private projectRoot: string;
  private baseUrl: string;
  private token: string;
  private textExtensions: Set<string>;
  private batchSize: number;
  private maxLinesPerBlob: number;
  private excludePatterns: string[];
  private indexFilePath: string;
  private httpClient: AxiosInstance;
  private userGuidelines: string;

  constructor(
    projectRoot: string,
    baseUrl: string,
    token: string,
    textExtensions: Set<string>,
    batchSize: number,
    maxLinesPerBlob: number = 800,
    excludePatterns: string[] = [],
    userGuidelines: string = ''
  ) {
    this.projectRoot = projectRoot;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.textExtensions = textExtensions;
    this.batchSize = batchSize;
    this.maxLinesPerBlob = maxLinesPerBlob;
    this.excludePatterns = excludePatterns;
    this.userGuidelines = userGuidelines || '';
    this.indexFilePath = getIndexFilePath(projectRoot);

    this.httpClient = axios.create({
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
  }

  private reportProgress(
    reporter: IndexProgressReporter | undefined,
    update: IndexProgressUpdate
  ): void {
    if (reporter) {
      reporter(update);
    }
  }

  /**
   * Load index data.
   */
  private loadIndexStore(): IndexStore {
    if (!fs.existsSync(this.indexFilePath)) {
      return { version: 1, blob_names: [], file_map: {} };
    }
    try {
      const content = fs.readFileSync(this.indexFilePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return { version: 1, blob_names: parsed, file_map: {} };
      }
      if (parsed && Array.isArray(parsed.blob_names)) {
        return {
          version: typeof parsed.version === 'number' ? parsed.version : 1,
          blob_names: parsed.blob_names,
          file_map: parsed.file_map && typeof parsed.file_map === 'object' ? parsed.file_map : {}
        };
      }
      return { version: 1, blob_names: [], file_map: {} };
    } catch (error) {
      sendLog('error', `Failed to load index: ${error}`);
      return { version: 1, blob_names: [], file_map: {} };
    }
  }

  private saveIndexStore(store: IndexStore): void {
    try {
      const content = JSON.stringify(store, null, 2);
      fs.writeFileSync(this.indexFilePath, content, 'utf-8');
    } catch (error) {
      sendLog('error', `Failed to save index: ${error}`);
      throw error;
    }
  }

  public getBlobNames(): string[] {
    return this.loadIndexStore().blob_names;
  }

  /**
   * 获取当前编辑器的上下文信息（公共接口）
   * @returns 编辑器上下文对象，如果没有活动编辑器则返回 null
   */
  public getEditorContext(): EditorContext | null {
    return this.getCurrentEditorContext();
  }

  private collectBlobNames(fileMap: Record<string, string[]>): string[] {
    const names = new Set<string>();
    for (const hashes of Object.values(fileMap)) {
      for (const hash of hashes) {
        names.add(hash);
      }
    }
    return [...names];
  }

  private removeFileFromIndex(
    relativePath: string,
    reporter?: IndexProgressReporter,
    reason?: string
  ): IndexResult {
    const store = this.loadIndexStore();
    if (!store.file_map[relativePath]) {
      return { status: 'skipped', message: reason || 'File not indexed' };
    }

    const nextFileMap = { ...store.file_map };
    delete nextFileMap[relativePath];
    const nextStore: IndexStore = {
      version: 1,
      blob_names: this.collectBlobNames(nextFileMap),
      file_map: nextFileMap
    };

    this.saveIndexStore(nextStore);
    this.reportProgress(reporter, {
      stage: 'complete',
      message: reason || 'Index updated',
      percent: 100
    });

    return { status: 'success', message: reason || 'Index updated' };
  }

  /**
   * Split file content into blobs.
   */
  private splitFileContent(filePath: string, content: string): Blob[] {
    const lines: string[] = [];
    let start = 0;

    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') {
        lines.push(content.substring(start, i + 1));
        start = i + 1;
      } else if (content[i] === '\r') {
        if (i + 1 < content.length && content[i + 1] === '\n') {
          lines.push(content.substring(start, i + 2));
          start = i + 2;
          i++;
        } else {
          lines.push(content.substring(start, i + 1));
          start = i + 1;
        }
      }
    }

    if (start < content.length) {
      lines.push(content.substring(start));
    }

    const totalLines = lines.length;

    if (totalLines <= this.maxLinesPerBlob) {
      return [{ path: filePath, content, sourcePath: filePath }];
    }

    const blobs: Blob[] = [];
    const numChunks = Math.ceil(totalLines / this.maxLinesPerBlob);

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const startLine = chunkIdx * this.maxLinesPerBlob;
      const endLine = Math.min(startLine + this.maxLinesPerBlob, totalLines);
      const chunkLines = lines.slice(startLine, endLine);
      const chunkContent = chunkLines.join('');
      const chunkPath = `${filePath}#chunk${chunkIdx + 1}of${numChunks}`;
      blobs.push({ path: chunkPath, content: chunkContent, sourcePath: filePath });
    }

    return blobs;
  }

  /**
   * 收集所有文本文件
   */
  private loadGitignore(): IgnoreInstance | null {
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      const patterns = content.split('\n');
      return ignore().add(patterns);
    } catch {
      return null;
    }
  }

  private shouldExclude(
    filePath: string,
    gitignoreSpec: IgnoreInstance | null
  ): boolean {
    try {
      const relativePath = path.relative(this.projectRoot, filePath);
      const pathStr = relativePath.replace(/\\/g, '/');

      if (gitignoreSpec) {
        const isDir = fs.statSync(filePath).isDirectory();
        const testPath = isDir ? pathStr + '/' : pathStr;
        if (gitignoreSpec.ignores(testPath)) {
          return true;
        }
      }

      const pathParts = pathStr.split('/');
      for (const pattern of this.excludePatterns) {
        for (const part of pathParts) {
          if (this.matchPattern(part, pattern)) {
            return true;
          }
        }
        if (this.matchPattern(pathStr, pattern)) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private toRelativePath(filePath: string): string | null {
    const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
    if (relativePath.startsWith('..')) {
      return null;
    }
    return relativePath;
  }

  private matchPattern(str: string, pattern: string): boolean {
    const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(str);
  }

  private async collectFiles(): Promise<Blob[]> {
    const blobs: Blob[] = [];
    const gitignoreSpec = this.loadGitignore();

    const walkDir = async (dirPath: string): Promise<void> => {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          if (!this.shouldExclude(fullPath, gitignoreSpec)) {
            await walkDir(fullPath);
          }
        } else if (entry.isFile()) {
          if (this.shouldExclude(fullPath, gitignoreSpec)) {
            continue;
          }

          const ext = path.extname(entry.name).toLowerCase();
          if (!this.textExtensions.has(ext)) {
            continue;
          }

          try {
            const relativePath = path.relative(this.projectRoot, fullPath).replace(/\\/g, '/');
            if (relativePath.startsWith('..')) {
              continue;
            }

            const content = await readFileWithEncoding(fullPath);
            const fileBlobs = this.splitFileContent(relativePath, content);
            blobs.push(...fileBlobs);
          } catch (error) {
            // 静默处理读取失败
          }
        }
      }
    };

    await walkDir(this.projectRoot);
    return blobs;
  }

  /**
   * 使用指数退避策略重试请求
   */
  private async retryRequest<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    retryDelay: number = 1000
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const axiosError = error as { code?: string; response?: { status: number; data?: unknown } };

        // Token 失效检测 - 不重试，直接抛出友好错误
        if (axiosError.response?.status === 401) {
          sendLog('error', '🔑 Token 已失效或无效，请检查配置');
          throw new Error('Token 已失效或无效，请在 VSCode 设置中更新 token');
        }

        // 权限被拒绝 - 可能被官方制裁
        if (axiosError.response?.status === 403) {
          sendLog('error', '🚫 访问被拒绝，Token 可能已被禁用');
          throw new Error('访问被拒绝，Token 可能已被官方禁用，请联系服务提供商');
        }

        // SSL 证书错误检测 - 不重试
        if (axiosError.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
            axiosError.code === 'CERT_HAS_EXPIRED' ||
            axiosError.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
            lastError.message.includes('certificate') ||
            lastError.message.includes('altnames')) {
          sendLog('error', '🔐 SSL 证书验证失败，请检查 baseUrl 配置是否正确');
          throw new Error('SSL 证书验证失败，请检查 baseUrl 配置是否正确，或联系服务提供商');
        }

        const isRetryable =
          axiosError.code === 'ECONNREFUSED' ||
          axiosError.code === 'ETIMEDOUT' ||
          axiosError.code === 'ENOTFOUND' ||
          (axiosError.response && axiosError.response.status >= 500);

        if (!isRetryable || attempt === maxRetries - 1) {
          // 提供更友好的网络错误提示
          let friendlyMessage = lastError.message;
          if (axiosError.code === 'ECONNREFUSED') {
            friendlyMessage = '无法连接到服务器，请检查网络或服务地址';
          } else if (axiosError.code === 'ETIMEDOUT') {
            friendlyMessage = '连接超时，请检查网络状况';
          } else if (axiosError.code === 'ENOTFOUND') {
            friendlyMessage = '无法解析服务器地址，请检查 baseUrl 配置';
          }
          sendLog('error', `❌ 请求失败 (${attempt + 1}次尝试): ${friendlyMessage}`);
          throw new Error(friendlyMessage);
        }

        const waitTime = retryDelay * Math.pow(2, attempt);
        sendLog('warning', `⚠️ 请求失败 (${attempt + 1}/${maxRetries})，${waitTime}ms 后重试...`);
        await sleep(waitTime);
      }
    }

    throw lastError || new Error('All retries failed');
  }

  async indexFile(filePath: string, reporter?: IndexProgressReporter): Promise<IndexResult> {
    const relativePath = this.toRelativePath(filePath);
    if (!relativePath) {
      return { status: 'skipped', message: 'File is outside project root' };
    }

    const gitignoreSpec = this.loadGitignore();
    if (this.shouldExclude(filePath, gitignoreSpec)) {
      return this.removeFileFromIndex(relativePath, reporter, 'File excluded from index');
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!this.textExtensions.has(ext)) {
      return this.removeFileFromIndex(relativePath, reporter, 'File extension not indexed');
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return this.removeFileFromIndex(relativePath, reporter, 'File not found');
    }

    this.reportProgress(reporter, {
      stage: 'hashing',
      message: 'Indexing file...',
      percent: 20
    });

    const content = await readFileWithEncoding(filePath);
    const fileBlobs = this.splitFileContent(relativePath, content);

    const blobHashMap = new Map<string, Blob>();
    const nextHashes: string[] = [];
    for (const blob of fileBlobs) {
      const blobHash = calculateBlobName(blob.path, blob.content);
      blobHashMap.set(blobHash, blob);
      nextHashes.push(blobHash);
    }

    const store = this.loadIndexStore();
    const previousHashes = store.file_map[relativePath] || [];
    const isSame =
      previousHashes.length === nextHashes.length &&
      previousHashes.every((hash, idx) => hash === nextHashes[idx]);

    if (isSame) {
      return { status: 'success', message: 'No changes detected' };
    }

    const existingBlobNames = new Set(store.blob_names);
    const hashesToUpload = nextHashes.filter((hash) => !existingBlobNames.has(hash));
    const blobsToUpload = hashesToUpload.map((hash) => blobHashMap.get(hash)!).filter(Boolean);

    if (blobsToUpload.length > 0) {
      this.reportProgress(reporter, {
        stage: 'uploading',
        message: `Uploading ${blobsToUpload.length} new blobs...`,
        percent: 50
      });

      const totalBatches = Math.ceil(blobsToUpload.length / this.batchSize);
      const failedBatches: number[] = [];

      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        const startIdx = batchIdx * this.batchSize;
        const endIdx = Math.min(startIdx + this.batchSize, blobsToUpload.length);
        const batchBlobs = blobsToUpload.slice(startIdx, endIdx);
        const expectedBatchNames = hashesToUpload.slice(startIdx, endIdx);

        try {
          const result = await this.retryRequest(async () => {
            const response = await this.httpClient.post(`${this.baseUrl}/batch-upload`, {
              blobs: batchBlobs,
            });
            return response.data;
          });

          const batchBlobNames = result.blob_names || [];
          if (batchBlobNames.length === 0) {
            failedBatches.push(batchIdx + 1);
            continue;
          }

          const expectedSet = new Set(expectedBatchNames);
          const returnedSet = new Set(batchBlobNames);
          if (expectedSet.size !== returnedSet.size) {
            throw new Error('Blob hash mismatch between local and server');
          }
          for (const hash of expectedSet) {
            if (!returnedSet.has(hash)) {
              throw new Error('Blob hash mismatch between local and server');
            }
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          sendLog('error', `Batch ${batchIdx + 1} upload failed: ${errorMessage}`);
          failedBatches.push(batchIdx + 1);
        }
      }

      if (failedBatches.length > 0) {
        this.reportProgress(reporter, {
          stage: 'error',
          message: 'File indexing failed',
          percent: 100
        });
        return { status: 'error', message: 'File indexing failed' };
      }
    }

    const nextFileMap = { ...store.file_map, [relativePath]: nextHashes };
    const nextStore: IndexStore = {
      version: 1,
      blob_names: this.collectBlobNames(nextFileMap),
      file_map: nextFileMap
    };
    this.saveIndexStore(nextStore);

    this.reportProgress(reporter, {
      stage: 'complete',
      message: 'File index updated',
      percent: 100
    });

    return { status: 'success', message: `Indexed file ${relativePath}` };
  }

  /**
   * 对项目进行索引（支持增量索引）
   */
  async indexProject(reporter?: IndexProgressReporter): Promise<IndexResult> {
    sendLog('info', `Indexing project: ${this.projectRoot}`);

    try {

      const blobs = await this.collectFiles();

      if (blobs.length === 0) {
        this.reportProgress(reporter, {
          stage: 'error',
          message: 'No text files found in project',
          percent: 100
        });
        return { status: 'error', message: 'No text files found in project' };
      }

      this.reportProgress(reporter, {
        stage: 'hashing',
        message: 'Computing hashes...',
        percent: 25
      });

      const store = this.loadIndexStore();
      const existingBlobNames = new Set(store.blob_names);
      const blobHashMap = new Map<string, Blob>();
      const nextFileMap: Record<string, string[]> = {};

      for (const blob of blobs) {
        const blobHash = calculateBlobName(blob.path, blob.content);
        blobHashMap.set(blobHash, blob);
        if (!nextFileMap[blob.sourcePath]) {
          nextFileMap[blob.sourcePath] = [];
        }
        nextFileMap[blob.sourcePath].push(blobHash);
      }

      const allBlobHashes = new Set(blobHashMap.keys());
      const existingHashes = new Set(
        [...allBlobHashes].filter((hash) => existingBlobNames.has(hash))
      );
      const newHashes = [...allBlobHashes].filter((hash) => !existingBlobNames.has(hash));
      const blobsToUpload = newHashes.map((hash) => blobHashMap.get(hash)!);

      this.reportProgress(reporter, {
        stage: 'uploading',
        message: `Uploading ${blobsToUpload.length} new blobs...`,
        percent: 50
      });

      const uploadedBlobNames: string[] = [];
      const failedBatches: number[] = [];

      if (blobsToUpload.length > 0) {
        const totalBatches = Math.ceil(blobsToUpload.length / this.batchSize);

        for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
          const startIdx = batchIdx * this.batchSize;
          const endIdx = Math.min(startIdx + this.batchSize, blobsToUpload.length);
          const batchBlobs = blobsToUpload.slice(startIdx, endIdx);
          const expectedBatchNames = newHashes.slice(startIdx, endIdx);

          try {
            const result = await this.retryRequest(async () => {
              const response = await this.httpClient.post(`${this.baseUrl}/batch-upload`, {
                blobs: batchBlobs,
              });
              return response.data;
            });

            const batchBlobNames = result.blob_names || [];
            if (batchBlobNames.length === 0) {
              failedBatches.push(batchIdx + 1);
              continue;
            }

            const expectedSet = new Set(expectedBatchNames);
            const returnedSet = new Set(batchBlobNames);
            if (expectedSet.size !== returnedSet.size) {
              throw new Error('Blob hash mismatch between local and server');
            }
            for (const hash of expectedSet) {
              if (!returnedSet.has(hash)) {
                throw new Error('Blob hash mismatch between local and server');
              }
            }

            uploadedBlobNames.push(...batchBlobNames);
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            sendLog('error', `Batch ${batchIdx + 1} upload failed: ${errorMessage}`);
            failedBatches.push(batchIdx + 1);
          }
        }

        if (uploadedBlobNames.length === 0 && existingHashes.size === 0) {
          this.reportProgress(reporter, {
            stage: 'error',
            message: 'All batches failed on first indexing',
            percent: 100
          });
          return { status: 'error', message: 'All batches failed on first indexing' };
        }
      }

      const availableBlobNames = new Set<string>([...existingHashes, ...uploadedBlobNames]);
      const filteredFileMap: Record<string, string[]> = {};

      for (const filePath of Object.keys(nextFileMap)) {
        const hashes = nextFileMap[filePath].filter((hash) => availableBlobNames.has(hash));
        if (hashes.length > 0) {
          filteredFileMap[filePath] = hashes;
        }
      }

      this.reportProgress(reporter, {
        stage: 'saving',
        message: 'Saving index...',
        percent: 90
      });

      const nextStore: IndexStore = {
        version: 1,
        blob_names: [...availableBlobNames],
        file_map: filteredFileMap
      };
      this.saveIndexStore(nextStore);

      this.reportProgress(reporter, {
        stage: 'complete',
        message: 'Index complete',
        percent: 100
      });

      const message = `Indexed ${availableBlobNames.size} blobs (existing: ${existingHashes.size}, new: ${uploadedBlobNames.length})`;

      return {
        status: failedBatches.length === 0 ? 'success' : 'partial_success',
        message,
        stats: {
          total_blobs: availableBlobNames.size,
          existing_blobs: existingHashes.size,
          new_blobs: uploadedBlobNames.length,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.reportProgress(reporter, {
        stage: 'error',
        message: errorMessage,
        percent: 100
      });
      sendLog('error', `Index project failed: ${errorMessage}`);
      return { status: 'error', message: errorMessage };
    }
  }

  /**
   * 仅执行提示词增强（不进行代码搜索）
   */
  async enhancePrompt(query: string, options: SearchOptions = {}): Promise<string> {
    const reporter = options.reporter;

    try {
      let blobNames = this.getBlobNames();
      if (blobNames.length === 0) {
        const indexResult = await this.indexProject(reporter);
        if (indexResult.status === 'error') {
          sendLog('error', `Index failed: ${indexResult.message}`);
          throw new Error(`Failed to index project. ${indexResult.message}`);
        }
        blobNames = this.getBlobNames();
      }

      if (blobNames.length === 0) {
        sendLog('error', 'Index is empty');
        throw new Error('No blobs found after indexing.');
      }

      this.reportProgress(reporter, {
        stage: 'enhancing',
        message: 'Enhancing query...',
        percent: 50
      });

      const enhancedQuery = await this.requestEnhancedQuery(query, blobNames);

      this.reportProgress(reporter, {
        stage: 'complete',
        message: 'Enhancement complete',
        percent: 100
      });

      return enhancedQuery;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.reportProgress(reporter, {
        stage: 'error',
        message: errorMessage,
        percent: 100
      });
      sendLog('error', `Prompt enhancement failed: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * 仅执行代码搜索（不进行提示词增强）
   */
  async searchCodebase(query: string, options: SearchOptions = {}): Promise<string> {
    const reporter = options.reporter;

    try {
      let blobNames = this.getBlobNames();
      if (blobNames.length === 0) {
        const indexResult = await this.indexProject(reporter);
        if (indexResult.status === 'error') {
          sendLog('error', `Index failed: ${indexResult.message}`);
          return `Error: Failed to index project. ${indexResult.message}`;
        }
        blobNames = this.getBlobNames();
      }

      if (blobNames.length === 0) {
        sendLog('error', 'Index is empty');
        return 'Error: No blobs found after indexing.';
      }

      this.reportProgress(reporter, {
        stage: 'searching',
        message: 'Searching codebase...',
        percent: 50
      });

      const payload = {
        information_request: query,
        blobs: {
          checkpoint_id: null,
          added_blobs: blobNames,
          deleted_blobs: [],
        },
        dialog: [],
        max_output_length: 0,
        disable_codebase_retrieval: false,
        enable_commit_retrieval: false,
      };

      const result = await this.retryRequest(async () => {
        const response = await this.httpClient.post(
          `${this.baseUrl}/agents/codebase-retrieval`,
          payload,
          { timeout: 60000 }
        );
        return response.data;
      }, 3, 2000);

      const formattedRetrieval = result.formatted_retrieval || '';

      if (!formattedRetrieval) {
        sendLog('info', 'No relevant code context found');
        return 'No relevant code context found for your query.';
      }

      this.reportProgress(reporter, {
        stage: 'complete',
        message: 'Search complete',
        percent: 100
      });

      return formattedRetrieval;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.reportProgress(reporter, {
        stage: 'error',
        message: errorMessage,
        percent: 100
      });
      sendLog('error', `Search failed: ${errorMessage}`);
      return `Error: ${errorMessage}`;
    }
  }

  /**
   * 请求增强的查询（内部方法）
   */
  /**
   * 生成 UUID v4（用于请求 ID 和会话 ID）
   */
  private generateUUID(): string {
    return crypto.randomUUID();
  }

  /**
   * 获取工作区信息用于构建 IDE 状态节点
   * 完全模拟 curl.txt 中的 ide_state_node 结构
   */
  private getWorkspaceInfo(): {
    workspace_folders: Array<{ folder_root: string; repository_root: string }>;
    workspace_folders_unchanged: boolean;
    current_terminal: { terminal_id: number; current_working_directory: string };
  } {
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const projectRoot = this.projectRoot;

    return {
      workspace_folders: workspaceFolders.map((folder) => ({
        folder_root: folder.uri.fsPath,
        repository_root: folder.uri.fsPath
      })),
      workspace_folders_unchanged: false,
      current_terminal: {
        terminal_id: 0,
        current_working_directory: projectRoot
      }
    };
  }

  /**
   * 获取当前编辑器的上下文信息
   * @returns 编辑器上下文对象，如果没有活动编辑器则返回 null
   */
  private getCurrentEditorContext(): EditorContext | null {
    // 获取当前活动的编辑器
    const activeEditor = vscode.window.activeTextEditor;
    
    // 边界条件：没有打开任何文件
    if (!activeEditor) {
      sendLog('info', '没有活动的编辑器');
      return null;
    }

    const document = activeEditor.document;
    const selection = activeEditor.selection;
    
    // 获取文件的完整文本内容
    const fullText = document.getText();
    
    // 获取文件路径信息
    const absolutePath = document.uri.fsPath;
    const fileName = path.basename(absolutePath);
    
    // 计算相对路径
    let relativePath = absolutePath;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let workspaceName = 'Unknown';
    
    if (workspaceFolders && workspaceFolders.length > 0) {
      const workspaceFolder = workspaceFolders[0];
      relativePath = vscode.workspace.asRelativePath(absolutePath);
      workspaceName = path.basename(workspaceFolder.uri.fsPath);
    }
    
    // 检查是否有选中内容
    const hasSelection = !selection.isEmpty;
    
    let prefix = '';
    let selectedCode = '';
    let suffix = '';
    
    if (hasSelection) {
      // 有选中内容的情况
      // 获取选中的文本
      selectedCode = document.getText(selection);
      
      // 获取 prefix：从文件开头到选中区域起始位置
      const prefixRange = new vscode.Range(
        new vscode.Position(0, 0),
        selection.start
      );
      prefix = document.getText(prefixRange);
      
      // 获取 suffix：从选中区域结束位置到文件末尾
      const lastLine = document.lineCount - 1;
      const lastChar = document.lineAt(lastLine).text.length;
      const suffixRange = new vscode.Range(
        selection.end,
        new vscode.Position(lastLine, lastChar)
      );
      suffix = document.getText(suffixRange);
    } else {
      // 没有选中内容的情况：使用当前光标位置
      const cursorPosition = selection.active;
      
      // prefix：从文件开头到光标位置
      const prefixRange = new vscode.Range(
        new vscode.Position(0, 0),
        cursorPosition
      );
      prefix = document.getText(prefixRange);
      
      // suffix：从光标位置到文件末尾
      const lastLine = document.lineCount - 1;
      const lastChar = document.lineAt(lastLine).text.length;
      const suffixRange = new vscode.Range(
        cursorPosition,
        new vscode.Position(lastLine, lastChar)
      );
      suffix = document.getText(suffixRange);
      
      // selectedCode 为空字符串
      selectedCode = '';
    }
    
    // 获取编程语言标识符
    const languageId = document.languageId;
    
    return {
      filePath: relativePath,
      fileName: fileName,
      absolutePath: absolutePath,
      languageId: languageId,
      prefix: prefix,
      selectedCode: selectedCode,
      suffix: suffix,
      workspaceName: workspaceName,
      hasSelection: hasSelection
    };
  }

  /**
   * 处理流式响应，提取增强后的提示词
   * 响应格式为 JSONL（每行一个 JSON 对象），需要逐行解析
   */
  private async processStreamResponse(response: AxiosResponse): Promise<string> {
    const stream = response.data;
    let accumulatedText = ''; // 累积所有 text 字段
    let lastNodes: any[] = []; // 保存最后的 nodes 数组

    return new Promise((resolve, reject) => {
      // 如果响应是字符串（非流式），直接处理
      if (typeof stream === 'string') {
        this.extractEnhancedPromptFromText(stream, resolve, reject);
        return;
      }

      // 处理流式响应（Node.js Stream）
      let buffer = '';

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        
        // 按行分割，处理完整的 JSON 行
        const lines = buffer.split('\n');
        // 保留最后一个不完整的行在 buffer 中
        buffer = lines.pop() || '';

        // 处理每一行 JSON
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;

          try {
            const jsonObj = JSON.parse(trimmedLine);
            
            // 累积 text 字段
            if (jsonObj.text) {
              accumulatedText += jsonObj.text;
            }

            // 保存 nodes 数组（最后的 nodes 包含完整内容）
            if (jsonObj.nodes && Array.isArray(jsonObj.nodes) && jsonObj.nodes.length > 0) {
              lastNodes = jsonObj.nodes;
            }

            // 如果已经找到完整的增强提示词，可以提前结束
            if (accumulatedText.includes('</augment-enhanced-prompt>')) {
              const match = accumulatedText.match(/<augment-enhanced-prompt>([\s\S]*?)<\/augment-enhanced-prompt>/);
              if (match && match[1] && match[1].trim()) {
                stream.destroy();
                resolve(match[1].trim());
                return;
              }
            }
          } catch (error) {
            // 忽略 JSON 解析错误（可能是部分数据）
            continue;
          }
        }
      });

      stream.on('end', () => {
        // 处理 buffer 中剩余的数据
        if (buffer.trim()) {
          try {
            const jsonObj = JSON.parse(buffer.trim());
            if (jsonObj.text) {
              accumulatedText += jsonObj.text;
            }
            if (jsonObj.nodes && Array.isArray(jsonObj.nodes) && jsonObj.nodes.length > 0) {
              lastNodes = jsonObj.nodes;
            }
          } catch (error) {
            // 忽略解析错误
          }
        }

        // 优先从 nodes 数组中提取完整内容（更可靠）
        if (lastNodes.length > 0) {
          for (const node of lastNodes) {
            if (node.type === 0 && node.content) {
              // type 0 是文本节点，包含完整响应
              const match = node.content.match(/<augment-enhanced-prompt>([\s\S]*?)<\/augment-enhanced-prompt>/);
              if (match && match[1] && match[1].trim()) {
                resolve(match[1].trim());
                return;
              }
            }
          }
        }

        // 如果 nodes 中没有找到，从累积的文本中提取
        this.extractEnhancedPromptFromText(accumulatedText, resolve, reject);
      });

      stream.on('error', (error: Error) => {
        reject(new Error(`流式响应错误: ${error.message}`));
      });
    });
  }

  /**
   * 从响应文本内容中提取增强后的提示词
   */
  private extractEnhancedPromptFromText(
    content: string,
    resolve: (value: string) => void,
    reject: (reason: Error) => void
  ): void {
    // 首先尝试查找 <augment-enhanced-prompt> 标签
    let match = content.match(/<augment-enhanced-prompt>([\s\S]*?)<\/augment-enhanced-prompt>/);
    if (match && match[1]) {
      const enhancedPrompt = match[1].trim();
      if (enhancedPrompt) {
        resolve(enhancedPrompt);
        return;
      }
    }

    // 如果没有找到标签，尝试查找 "BEGIN RESPONSE" 和 "END RESPONSE" 之间的内容
    match = content.match(/### BEGIN RESPONSE ###([\s\S]*?)### END RESPONSE ###/);
    if (match && match[1]) {
      const responseContent = match[1].trim();
      // 在响应内容中再次查找标签
      const tagMatch = responseContent.match(/<augment-enhanced-prompt>([\s\S]*?)<\/augment-enhanced-prompt>/);
      if (tagMatch && tagMatch[1]) {
        const enhancedPrompt = tagMatch[1].trim();
        if (enhancedPrompt) {
          resolve(enhancedPrompt);
          return;
        }
      } else {
        // 如果没有标签，使用整个响应内容
        if (responseContent) {
          resolve(responseContent);
          return;
        }
      }
    }

    // 如果都没有找到，返回错误
    reject(new Error('无法从响应中提取增强后的提示词。响应内容：' + content.substring(0, 500)));
  }

  /**
   * 请求增强后的提示词（使用 /chat-stream 端点）
   * 完全模拟 curl.txt 中的请求结构，包括所有必需的参数和请求头
   * 
   * @param query 原始提示词
   * @param blobNames 代码库的 blob 名称列表
   * @returns 增强后的提示词
   */
  private async requestEnhancedQuery(query: string, blobNames: string[]): Promise<string> {
    // 生成请求 ID 和会话 ID
    const requestId = this.generateUUID();
    const sessionId = this.generateUUID();

    // 获取工作区信息
    const ideState = this.getWorkspaceInfo();

    // 构建提示词增强的指令文本节点
    const enhancementInstruction = `⚠️ NO TOOLS ALLOWED ⚠️

Here is an instruction that I'd like to give you, but it needs to be improved. Rewrite and enhance this instruction to make it clearer, more specific, less ambiguous, and correct any mistakes. Do not use any tools: reply immediately with your answer, even if you're not sure. Consider the context of our conversation history when enhancing the prompt. If there is code in triple backticks (\`\`\`) consider whether it is a code sample and should remain unchanged.

Reply with the following format:

### BEGIN RESPONSE ###
Here is an enhanced version of the original instruction that is more specific and clear:
<augment-enhanced-prompt>enhanced prompt goes here</augment-enhanced-prompt>

### END RESPONSE ###

Here is my original instruction:

${query}`;

    // 构建完整的请求体，完全模拟 curl.txt 中的结构
    // 获取当前编辑器的上下文信息
    const editorContext = this.getCurrentEditorContext();
    
    const payload = {
      model: null,
      path: editorContext?.filePath || null,
      prefix: editorContext?.prefix || null,
      selected_code: editorContext?.selectedCode || null,
      suffix: editorContext?.suffix || null,
      message: '',
      chat_history: [],
      lang: editorContext?.languageId || null,
      blobs: {
        checkpoint_id: null,
        added_blobs: blobNames,
        deleted_blobs: []
      },
      user_guided_blobs: [],
      context_code_exchange_request_id: null,
      external_source_ids: [],
      disable_auto_external_sources: null,
      user_guidelines: this.userGuidelines,
      workspace_guidelines: '',
      feature_detection_flags: {
        support_tool_use_start: true,
        support_parallel_tool_use: true
      },
      tool_definitions: [],
      nodes: [
        {
          id: 1,
          type: 0, // 文本节点类型
          text_node: {
            content: enhancementInstruction
          }
        },
        {
          id: 2,
          type: 4, // IDE 状态节点类型
          ide_state_node: ideState
        }
      ],
      mode: 'AGENT',
      agent_memories: '',
      persona_type: 0,
      rules: [],
      silent: true,
      third_party_override: null,
      conversation_id: '__NEW_AGENT__'
    };

    try {
      const result = await this.retryRequest(async () => {
        // 使用流式响应配置
        const response = await this.httpClient.post(
          `${this.baseUrl}/chat-stream`,
          payload,
          {
            timeout: 120000, // 增加超时时间，因为流式响应可能需要更长时间
            headers: {
              'Content-Type': 'application/json',
              'x-request-id': requestId,
              'x-request-session-id': sessionId,
              'Accept': 'text/event-stream',
              'Cache-Control': 'no-cache'
            },
            responseType: 'stream' // 设置为流式响应
          }
        );
        return response;
      }, 3, 2000);

      // 处理流式响应
      const enhancedQuery = await this.processStreamResponse(result);

      if (!enhancedQuery) {
        throw new Error('Enhanced query was empty');
      }

      return enhancedQuery;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sendLog('error', `提示词增强请求失败: ${errorMessage}`);
      throw error;
    }
  }


}


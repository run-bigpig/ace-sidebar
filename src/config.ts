/**
 * 配置模块 - 从 VSCode 配置读取配置
 */

export interface Config {
  baseUrl: string;
  token: string;
  batchSize: number;
  maxLinesPerBlob: number;
  textExtensions: Set<string>;
  excludePatterns: string[];
  enableLog: boolean;
  userGuidelines?: string;
}


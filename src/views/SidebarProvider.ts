/**
 * 侧边栏视图提供者
 */

import * as vscode from 'vscode';

/**
 * 侧边栏树节点
 */
export class SidebarItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly iconPath?: vscode.ThemeIcon
  ) {
    super(label, collapsibleState);
    this.tooltip = label;
    this.contextValue = 'aceSidebarItem';
  }
}

/**
 * 侧边栏数据提供者
 */
export class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SidebarItem | undefined | null | void> = new vscode.EventEmitter<SidebarItem | undefined | null | void>();
  private isConfigured: boolean = false;
  readonly onDidChangeTreeData: vscode.Event<SidebarItem | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setConfigured(value: boolean): void {
    this.isConfigured = value;
    this.refresh();
  }

  getTreeItem(element: SidebarItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SidebarItem): Thenable<SidebarItem[]> {
    // 移除所有菜单项，点击图标直接进入 chat 界面
    return Promise.resolve([]);
  }

}


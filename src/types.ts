import * as vscode from 'vscode';

export interface JJChangeInfo {
  changeId: string;
  shortestLen: number;
  commitId: string;
  description: string;
  bookmarks: string[];
  remoteBookmarks: string[];
  isConflict: boolean;
  isDivergent?: boolean;
  workingCopies: string[];
  parentIds: string[];
  empty: boolean;
}

export interface JJDiffFile {
  status: 'M' | 'A' | 'D' | 'R' | string;
  path: string;
  oldPath?: string;
}

export interface RemoteSyncStatus {
  ahead: number;
  behind: number;
  bookmark: string;
  remote: string;
}

export interface JJWorkspace {
  name: string;
  changeId: string;
  commitId: string;
  isDefault: boolean;
}

export interface JJConflictEntry {
  path: string;
  details: string;
  isDeletion: boolean;
}

export interface JJRemoteInfo {
  name: string;
  url: string;
}

export interface JJResourceState extends vscode.SourceControlResourceState {
  fromRev: string;
  intoRev: string;
  relativePath: string;
  oldRelativePath?: string;
}

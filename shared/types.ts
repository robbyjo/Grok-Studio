export type Wire = Record<string, any>; // ACP payloads include versioned, vendor-defined fields.
export type Status = 'idle' | 'connecting' | 'running' | 'approval' | 'error' | 'interrupted';
export interface Project {
  id: string;
  name: string;
  path: string;
  hidden?: boolean;
  pinned?: boolean;
  group?: string;
  order?: number;
  actions?: ProjectAction[];
}
export interface ProjectAction {
  id: string;
  name: string;
  command: string;
  args: string[];
  directory: string;
  setup: boolean;
}
export interface SearchHit {
  threadId: string;
  entryId?: string;
  title: string;
  projectName: string;
  archived: boolean;
  hidden: boolean;
  kind: Entry['type'] | 'chat';
  before: string;
  match: string;
  after: string;
}
export interface SearchResults {
  hits: SearchHit[];
  truncated: boolean;
  nextOffset?: number;
}
export interface Entry {
  id: string;
  type: 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'notice';
  text: string;
  data?: Wire;
  turn?: string;
}
export interface Thread {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  sessionId?: string;
  status: Status;
  archived: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  entries: Entry[];
  session?: Wire;
  error?: string;
  entryCount?: number;
  historyStart?: number;
  usage?: Wire;
  runtimeStatus?: Wire;
  tasks?: Wire[];
  subagents?: Wire[];
  queue?: Array<{ id: string; text: string; state: 'queued' | 'paused' }>;
  reviewComments?: Array<{
    id: string;
    path: string;
    line: number;
    side: string;
    body: string;
    revision: string;
    staged: boolean;
  }>;
}
export interface Settings {
  executable: string;
  authMode?: 'auto' | 'oauth' | 'api';
  storageMiB?: number;
  notifications?: boolean;
  shortcuts?: Record<string, string>;
}
export interface State {
  version: 1;
  projects: Project[];
  threads: Thread[];
  settings: Settings;
  pagination?: { limit: number; total: number; hasMore: boolean };
  recoveryNotice?: string;
  worktrees?: Array<{ id: string; repo: string; path: string; archived: boolean; ref?: string }>;
}
export interface Permission {
  id: string;
  threadId: string;
  toolCall: Wire;
  options: Wire[];
  kind?: 'trust';
}
export interface Attachment {
  id?: string;
  url?: string;
  name: string;
  uri: string;
  text: string;
  mimeType?: string;
  data?: string;
}
export interface FileItem {
  name: string;
  path: string;
  directory: boolean;
}
export interface GitState {
  branch: string;
  status: string;
  diff: string;
  staged: string;
  worktrees: string;
  files: GitChange[];
  indexRevision: string;
}
export interface GitChange {
  path: string;
  originalPath?: string;
  index: string;
  worktree: string;
  conflicted: boolean;
}
export interface TextDocument {
  text: string;
  revision: string;
}
export type DesktopEvent =
  | { type: 'account'; status: Wire }
  | { type: 'state'; state: State }
  | { type: 'permission'; permission: Permission }
  | { type: 'permission-closed'; id: string }
  | { type: 'terminal'; id: string; data: string; seq: number }
  | { type: 'terminal-exit'; id: string; code: number }
  | { type: 'focus-chat'; id: string }
  | { type: 'attention'; id: string; kind: 'complete' | 'failure' };
export interface DesktopAPI {
  call<T = any>(method: string, args?: Wire): Promise<T>;
  onEvent(callback: (event: DesktopEvent) => void): () => void;
}
declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}

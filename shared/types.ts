export type Wire = Record<string, any>; // ACP payloads include versioned, vendor-defined fields.
export type Status = 'idle' | 'connecting' | 'running' | 'approval' | 'error' | 'interrupted';
export interface Project {
  id: string;
  name: string;
  path: string;
  hidden?: boolean;
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
}
export interface Settings {
  executable: string;
}
export interface State {
  version: 1;
  projects: Project[];
  threads: Thread[];
  settings: Settings;
}
export interface Permission {
  id: string;
  threadId: string;
  toolCall: Wire;
  options: Wire[];
  kind?: 'trust';
}
export interface Attachment {
  name: string;
  uri: string;
  text: string;
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
  | { type: 'state'; state: State }
  | { type: 'permission'; permission: Permission }
  | { type: 'permission-closed'; id: string }
  | { type: 'terminal'; id: string; data: string; seq: number }
  | { type: 'terminal-exit'; id: string; code: number };
export interface DesktopAPI {
  call<T = any>(method: string, args?: Wire): Promise<T>;
  onEvent(callback: (event: DesktopEvent) => void): () => void;
}
declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}

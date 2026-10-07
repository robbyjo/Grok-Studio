import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, DesktopEvent } from '../shared/types';
const methods = new Set([
  'state',
  'runtime:info',
  'mcp:list',
  'mcp:add',
  'mcp:change',
  'mcp:doctor',
  'project:add',
  'thread:new',
  'thread:edit',
  'agent:connect',
  'agent:prompt',
  'agent:cancel',
  'agent:disconnect',
  'agent:config',
  'agent:authenticate',
  'permissions',
  'permission:answer',
  'settings:save',
  'settings:executable',
  'files:list',
  'files:read',
  'files:open',
  'files:save',
  'editor:dirty',
  'attachments:pick',
  'git:state',
  'git:diff',
  'git:update',
  'git:commit',
  'git:worktree',
  'terminal:open',
  'terminal:write',
  'terminal:resize',
  'terminal:close',
  'external:open',
  'workspace:reveal',
]);
const api: DesktopAPI = {
  call: (method, args = {}) => {
    if (!methods.has(method)) return Promise.reject(new Error('Unknown desktop operation.'));
    return ipcRenderer.invoke('desktop:call', method, args);
  },
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: DesktopEvent) => callback(event);
    ipcRenderer.on('desktop:event', listener);
    return () => ipcRenderer.removeListener('desktop:event', listener);
  },
};
contextBridge.exposeInMainWorld('desktop', api);

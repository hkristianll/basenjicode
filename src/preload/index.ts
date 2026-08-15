import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type Api, type AgentEvent, type BgTask, type LoopEvent, type PreviewControl, type WakeEvent } from '../shared/ipc-types'

const api: Api = {
  agent: {
    startTurn: (p) => ipcRenderer.invoke(IPC.agentStartTurn, p),
    cancel: (turnId) => ipcRenderer.invoke(IPC.agentCancel, turnId),
    decide: (p) => ipcRenderer.invoke(IPC.agentDecide, p),
    setMode: (p) => ipcRenderer.invoke(IPC.agentSetMode, p),
    setEffort: (p) => ipcRenderer.invoke(IPC.agentSetEffort, p),
    clearApprovals: (sessionId) => ipcRenderer.invoke(IPC.agentClearApprovals, sessionId),
    undoTurn: (p) => ipcRenderer.invoke(IPC.agentUndoTurn, p),
    rewindPlan: (p) => ipcRenderer.invoke(IPC.agentRewindPlan, p),
    rewindExecute: (p) => ipcRenderer.invoke(IPC.agentRewindExecute, p),
    onEvent: (cb: (e: AgentEvent) => void) => {
      const listener = (_e: unknown, ev: AgentEvent): void => cb(ev)
      ipcRenderer.on(IPC.agentEvent, listener)
      return () => ipcRenderer.removeListener(IPC.agentEvent, listener)
    }
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessionList),
    load: (id) => ipcRenderer.invoke(IPC.sessionLoad, id),
    create: (cwd) => ipcRenderer.invoke(IPC.sessionCreate, cwd),
    remove: (id) => ipcRenderer.invoke(IPC.sessionRemove, id),
    search: (query) => ipcRenderer.invoke(IPC.sessionSearch, query),
    setComposer: (p) => ipcRenderer.invoke(IPC.sessionSetComposer, p)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  update: {
    status: () => ipcRenderer.invoke(IPC.updateStatus),
    install: () => ipcRenderer.invoke(IPC.updateInstall)
  },
  mcp: {
    status: () => ipcRenderer.invoke(IPC.mcpStatus)
  },
  lmstudio: {
    probe: (p) => ipcRenderer.invoke(IPC.lmstudioProbe, p),
    models: (p) => ipcRenderer.invoke(IPC.lmstudioModels, p),
    profileDescribe: (model) => ipcRenderer.invoke(IPC.modelProfileDescribe, model)
  },
  voice: {
    probe: () => ipcRenderer.invoke(IPC.voiceProbe),
    transcribe: (p) => ipcRenderer.invoke(IPC.voiceTranscribe, p),
    speak: (p) => ipcRenderer.invoke(IPC.voiceSpeak, p),
    setWake: (enabled) => ipcRenderer.invoke(IPC.voiceSetWake, enabled),
    onWakeEvent: (cb: (e: WakeEvent) => void) => {
      const listener = (_e: unknown, ev: WakeEvent): void => cb(ev)
      ipcRenderer.on(IPC.voiceWakeEvent, listener)
      return () => ipcRenderer.removeListener(IPC.voiceWakeEvent, listener)
    }
  },
  dialog: {
    pickDirectory: () => ipcRenderer.invoke(IPC.dialogPickDirectory),
    pickFiles: (p) => ipcRenderer.invoke(IPC.dialogPickFiles, p)
  },
  workspace: {
    listFiles: (p) => ipcRenderer.invoke(IPC.workspaceListFiles, p),
    readFile: (p) => ipcRenderer.invoke(IPC.workspaceReadFile, p),
    savePlan: (p) => ipcRenderer.invoke(IPC.workspaceSavePlan, p),
    listPlans: (p) => ipcRenderer.invoke(IPC.workspaceListPlans, p)
  },
  bgtasks: {
    list: () => ipcRenderer.invoke(IPC.bgtaskList),
    stop: (id) => ipcRenderer.invoke(IPC.bgtaskStop, id),
    output: (id) => ipcRenderer.invoke(IPC.bgtaskOutput, id),
    onEvent: (cb: (tasks: BgTask[]) => void) => {
      const listener = (_e: unknown, tasks: BgTask[]): void => cb(tasks)
      ipcRenderer.on(IPC.bgtaskEvent, listener)
      return () => ipcRenderer.removeListener(IPC.bgtaskEvent, listener)
    }
  },
  git: {
    status: (sessionId) => ipcRenderer.invoke(IPC.gitStatus, sessionId),
    diff: (p) => ipcRenderer.invoke(IPC.gitDiff, p),
    commit: (p) => ipcRenderer.invoke(IPC.gitCommit, p)
  },
  ui: {
    setTitleBarOverlay: (p) => ipcRenderer.invoke(IPC.uiSetTitleBar, p)
  },
  preview: {
    onControl: (cb: (c: PreviewControl) => void) => {
      const listener = (_e: unknown, c: PreviewControl): void => cb(c)
      ipcRenderer.on(IPC.previewControl, listener)
      return () => ipcRenderer.removeListener(IPC.previewControl, listener)
    },
    register: (p) => ipcRenderer.send(IPC.previewRegister, p),
    closed: (webContentsId) => ipcRenderer.send(IPC.previewClosed, webContentsId)
  },
  loop: {
    orchestrate: (p) => ipcRenderer.invoke(IPC.loopOrchestrate, p),
    start: (config) => ipcRenderer.invoke(IPC.loopStart, config),
    pause: () => ipcRenderer.invoke(IPC.loopPause),
    resume: () => ipcRenderer.invoke(IPC.loopResume),
    stop: () => ipcRenderer.invoke(IPC.loopStop),
    status: () => ipcRenderer.invoke(IPC.loopStatus),
    diff: () => ipcRenderer.invoke(IPC.loopDiff),
    ticketAction: (p) => ipcRenderer.invoke(IPC.loopTicketAction, p),
    planDecision: (p) => ipcRenderer.invoke(IPC.loopPlanDecision, p),
    onEvent: (cb: (e: LoopEvent) => void) => {
      const listener = (_e: unknown, ev: LoopEvent): void => cb(ev)
      ipcRenderer.on(IPC.loopEvent, listener)
      return () => ipcRenderer.removeListener(IPC.loopEvent, listener)
    }
  },
  hermes: {
    message: (p) => ipcRenderer.invoke(IPC.hermesMessage, p),
    history: (project) => ipcRenderer.invoke(IPC.hermesHistory, project),
    cancel: () => ipcRenderer.invoke(IPC.hermesCancel),
    onEvent: (cb: (e: AgentEvent) => void) => {
      const listener = (_e: unknown, ev: AgentEvent): void => cb(ev)
      ipcRenderer.on(IPC.hermesEvent, listener)
      return () => ipcRenderer.removeListener(IPC.hermesEvent, listener)
    },
    teamMemory: (p) => ipcRenderer.invoke(IPC.hermesTeamMemoryGet, p),
    setTeamMemory: (p) => ipcRenderer.invoke(IPC.hermesTeamMemorySet, p)
  },
  loopBoard: {
    list: (project) => ipcRenderer.invoke(IPC.loopBoardList, project),
    projects: () => ipcRenderer.invoke(IPC.loopBoardProjects),
    folders: (names) => ipcRenderer.invoke(IPC.loopBoardFolders, names),
    comment: (id, text) => ipcRenderer.invoke(IPC.loopBoardComment, { id, text }),
    onChange: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.loopBoardChange, listener)
      return () => ipcRenderer.removeListener(IPC.loopBoardChange, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

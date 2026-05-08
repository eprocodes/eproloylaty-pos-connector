const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Agent window sizing
  expand:   () => ipcRenderer.send('agent-expand'),
  collapse: () => ipcRenderer.send('agent-collapse'),

  // Windows
  openSettings:  ()     => ipcRenderer.send('open-settings'),
  openPopup:     (data) => ipcRenderer.send('open-popup', data),
  closePopup:    ()     => ipcRenderer.send('close-popup'),
  quitApp:       ()     => ipcRenderer.send('quit-app'),

  // Popup results
  pointsSent:    (data) => ipcRenderer.send('points-sent', data),
  pointsSkipped: (data) => ipcRenderer.send('points-skipped', data),
  pointsFailed:  (data) => ipcRenderer.send('points-failed', data),

  // Settings + data persistence
  saveSettings:  (data) => ipcRenderer.invoke('save-settings', data),
  loadSettings:  ()     => ipcRenderer.invoke('load-settings'),
  loadStats:     ()     => ipcRenderer.invoke('load-stats'),
  loadTxns:      ()     => ipcRenderer.invoke('load-txns'),
  getDbPath:     ()      => ipcRenderer.invoke('get-db-path'),
  openDbFolder:  ()      => ipcRenderer.send('open-db-folder'),
  testDbConn:    (cfg)   => ipcRenderer.invoke('test-db-conn', cfg),
  loadDbSchema:  (cfg)   => ipcRenderer.invoke('load-db-schema', cfg),
  getLatestPosTxn: (cfg) => ipcRenderer.invoke('get-latest-pos-txn', cfg),

  // Live push
  sendStats:        (s)  => ipcRenderer.send('stats-update', s),
  sendFeedLog:      (e)  => ipcRenderer.send('feed-log', e),
  sendMonitorState: (on) => ipcRenderer.send('monitor-state', on),
  sendAgentState:   (on) => ipcRenderer.send('agent-state', on),

  // Listeners
  onSettingsLoaded: (cb) => ipcRenderer.on('settings-loaded', (_, d) => cb(d)),
  onStatsLoaded:    (cb) => ipcRenderer.on('stats-loaded',    (_, d) => cb(d)),
  onTxnsLoaded:     (cb) => ipcRenderer.on('txns-loaded',     (_, d) => cb(d)),
  onStatsUpdate:    (cb) => ipcRenderer.on('stats-update',    (_, d) => cb(d)),
  onFeedLog:        (cb) => ipcRenderer.on('feed-log',        (_, d) => cb(d)),
  onMonitorState:   (cb) => ipcRenderer.on('monitor-state',   (_, d) => cb(d)),
  onAgentState:     (cb) => ipcRenderer.on('agent-state',     (_, d) => cb(d)),
  onPointsSent:     (cb) => ipcRenderer.on('points-sent',     (_, d) => cb(d)),
  onPointsSkipped:  (cb) => ipcRenderer.on('points-skipped',  (_, d) => cb(d)),
  onPointsFailed:   (cb) => ipcRenderer.on('points-failed',   (_, d) => cb(d)),
});

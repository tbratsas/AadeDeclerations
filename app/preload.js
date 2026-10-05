'use strict';
/** Γέφυρα renderer <-> main. Ο renderer δεν έχει πρόσβαση σε Node. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  parse:      text => ipcRenderer.invoke('afm:parse', text),
  loadAfm:    ()   => ipcRenderer.invoke('afm:load'),
  saveAfm:    text => ipcRenderer.invoke('afm:save', text),
  importAfm:  ()   => ipcRenderer.invoke('afm:import'),
  plan:       o    => ipcRenderer.invoke('afm:plan', o),

  results:    ()   => ipcRenderer.invoke('results:list'),
  exportCsv:  ()   => ipcRenderer.invoke('results:export'),
  openLogs:   ()   => ipcRenderer.invoke('logs:open'),
  dataDir:    ()   => ipcRenderer.invoke('app:dataDir'),

  login:      ()   => ipcRenderer.invoke('session:login'),
  start:      opts => ipcRenderer.invoke('run:start', opts),
  stop:       ()   => ipcRenderer.invoke('run:stop'),

  onEvent: cb => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('core-event', h);
    return () => ipcRenderer.removeListener('core-event', h);
  },
});

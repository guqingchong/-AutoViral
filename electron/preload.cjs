"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("autoviral", {
  quit: () => ipcRenderer.send("autoviral-quit"),
  reload: () => ipcRenderer.send("autoviral-reload"),
  getVersion: () => ipcRenderer.invoke("autoviral-version"),
});

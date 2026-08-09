const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("forgeDesktop", {
  getInfo: () => ipcRenderer.invoke("forge:get-desktop-info"),
  selectWorkspace: () => ipcRenderer.invoke("forge:select-workspace"),
  windowAction: (action) => {
    if (["minimize", "maximize", "close"].includes(action)) {
      ipcRenderer.send("forge:window-action", action);
    }
  },
});

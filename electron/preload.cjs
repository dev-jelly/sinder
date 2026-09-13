const { contextBridge, ipcRenderer, webUtils } = require("electron");
const invoke = async (channel, args) => {
  const result = await ipcRenderer.invoke(channel, args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const subscribe = (channel, callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("sinder", {
  bootstrap: () => invoke("bootstrap"),
  list: (location) => invoke("files:list", location),
  mkdir: (location, name) => invoke("files:mkdir", { location, name }),
  rename: (location, name) => invoke("files:rename", { location, name }),
  trash: (locations) => invoke("files:trash", locations),
  preview: (location) => invoke("files:preview", location),
  open: (location) => invoke("files:open", location),
  reveal: (location) => invoke("files:reveal", location),
  connect: (profile, credentials) =>
    invoke("connections:connect", { profile, credentials }),
  cancelConnection: (id) => invoke("connections:cancel", id),
  disconnect: (id) => invoke("connections:disconnect", id),
  removeProfile: (id) => invoke("connections:remove", id),
  readSshConfig: () => invoke("connections:ssh-config"),
  importSshConfig: () => invoke("connections:import-ssh-config"),
  pickKey: () => invoke("dialog:key"),
  pickFolder: () => invoke("dialog:folder"),
  pathForFile: (file) => webUtils.getPathForFile(file),
  bookmarks: (bookmarks) => invoke("bookmarks:save", bookmarks),
  transfer: (request) => invoke("transfers:start", request),
  cancelTransfer: (id) => invoke("transfers:cancel", id),
  editRemote: (location) => invoke("edits:open", location),
  editAction: (id, action) => invoke("edits:action", { id, action }),
  chooseEditor: () => invoke("edits:choose-editor"),
  onEdits: (callback) => subscribe("edits:changed", callback),
  onEditError: (callback) => subscribe("edits:failure", callback),
  onTransfers: (callback) => subscribe("transfers:changed", callback),
  onConnections: (callback) => subscribe("connections:changed", callback),
});

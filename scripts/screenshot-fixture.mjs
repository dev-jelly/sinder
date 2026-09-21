// Public demo data only. This bridge renders the real UI without reading a
// user's files, SSH config, keychain, or connection profiles.
export function installScreenshotFixture({ theme = "light", split = false }) {
  const home = "/Users/demo/Projects";
  const remoteHome = "/srv/projects";
  const connections = [
    { id: "local", name: "이 Mac", kind: "local", status: "connected", home },
    {
      id: "demo",
      name: "개발 서버",
      kind: "ssh",
      status: "connected",
      home: remoteHome,
      host: "demo.example.com",
    },
  ];
  const profile = {
    id: "demo",
    name: "개발 서버",
    host: "demo.example.com",
    port: 22,
    username: "developer",
    auth: "agent",
    initialPath: remoteHome,
    sshConfigHost: "dev-server",
  };
  const local = { connectionId: "local", path: home };
  const remote = { connectionId: "demo", path: remoteHome };
  const panes = [
    { id: "local-pane", location: local, history: [local], cursor: 0 },
  ];
  if (split)
    panes.push({
      id: "remote-pane",
      location: remote,
      history: [remote],
      cursor: 0,
    });
  localStorage.clear();
  localStorage.setItem("sinder-theme", theme);
  localStorage.setItem("sinder-inspector", "false");
  localStorage.setItem("sinder-sidebar", "true");
  localStorage.setItem(
    "sinder-tabs",
    JSON.stringify([{ id: "demo-tab", active: panes.at(-1).id, panes }]),
  );
  const noop = async () => {};
  const subscribe = () => () => {};
  window.sinder = {
    bootstrap: async () => ({
      home,
      platform: "darwin",
      restoreWorkspace: true,
      clipboard: null,
      connections,
      profiles: [profile],
      bookmarks: [
        {
          id: "design",
          name: "디자인 자료",
          location: { ...local, path: `${home}/Design` },
        },
      ],
      transfers: [],
      edits: [],
    }),
    list: async (location) => {
      const remote = location.connectionId === "demo";
      const folders = remote
        ? ["api", "public", "releases", "uploads"]
        : ["Design", "Portfolio", "Sinder", "Website"];
      const names = [
        ...folders,
        ...(remote
          ? [".env.example", "compose.yaml", "README.md", "release-notes.md"]
          : [
              ".gitignore",
              "README.md",
              "release-notes.md",
              "tasks.md",
              "package.json",
            ]),
      ];
      return {
        path: location.path,
        entries: [home, remoteHome].includes(location.path)
          ? names.map((name, index) => ({
              name,
              path: `${location.path}/${name}`,
              kind: index < folders.length ? "directory" : "file",
              size: index < folders.length ? 0 : 1200 + index * 350,
              modified: Date.UTC(2026, 8, 21, 3, 0),
              mode: index < folders.length ? 493 : 420,
              hidden: name.startsWith("."),
            }))
          : [],
      };
    },
    preview: async () => ({
      kind: "text",
      content:
        "# Release notes\n\n파일을 옮기고, 서버의 문서를 바로 편집하세요.\n\n- 여러 창과 분할 보기\n- 로컬 SSH 설정 불러오기\n- 원격 텍스트 파일 편집\n",
    }),
    readSshConfig: async () => ({
      path: "/Users/demo/.ssh/config",
      exists: true,
      entries: [
        {
          alias: "dev-server",
          aliases: ["dev-server"],
          profile,
          route: "direct",
        },
      ],
    }),
    importSshConfig: async () => ({ added: 0 }),
    newWindow: noop,
    closeWindow: noop,
    setClipboard: noop,
    mkdir: noop,
    rename: noop,
    trash: noop,
    open: async () => ({ kind: "local" }),
    reveal: noop,
    connect: async () => connections[1],
    cancelConnection: async () => "cancelled",
    disconnect: noop,
    removeProfile: noop,
    pickKey: async () => null,
    pickFolder: async () => null,
    pathForFile: () => "",
    bookmarks: noop,
    transfer: async () => "demo-transfer",
    cancelTransfer: noop,
    prepareExport: async () => ({
      id: "demo-export",
      names: ["release-notes.md"],
    }),
    startDrag: noop,
    startLocalDrag: noop,
    startRemoteDrag: noop,
    editRemote: noop,
    editAction: noop,
    chooseEditor: async () => null,
    onClipboard: subscribe,
    onNewWindow: subscribe,
    onDragError: subscribe,
    onEdits: subscribe,
    onEditError: subscribe,
    onTransfers: subscribe,
    onConnections: subscribe,
  };
}

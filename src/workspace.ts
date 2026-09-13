import type { Connection, Location } from "../shared/types";
import { locationKey } from "./utils";

export type PaneState = {
  id: string;
  location: Location;
  history: Location[];
  cursor: number;
};
export type Tab = { id: string; panes: PaneState[]; active: string };

export function newPane(location: Location): PaneState {
  return { id: crypto.randomUUID(), location, history: [location], cursor: 0 };
}

export function newTab(location: Location): Tab {
  const pane = newPane(location);
  return { id: crypto.randomUUID(), panes: [pane], active: pane.id };
}

export function navigatePane(pane: PaneState, location: Location): PaneState {
  if (locationKey(pane.location) === locationKey(location)) return pane;
  const history = [...pane.history.slice(0, pane.cursor + 1), location];
  return { ...pane, location, history, cursor: history.length - 1 };
}

export function reconnectPane(
  pane: PaneState,
  connection: Connection,
  requested?: Location | null,
): PaneState {
  if (requested?.connectionId === connection.id)
    return navigatePane(pane, requested);
  return pane.location.connectionId === connection.id
    ? pane
    : navigatePane(pane, {
        connectionId: connection.id,
        path: connection.home,
      });
}

export function updatePane(
  tabs: Tab[],
  tabId: string,
  paneId: string,
  update: (pane: PaneState) => PaneState,
): Tab[] {
  return tabs.map((tab) =>
    tab.id === tabId
      ? {
          ...tab,
          panes: tab.panes.map((pane) =>
            pane.id === paneId ? update(pane) : pane,
          ),
        }
      : tab,
  );
}

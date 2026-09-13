import type { SinderAPI } from "../shared/types";
declare global {
  interface Window {
    sinder: SinderAPI;
  }
}

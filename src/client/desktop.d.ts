export {};

declare global {
  interface Window {
    forgeDesktop?: {
      getInfo: () => Promise<{ platform: string; version: string; workspace: string }>;
      selectWorkspace: () => Promise<{ root: string } | null>;
      windowAction: (action: "minimize" | "maximize" | "close") => void;
    };
  }
}

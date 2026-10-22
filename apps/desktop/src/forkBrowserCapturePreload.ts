import { ipcRenderer } from "electron";
import {
  FORK_BROWSER_CAPTURE_CHANNEL,
  FORK_BROWSER_CAPTURE_REPORT_CHANNEL,
  type ForkBrowserCaptureBridge,
  type ForkBrowserCaptureCommand,
} from "@t3tools/contracts/forkBrowserCapture";

// Fork: keep this optional so a newer web client can still use an older desktop host.
export const forkCapture = {
  report: (event) => ipcRenderer.invoke(FORK_BROWSER_CAPTURE_REPORT_CHANNEL, event),
  onLease: (listener) => {
    const handle = (_event: Electron.IpcRendererEvent, command: ForkBrowserCaptureCommand) =>
      listener(command);
    ipcRenderer.on(FORK_BROWSER_CAPTURE_CHANNEL, handle);
    return () => ipcRenderer.removeListener(FORK_BROWSER_CAPTURE_CHANNEL, handle);
  },
} satisfies NonNullable<ForkBrowserCaptureBridge["forkCapture"]>;

import { requireOptionalNativeModule, type NativeModule } from "expo";
import { Platform } from "react-native";

/** Fork: the screen context of the latest press of the Android assistant button. */
export interface AssistantCapture {
  /** Changes on each press; the panel resets its draft when it changes. */
  readonly id: number;
  readonly sourcePackage: string | null;
  readonly webUri: string | null;
  readonly screenText: string | null;
  readonly screenshotUri: string | null;
}

type AssistantEvents = {
  readonly onCapture: (capture: AssistantCapture) => void;
};

declare class T3AssistantModule extends NativeModule<AssistantEvents> {
  getCapture(): AssistantCapture | null;
  close(): void;
  openAssistantSettings(): void;
  recognizeSpeech(): Promise<string | null>;
}

export const assistantNative =
  Platform.OS === "android" ? requireOptionalNativeModule<T3AssistantModule>("T3Assistant") : null;

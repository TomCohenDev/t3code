import { requireOptionalNativeModule, type NativeModule } from "expo";
import { Platform } from "react-native";

/** Fork: the screen context of the latest press of the Android assistant button. */
export interface AssistantCapture {
  /** Changes on each press; the panel resets its draft when it changes. */
  readonly id: number;
  readonly sourcePackage: string | null;
  readonly webUri: string | null;
  readonly screenText: string | null;
  /** Text that was selected in the app on screen. */
  readonly selectedText: string | null;
  readonly screenshotUri: string | null;
  /** Pixels; 0 until the screenshot arrives. */
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
}

/** Points are flat x, y pairs as fractions of the image; the width is a fraction of its width. */
export interface AnnotationStroke {
  readonly points: ReadonlyArray<number>;
  readonly width: number;
  readonly color: string;
}

type AssistantEvents = {
  readonly onCapture: (capture: AssistantCapture) => void;
};

declare class T3AssistantModule extends NativeModule<AssistantEvents> {
  getCapture(): AssistantCapture | null;
  close(): void;
  openAssistantSettings(): void;
  recognizeSpeech(): Promise<string | null>;
  annotateImage(uri: string, strokes: ReadonlyArray<AnnotationStroke>): Promise<string>;
}

export const assistantNative =
  Platform.OS === "android" ? requireOptionalNativeModule<T3AssistantModule>("T3Assistant") : null;

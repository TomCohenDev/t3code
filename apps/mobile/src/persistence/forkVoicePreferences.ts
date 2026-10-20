import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Fork: phone-local options of the Android assistant panel and of read aloud. They live under
 * one `voice` key of the mobile preferences, so the upstream preference file needs one hook.
 */
export const AssistantInputMode = Schema.Literals(["text", "voice"]);
export type AssistantInputMode = typeof AssistantInputMode.Type;

export const READ_ALOUD_RATES = [0.75, 1, 1.25, 1.5, 2] as const;
export type ReadAloudRate = (typeof READ_ALOUD_RATES)[number];

const ProjectRef = Schema.Struct({ environmentId: EnvironmentId, projectId: Schema.String });
export type AssistantProjectRef = typeof ProjectRef.Type;
const ThreadRef = Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId });
export type ReadAloudThreadRef = typeof ThreadRef.Type;

export interface VoicePreferences {
  /** Whether the panel opens with the keyboard or with the speech dialog. */
  readonly assistantInput?: AssistantInputMode;
  /** Starts the thread as soon as the speech dialog returns text. */
  readonly assistantSendAfterVoice?: boolean;
  readonly assistantAttachScreenshot?: boolean;
  readonly assistantAttachScreenText?: boolean;
  /** Opens the new thread in the app after the server takes it. */
  readonly assistantOpenThread?: boolean;
  /** Keeps the panel open until the first reply is read aloud. */
  readonly assistantSpeakFirstReply?: boolean;
  /** Absent: the project of the last new thread. */
  readonly assistantProject?: AssistantProjectRef;
  /** The read-aloud button on replies. */
  readonly readAloudButton?: boolean;
  readonly readAloudRate?: ReadAloudRate;
  /** Threads whose new replies are read aloud, set by holding the read-aloud button. */
  readonly readAloudThreads?: ReadonlyArray<ReadAloudThreadRef>;
}

export const VOICE_PREFERENCE_DEFAULTS = {
  assistantInput: "text",
  assistantSendAfterVoice: false,
  assistantAttachScreenshot: true,
  assistantAttachScreenText: true,
  assistantOpenThread: false,
  assistantSpeakFirstReply: false,
  assistantProject: null,
  readAloudButton: true,
  readAloudRate: 1,
  readAloudThreads: [],
} as const satisfies {
  readonly [Key in keyof VoicePreferences]-?: NonNullable<VoicePreferences[Key]> | null;
};

export type ResolvedVoicePreferences = {
  readonly [Key in keyof VoicePreferences]-?: Key extends "assistantProject"
    ? AssistantProjectRef | null
    : NonNullable<VoicePreferences[Key]>;
};

export function resolveVoicePreferences(
  stored: VoicePreferences | undefined,
): ResolvedVoicePreferences {
  return {
    ...VOICE_PREFERENCE_DEFAULTS,
    ...stored,
    assistantProject: stored?.assistantProject ?? null,
  };
}

const isAssistantInputMode = Schema.is(AssistantInputMode);
const isProjectRef = Schema.is(ProjectRef);
const isThreadRefs = Schema.is(Schema.Array(ThreadRef));
const isReadAloudRate = (value: unknown): value is ReadAloudRate =>
  READ_ALOUD_RATES.some((rate) => rate === value);

/** Keeps each valid field; a stored value from an older or newer build drops only its bad keys. */
export function sanitizeVoicePreferences(value: unknown): VoicePreferences | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const parsed: Record<string, unknown> = { ...value };
  const result: { -readonly [Key in keyof VoicePreferences]: VoicePreferences[Key] } = {};
  if (isAssistantInputMode(parsed.assistantInput)) result.assistantInput = parsed.assistantInput;
  for (const key of [
    "assistantSendAfterVoice",
    "assistantAttachScreenshot",
    "assistantAttachScreenText",
    "assistantOpenThread",
    "assistantSpeakFirstReply",
    "readAloudButton",
  ] as const) {
    const flag = parsed[key];
    if (typeof flag === "boolean") result[key] = flag;
  }
  if (isProjectRef(parsed.assistantProject)) result.assistantProject = parsed.assistantProject;
  if (isReadAloudRate(parsed.readAloudRate)) result.readAloudRate = parsed.readAloudRate;
  if (isThreadRefs(parsed.readAloudThreads)) result.readAloudThreads = parsed.readAloudThreads;
  return result;
}

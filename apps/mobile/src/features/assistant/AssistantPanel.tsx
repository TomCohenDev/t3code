import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Linking from "expo-linking";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { BackHandler, Image, Pressable, View } from "react-native";
import { KeyboardAvoidingView, KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { assistantNative, type AssistantCapture } from "../../native/assistant";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects, useServerConfigs } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  clearComposerDraft,
  clearComposerDraftContent,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { enqueueThreadOutboxMessage, flattenQueuedThreadMessages } from "../../state/thread-outbox";
import { ThreadOutboxDrainWorker, useIsThreadOutboxHost } from "../../state/thread-outbox-worker";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useVoicePreferences } from "../../state/voice-preferences";
import { CloudAuthProvider } from "../cloud/CloudAuthProvider";
import { AppearancePreferencesProvider } from "../settings/appearance/AppearancePreferencesProvider";
import { NewTaskFlowProvider, useNewTaskFlow } from "../threads/new-task-flow-provider";
import { readingAloudIdAtom, stopReadingAloud } from "../read-aloud/readAloud";
import {
  cancelNextReply,
  ReadAloudWorker,
  readNextReply,
  useWaitsForNextReply,
} from "../read-aloud/ReadAloudWorker";
import { resolveAssistantProject } from "./assistantProject";

/**
 * Fork: the Android assistant panel. `AssistantActivity` renders this root over the app that
 * was on screen, with that screen's text and screenshot. It starts a new thread in the default
 * project; it never shows thread history.
 */
export function AssistantPanelRoot() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <AppearancePreferencesProvider>
        <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
          <SafeAreaProvider>
            <AppServicesWhenAlone />
            <ReadAloudWorker />
            <NewTaskFlowProvider>
              <AssistantPanelForCapture />
            </NewTaskFlowProvider>
          </SafeAreaProvider>
        </KeyboardProvider>
      </AppearancePreferencesProvider>
    </RegistryContext.Provider>
  );
}

/**
 * The app root runs the relay sign-in and the outbox sender when it is mounted. On a cold
 * start only this panel is mounted, so it runs them until the app root mounts.
 */
function AppServicesWhenAlone() {
  if (!useIsThreadOutboxHost()) return null;
  return (
    <CloudAuthProvider>
      <ThreadOutboxDrainWorker />
    </CloudAuthProvider>
  );
}

type Phase =
  | { readonly type: "editing" }
  | { readonly type: "preparing" }
  | { readonly type: "sending"; readonly messageId: string; readonly threadRef: ScopedThreadRef }
  | { readonly type: "failed"; readonly message: string };

let latestCapture: AssistantCapture | null = null;

function subscribeToCapture(onChange: () => void) {
  const subscription = assistantNative?.addListener("onCapture", (capture) => {
    latestCapture = capture;
    onChange();
  });
  // The session can publish before this subscription starts.
  latestCapture = assistantNative?.getCapture() ?? null;
  onChange();
  return () => subscription?.remove();
}

/** Each press of the assistant button gets a fresh panel, so no draft carries over. */
function AssistantPanelForCapture() {
  const capture = useSyncExternalStore(subscribeToCapture, () => latestCapture);
  return <AssistantPanel key={capture?.id ?? "none"} capture={capture} />;
}

function screenTextDocument(capture: AssistantCapture): string | null {
  if (!capture.screenText) return null;
  const header = [
    capture.sourcePackage ? `App: ${capture.sourcePackage}` : null,
    capture.webUri ? `URL: ${capture.webUri}` : null,
  ].filter((line) => line !== null);
  return [...header, ...(header.length > 0 ? [""] : []), capture.screenText].join("\n");
}

/** Turns the panel input into the message text and the draft attachments. */
async function prepareAssistantMessage(input: {
  readonly text: string;
  readonly screenshotUri: string | null;
  readonly screenText: string | null;
  /** Undefined when the server takes no file uploads. */
  readonly maxUploadBytes: number | undefined;
}): Promise<{
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
}> {
  await waitForComposerDraftsLoaded();
  const attachments: DraftComposerAttachment[] = input.screenshotUri
    ? [
        ...(await convertPastedImagesToAttachments({
          uris: [input.screenshotUri],
          existingCount: 0,
        })),
      ]
    : [];
  const text = input.text.trim();
  if (!input.screenText) return { text, attachments };
  if (input.maxUploadBytes === undefined) {
    return { text: `${text}\n\n<screen>\n${input.screenText}\n</screen>`.trim(), attachments };
  }
  attachments.push(
    await createPastedTextComposerAttachment({
      text: input.screenText,
      name: "screen.txt",
      maxBytes: clampFileAttachmentUploadBytes(input.maxUploadBytes),
    }),
  );
  return { text, attachments };
}

function AssistantPanel(props: { readonly capture: AssistantCapture | null }) {
  const { capture } = props;
  const flow = useNewTaskFlow();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const voice = useVoicePreferences();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const queuedMessages = useThreadOutboxMessages();
  const readingId = useAtomValue(readingAloudIdAtom);
  const [text, setText] = useState("");
  // Null follows the setting; a tap on the switch overrides it for this press.
  const [attachScreenshotChoice, setAttachScreenshot] = useState<boolean | null>(null);
  const [attachScreenTextChoice, setAttachScreenText] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>({ type: "editing" });
  const sentRef = useRef(false);
  const startedWithVoiceRef = useRef(false);
  const preferencesLoaded = AsyncResult.isSuccess(preferences);
  const attachScreenshot = attachScreenshotChoice ?? voice.assistantAttachScreenshot;
  const attachScreenText = attachScreenTextChoice ?? voice.assistantAttachScreenText;

  const project = AsyncResult.isSuccess(preferences)
    ? resolveAssistantProject({
        projects,
        chosen: voice.assistantProject,
        preferences: preferences.value,
        scratchWorkspaceRoot: (environmentId) =>
          serverConfigs.get(environmentId)?.scratchWorkspaceRoot,
      })
    : null;
  const selectedProject = flow.selectedProject;
  const selectProject = useEffectEvent(() => {
    if (
      project &&
      (selectedProject?.environmentId !== project.environmentId ||
        selectedProject.id !== project.id)
    ) {
      flow.setProject(project);
    }
  });
  const projectKey = project ? `${project.environmentId}:${project.id}` : null;
  useEffect(() => {
    if (projectKey !== null) selectProject();
  }, [projectKey]);

  const draftKey = flow.draftKey;
  // The outbox hands the message to the server, then the panel opens the thread, reads the
  // first reply aloud, or closes. These states follow the outbox and the player.
  const sendingThread = phase.type === "sending" ? phase.threadRef : null;
  const delivered =
    phase.type === "sending" &&
    !flattenQueuedThreadMessages(queuedMessages).some(
      (message) => message.messageId === phase.messageId,
    );
  const readsReply = voice.assistantSpeakFirstReply && !voice.assistantOpenThread;
  const waitsForReply = useWaitsForNextReply(readsReply ? sendingThread : null);
  const afterDelivery: "open" | "wait" | "read" | "close" | null = !delivered
    ? null
    : voice.assistantOpenThread
      ? "open"
      : !readsReply
        ? "close"
        : waitsForReply
          ? "wait"
          : readingId !== null
            ? "read"
            : "close";
  const waitingThread = afterDelivery === "wait" ? sendingThread : null;
  const close = () => {
    if (!sentRef.current && draftKey) clearComposerDraft(draftKey);
    // Closing while the reply is pending drops the request, so it is not read later.
    if (waitingThread) cancelNextReply(waitingThread);
    assistantNative?.close();
  };
  const onBackPress = useEffectEvent(() => {
    close();
    return true;
  });
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => subscription.remove();
  }, []);

  const finishDelivery = useEffectEvent((action: "open" | "close", threadRef: ScopedThreadRef) => {
    if (action === "open") {
      void Linking.openURL(
        Linking.createURL(
          `threads/${encodeURIComponent(threadRef.environmentId)}/${encodeURIComponent(threadRef.threadId)}`,
        ),
      );
    }
    assistantNative?.close();
  });
  useEffect(() => {
    if ((afterDelivery === "open" || afterDelivery === "close") && sendingThread) {
      finishDelivery(afterDelivery, sendingThread);
    }
  }, [afterDelivery, sendingThread]);

  const screenshotUri = attachScreenshot ? (capture?.screenshotUri ?? null) : null;
  const screenText = attachScreenText && capture ? screenTextDocument(capture) : null;
  const environment = selectedProject
    ? connectedEnvironments.find(
        (candidate) => candidate.environmentId === selectedProject.environmentId,
      )
    : undefined;
  const connected = environment?.connectionState === "connected";
  const busy = phase.type !== "editing" && phase.type !== "failed";
  const ready = !busy && selectedProject !== null && draftKey !== null;
  const hasContent = (messageText: string) =>
    messageText.trim().length > 0 || screenshotUri !== null || screenText !== null;

  const fail = (result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) => {
    const error = squashAtomCommandFailure(result);
    setPhase({ type: "failed", message: error instanceof Error ? error.message : fallback });
  };

  const send = async (messageText: string) => {
    if (!ready || !selectedProject || !draftKey || !hasContent(messageText)) return;
    setPhase({ type: "preparing" });
    const capabilities = serverConfigs.get(selectedProject.environmentId)?.environment.capabilities;
    const prepared = await settlePromise(() =>
      prepareAssistantMessage({
        text: messageText,
        screenshotUri,
        screenText,
        maxUploadBytes:
          capabilities?.attachmentUploads === true
            ? capabilities.fileAttachments?.maxUploadBytes
            : undefined,
      }),
    );
    if (AsyncResult.isFailure(prepared)) return fail(prepared, "The screen could not be attached.");
    flow.setPrompt(prepared.value.text);
    flow.replaceAttachments(prepared.value.attachments);
    const message = flow.buildPendingTaskMessage(makeTurnCommandMetadata(), {
      currentCheckoutBranch: connected ? flow.currentCheckoutBranchName : null,
    });
    if (!message) {
      setPhase({ type: "failed", message: "No model is available for this project yet." });
      return;
    }
    const threadRef = { environmentId: message.environmentId, threadId: message.threadId };
    // Registered before the turn can start, so a fast reply is not missed.
    if (voice.assistantSpeakFirstReply) readNextReply({ threadRef, sinceMs: Date.now() });
    const queued = await settlePromise(() => enqueueThreadOutboxMessage(message));
    if (AsyncResult.isFailure(queued)) {
      cancelNextReply(threadRef);
      return fail(queued, "The thread could not be queued.");
    }
    sentRef.current = true;
    clearComposerDraftContent(draftKey, {
      clearModelSelection: true,
      clearWorkspaceSelection: true,
      deferAttachmentCleanup: true,
    });
    setPhase({ type: "sending", messageId: message.messageId, threadRef });
  };

  const speak = async () => {
    const spoken = await settlePromise(
      async () => (await assistantNative?.recognizeSpeech()) ?? null,
    );
    if (AsyncResult.isFailure(spoken)) return fail(spoken, "Speech input failed.");
    const words = spoken.value;
    if (!words) return;
    const next = text.trim() ? `${text.trimEnd()} ${words}` : words;
    setText(next);
    // When the project is not ready yet on a cold start, the text waits for a tap.
    if (voice.assistantSendAfterVoice && ready) await send(next);
  };

  const startWithVoice = useEffectEvent(() => {
    if (voice.assistantInput === "voice") void speak();
  });
  useEffect(() => {
    if (!preferencesLoaded || startedWithVoiceRef.current) return;
    startedWithVoiceRef.current = true;
    startWithVoice();
  }, [preferencesLoaded]);

  const status = (() => {
    if (afterDelivery === "wait") return "Waiting for the reply…";
    if (afterDelivery === "read") return "Reading the reply aloud";
    switch (phase.type) {
      case "sending":
        return connected ? "Sending…" : "Queued. It sends when the server connects.";
      default:
        return connected ? "Connected" : "Not connected. The thread waits in the outbox.";
    }
  })();

  return (
    <View className="flex-1 justify-end">
      <Pressable
        accessibilityLabel="Close"
        className="absolute inset-0 bg-black/40"
        onPress={close}
      />
      <KeyboardAvoidingView behavior="padding">
        <View
          className="gap-3 rounded-t-3xl bg-sheet px-4 pt-4"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          <View className="flex-row items-center justify-between gap-2">
            <View className="flex-1">
              <Text textRole="body" className="font-medium" numberOfLines={1}>
                {selectedProject ? `New thread in ${selectedProject.title}` : "Loading projects…"}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {status}
              </Text>
            </View>
            {afterDelivery === "read" ? (
              <IconButton
                accessibilityLabel="Stop reading aloud"
                icon="stop.fill"
                onPress={stopReadingAloud}
              />
            ) : null}
            <IconButton accessibilityLabel="Close" icon="xmark" onPress={close} />
          </View>

          {capture?.screenshotUri ? (
            <View className="flex-row items-center gap-3">
              <Image
                source={{ uri: capture.screenshotUri }}
                className="h-24 w-14 rounded-lg"
                resizeMode="cover"
              />
              <Text className="flex-1 text-sm">Attach screenshot</Text>
              <ThemedSwitch
                accessibilityLabel="Attach screenshot"
                disabled={busy}
                value={attachScreenshot}
                onValueChange={setAttachScreenshot}
              />
            </View>
          ) : null}
          {capture?.screenText ? (
            <View className="flex-row items-center gap-3">
              <Text className="flex-1 text-sm" numberOfLines={1}>
                Attach screen text{capture.sourcePackage ? ` from ${capture.sourcePackage}` : ""}
              </Text>
              <ThemedSwitch
                accessibilityLabel="Attach screen text"
                disabled={busy}
                value={attachScreenText}
                onValueChange={setAttachScreenText}
              />
            </View>
          ) : null}

          <AppTextInput
            autoFocus={voice.assistantInput === "text"}
            editable={!busy}
            multiline
            className="max-h-48"
            placeholder="What should the agent do?"
            value={text}
            onChangeText={setText}
          />
          {phase.type === "failed" ? (
            <Text className="text-sm text-danger-foreground">{phase.message}</Text>
          ) : null}
          <View className="flex-row items-center justify-end gap-2">
            <IconButton
              accessibilityLabel="Speak"
              icon="mic"
              variant="tonal"
              disabled={busy}
              onPress={speak}
            />
            <Button
              label="Start thread"
              icon="arrow.up"
              tone="primary"
              disabled={!ready || !hasContent(text)}
              loading={busy}
              onPress={() => void send(text)}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

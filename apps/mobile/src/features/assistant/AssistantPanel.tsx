import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  MessageId,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Linking from "expo-linking";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { BackHandler, Pressable, View } from "react-native";
import {
  KeyboardAvoidingView,
  KeyboardProvider,
  useKeyboardState,
} from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { IconButton } from "../../components/ui/IconButton";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { assistantNative, type AssistantCapture } from "../../native/assistant";
import { appAtomRegistry } from "../../state/atom-registry";
import { useNavigationThreadShells, useProjects, useServerConfigs } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  clearComposerDraft,
  clearComposerDraftContent,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import {
  enqueueThreadOutboxMessage,
  flattenQueuedThreadMessages,
  type QueuedThreadMessage,
} from "../../state/thread-outbox";
import { ThreadOutboxDrainWorker, useIsThreadOutboxHost } from "../../state/thread-outbox-worker";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useVoicePreferences } from "../../state/voice-preferences";
import { CloudAuthProvider } from "../cloud/CloudAuthProvider";
import { AppearancePreferencesProvider } from "../settings/appearance/AppearancePreferencesProvider";
import { NewTaskFlowProvider, useNewTaskFlow } from "../threads/new-task-flow-provider";
import { readingAloudIdAtom, stopReadingAloud } from "../read-aloud/readAloud";
import {
  armNextReply,
  cancelNextReply,
  ReadAloudWorker,
  readNextReply,
  useWaitsForNextReply,
} from "../read-aloud/ReadAloudWorker";
import { resolveAssistantProject } from "./assistantProject";
import { lastOpenedThread } from "./assistantTargets";
import { AssistantTargetPicker, type AssistantTarget } from "./AssistantTargetPicker";
import {
  CaptureChips,
  CapturePreview,
  MachineButton,
  MachineList,
  type CaptureKind,
  type PanelMachine,
} from "./AssistantPanelParts";

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
  const threads = useNavigationThreadShells();
  const [text, setText] = useState("");
  const [pickedTarget, setPickedTarget] = useState<AssistantTarget | null>(null);
  const [pickedEnvironmentId, setPickedEnvironmentId] = useState<EnvironmentId | null>(null);
  // The panel body shows one thing at a time, so it never grows past the composer.
  const [view, setView] = useState<"compose" | "target" | "machine" | CaptureKind>("compose");
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  // Null follows the setting; a tap on the switch overrides it for this press.
  const [attachScreenshotChoice, setAttachScreenshot] = useState<boolean | null>(null);
  const [attachScreenTextChoice, setAttachScreenText] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>({ type: "editing" });
  const sentRef = useRef(false);
  const startedWithVoiceRef = useRef(false);
  const preferencesLoaded = AsyncResult.isSuccess(preferences);
  const attachScreenshot = attachScreenshotChoice ?? voice.assistantAttachScreenshot;
  const attachScreenText = attachScreenTextChoice ?? voice.assistantAttachScreenText;

  // A picked machine limits the defaults and the picker to its threads and projects.
  const machineProjects =
    pickedEnvironmentId === null
      ? projects
      : projects.filter((project) => project.environmentId === pickedEnvironmentId);
  const machineThreads =
    pickedEnvironmentId === null
      ? threads
      : threads.filter((thread) => thread.environmentId === pickedEnvironmentId);
  const defaultProject = AsyncResult.isSuccess(preferences)
    ? resolveAssistantProject({
        projects: machineProjects,
        chosen: voice.assistantProject,
        preferences: preferences.value,
        scratchWorkspaceRoot: (environmentId) =>
          serverConfigs.get(environmentId)?.scratchWorkspaceRoot,
      })
    : null;
  // The picked target wins. A picked thread is looked up again on each render, so a rename shows
  // and an archived or deleted thread falls back to a new thread.
  const defaultThread =
    voice.assistantTarget === "lastThread" ? lastOpenedThread(machineThreads) : null;
  const targetThread =
    pickedTarget === null
      ? defaultThread
      : pickedTarget.type === "thread"
        ? (threads.find(
            (thread) =>
              thread.environmentId === pickedTarget.thread.environmentId &&
              thread.id === pickedTarget.thread.id &&
              thread.archivedAt === null,
          ) ?? null)
        : null;
  const project = pickedTarget?.type === "project" ? pickedTarget.project : defaultProject;
  const target: AssistantTarget | null = targetThread
    ? { type: "thread", thread: targetThread }
    : project
      ? { type: "project", project }
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
    if (view !== "compose") setView("compose");
    else close();
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
    if (delivered && sendingThread) armNextReply(sendingThread);
  }, [delivered, sendingThread]);
  useEffect(() => {
    if ((afterDelivery === "open" || afterDelivery === "close") && sendingThread) {
      finishDelivery(afterDelivery, sendingThread);
    }
  }, [afterDelivery, sendingThread]);

  const screenshotUri = attachScreenshot ? (capture?.screenshotUri ?? null) : null;
  const screenText = attachScreenText && capture ? screenTextDocument(capture) : null;
  const targetEnvironmentId = targetThread?.environmentId ?? selectedProject?.environmentId;
  const environmentLabel = (environmentId: string) =>
    connectedEnvironments.find((candidate) => candidate.environmentId === environmentId)
      ?.environmentLabel ?? null;
  const connected =
    connectedEnvironments.find((candidate) => candidate.environmentId === targetEnvironmentId)
      ?.connectionState === "connected";
  const busy = phase.type !== "editing" && phase.type !== "failed";
  const machines: ReadonlyArray<PanelMachine> = connectedEnvironments
    .filter((environment) => environment.isEnabled)
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.environmentLabel,
      kind: resolveEnvironmentMachineKind(serverConfigs.get(environment.environmentId) ?? null),
      connected: environment.connectionState === "connected",
    }));
  const targetMachine = machines.find((machine) => machine.environmentId === targetEnvironmentId);
  const ready = !busy && (targetThread !== null || (selectedProject !== null && draftKey !== null));
  const hasContent = (messageText: string) =>
    messageText.trim().length > 0 || screenshotUri !== null || screenText !== null;

  const fail = (result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) => {
    const error = squashAtomCommandFailure(result);
    setPhase({ type: "failed", message: error instanceof Error ? error.message : fallback });
  };

  const send = async (messageText: string) => {
    if (!ready || targetEnvironmentId === undefined || !hasContent(messageText)) return;
    setPhase({ type: "preparing" });
    const capabilities = serverConfigs.get(targetEnvironmentId)?.environment.capabilities;
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
    const metadata = makeTurnCommandMetadata();
    let message: QueuedThreadMessage | null;
    if (targetThread) {
      // Queued, so the message becomes its own run after any running one: the panel can then
      // read the reply of exactly this message.
      message = {
        environmentId: targetThread.environmentId,
        threadId: targetThread.id,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text: prepared.value.text,
        attachments: prepared.value.attachments,
        dispatchMode: "queue",
        createdAt: metadata.createdAt,
      };
    } else {
      flow.setPrompt(prepared.value.text);
      flow.replaceAttachments(prepared.value.attachments);
      message = flow.buildPendingTaskMessage(metadata, {
        currentCheckoutBranch: connected ? flow.currentCheckoutBranchName : null,
      });
    }
    if (!message) {
      setPhase({ type: "failed", message: "No model is available for this project yet." });
      return;
    }
    const queuedMessage = message;
    const threadRef = { environmentId: message.environmentId, threadId: message.threadId };
    if (voice.assistantSpeakFirstReply) {
      readNextReply({ threadRef, userMessageId: message.messageId });
    }
    const queued = await settlePromise(() => enqueueThreadOutboxMessage(queuedMessage));
    if (AsyncResult.isFailure(queued)) {
      cancelNextReply(threadRef);
      return fail(queued, "The message could not be queued.");
    }
    sentRef.current = true;
    if (draftKey && targetThread) {
      // The new thread draft held nothing for a message to an existing thread.
      clearComposerDraft(draftKey);
    } else if (draftKey) {
      clearComposerDraftContent(draftKey, {
        clearModelSelection: true,
        clearWorkspaceSelection: true,
        deferAttachmentCleanup: true,
      });
    }
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
    // The dialog can take long, so this reads the state after it closed. When the target is not
    // ready yet on a cold start, the text waits for a tap.
    const latest = latestRef.current;
    if (voice.assistantSendAfterVoice && latest.ready) await latest.send(next);
  };
  const latestRef = useRef({ ready, send });
  useEffect(() => {
    latestRef.current = { ready, send };
  });

  const startWithVoice = useEffectEvent(() => {
    if (voice.assistantInput === "voice") void speak();
  });
  useEffect(() => {
    if (!preferencesLoaded || startedWithVoiceRef.current) return;
    startedWithVoiceRef.current = true;
    startWithVoice();
  }, [preferencesLoaded]);

  // Above the keyboard the system inset is gone, so the row sits right on its edge.
  const bottomPadding = keyboardVisible ? 8 : insets.bottom + 12;
  const targetLabel = targetThread
    ? targetThread.title.trim() || "Untitled thread"
    : project
      ? `New thread · ${project.title}`
      : pickedEnvironmentId !== null && machineProjects.length === 0
        ? "No projects on this machine"
        : "Loading projects…";
  const status = (() => {
    if (afterDelivery === "wait") return "Waiting for the reply…";
    if (afterDelivery === "read") return "Reading the reply aloud";
    switch (phase.type) {
      case "sending":
        return connected ? "Sending…" : "Queued. It sends when the server connects.";
      default:
        return connected ? "Connected" : "Not connected. The message waits in the outbox.";
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
          style={{ paddingBottom: bottomPadding }}
        >
          <View className="flex-row items-center justify-between gap-2">
            {machines.length > 1 && targetMachine ? (
              <MachineButton
                machine={targetMachine}
                expanded={view === "machine"}
                disabled={busy}
                onPress={() =>
                  setView((current) => (current === "machine" ? "compose" : "machine"))
                }
              />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${targetLabel}. Change where to send`}
              accessibilityState={{ expanded: view === "target", disabled: busy }}
              className="flex-1"
              disabled={busy}
              onPress={() => setView((current) => (current === "target" ? "compose" : "target"))}
            >
              <View className="flex-row items-center gap-1">
                <Text textRole="body" className="shrink font-medium" numberOfLines={1}>
                  {targetLabel}
                </Text>
                <SymbolView
                  name={view === "target" ? "chevron.up" : "chevron.down"}
                  size={14}
                  tintColorClassName="accent-foreground-muted"
                />
              </View>
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {status}
              </Text>
            </Pressable>
            {afterDelivery === "read" ? (
              <IconButton
                accessibilityLabel="Stop reading aloud"
                icon="stop.fill"
                onPress={stopReadingAloud}
              />
            ) : null}
            <IconButton accessibilityLabel="Close" icon="xmark" onPress={close} />
          </View>

          {view === "machine" ? (
            <MachineList
              machines={machines}
              selected={targetEnvironmentId}
              onPick={(environmentId) => {
                setPickedEnvironmentId(environmentId);
                // A target on another machine no longer fits; the machine's default takes over.
                if (environmentId !== targetEnvironmentId) setPickedTarget(null);
                setView("compose");
              }}
            />
          ) : view === "target" ? (
            <AssistantTargetPicker
              target={target}
              threads={machineThreads}
              projects={machineProjects}
              environmentLabel={environmentLabel}
              onPick={(picked) => {
                setPickedTarget(picked);
                setView("compose");
              }}
            />
          ) : (view === "screenshot" || view === "screenText") && capture ? (
            <CapturePreview
              kind={view}
              capture={capture}
              attached={view === "screenshot" ? attachScreenshot : attachScreenText}
              onAttachedChange={view === "screenshot" ? setAttachScreenshot : setAttachScreenText}
              onDone={() => setView("compose")}
            />
          ) : (
            <>
              {capture ? (
                <CaptureChips
                  capture={capture}
                  attachScreenshot={attachScreenshot}
                  attachScreenText={attachScreenText}
                  onOpen={setView}
                />
              ) : null}
              {phase.type === "failed" ? (
                <Text className="text-sm text-danger-foreground">{phase.message}</Text>
              ) : null}
              {/* The buttons sit beside the text, so they stay on the keyboard edge. */}
              <View className="flex-row items-end gap-2">
                <IconButton
                  accessibilityLabel="Speak"
                  icon="mic"
                  variant="tonal"
                  disabled={busy}
                  onPress={speak}
                />
                <View className="flex-1">
                  <AppTextInput
                    autoFocus={voice.assistantInput === "text"}
                    editable={!busy}
                    multiline
                    className="max-h-40"
                    placeholder={targetThread ? "Message" : "What should the agent do?"}
                    value={text}
                    onChangeText={setText}
                  />
                </View>
                <IconButton
                  accessibilityLabel={targetThread ? "Send" : "Start thread"}
                  icon="arrow.up"
                  variant="primary"
                  disabled={!ready || !hasContent(text)}
                  onPress={() => void send(text)}
                />
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

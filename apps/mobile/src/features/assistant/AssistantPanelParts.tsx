import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { Image, Pressable, ScrollView, View } from "react-native";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import type { AssistantCapture } from "../../native/assistant";

/** Fork: the parts of the Android assistant panel that are not the composer row. */

export type CaptureKind = "screenshot" | "screenText";

function lineCount(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

/** One chip per captured item. A struck-through chip is left out of the message. */
export function CaptureChips(props: {
  readonly capture: AssistantCapture;
  readonly attachScreenshot: boolean;
  readonly attachScreenText: boolean;
  readonly onOpen: (kind: CaptureKind) => void;
}) {
  const { capture } = props;
  if (!capture.screenshotUri && !capture.screenText) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {capture.screenshotUri ? (
        <Chip
          accessibilityLabel={`Screenshot, ${props.attachScreenshot ? "attached" : "not attached"}. Show`}
          attached={props.attachScreenshot}
          onPress={() => props.onOpen("screenshot")}
        >
          <Image source={{ uri: capture.screenshotUri }} className="h-6 w-4 rounded-sm" />
          <ChipLabel attached={props.attachScreenshot} label="Screenshot" />
        </Chip>
      ) : null}
      {capture.screenText ? (
        <Chip
          accessibilityLabel={`Screen text, ${props.attachScreenText ? "attached" : "not attached"}. Show`}
          attached={props.attachScreenText}
          onPress={() => props.onOpen("screenText")}
        >
          <SymbolView name="doc.text" size={14} tintColorClassName="accent-foreground-muted" />
          <ChipLabel
            attached={props.attachScreenText}
            label={`Screen text · ${lineCount(capture.screenText)} lines`}
          />
        </Chip>
      ) : null}
    </View>
  );
}

function Chip(props: {
  readonly accessibilityLabel: string;
  readonly attached: boolean;
  readonly onPress: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      className={cn(
        "flex-row items-center gap-1.5 rounded-full border px-2.5 py-1",
        props.attached ? "border-input-border bg-input" : "border-input-border opacity-60",
      )}
      onPress={props.onPress}
    >
      {props.children}
    </Pressable>
  );
}

function ChipLabel(props: { readonly attached: boolean; readonly label: string }) {
  return (
    <Text className={cn("text-xs", props.attached ? "" : "line-through")} numberOfLines={1}>
      {props.label}
    </Text>
  );
}

/** What the panel picked up, with the switch that attaches it. */
export function CapturePreview(props: {
  readonly kind: CaptureKind;
  readonly capture: AssistantCapture;
  readonly attached: boolean;
  readonly onAttachedChange: (attached: boolean) => void;
  readonly onDone: () => void;
}) {
  const { capture } = props;
  const label = props.kind === "screenshot" ? "Screenshot" : "Screen text";
  const source = [capture.sourcePackage, capture.webUri].filter((part) => part).join(" · ");
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-3">
        <View className="flex-1">
          <Text className="text-sm font-medium">{label}</Text>
          {source ? (
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {source}
            </Text>
          ) : null}
        </View>
        <Text className="text-sm">Attach</Text>
        <ThemedSwitch
          accessibilityLabel={`Attach the ${label.toLowerCase()}`}
          value={props.attached}
          onValueChange={props.onAttachedChange}
        />
      </View>
      {props.kind === "screenshot" && capture.screenshotUri ? (
        <Image
          source={{ uri: capture.screenshotUri }}
          className="h-80 w-full rounded-xl"
          resizeMode="contain"
        />
      ) : (
        <ScrollView className="max-h-80 rounded-xl bg-input px-3 py-2">
          <Text selectable className="text-sm">
            {capture.screenText}
          </Text>
        </ScrollView>
      )}
      <Pressable
        accessibilityRole="button"
        className="items-center rounded-xl py-2"
        onPress={props.onDone}
      >
        <Text className="text-sm font-medium text-primary-text">Done</Text>
      </Pressable>
    </View>
  );
}

export interface PanelMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly kind: EnvironmentMachineKind;
  readonly connected: boolean;
}

/** The machine icon of the target. It names the machine only in the list it opens. */
export function MachineButton(props: {
  readonly machine: PanelMachine;
  readonly expanded: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Machine: ${props.machine.label}. Change machine`}
      accessibilityState={{ expanded: props.expanded, disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={8}
      className="h-9 w-9 items-center justify-center rounded-full bg-input"
      onPress={props.onPress}
    >
      <EnvironmentMachineSymbol
        kind={props.machine.kind}
        size={18}
        tintColorClassName={props.expanded ? "accent-primary" : "accent-foreground"}
      />
    </Pressable>
  );
}

export function MachineList(props: {
  readonly machines: ReadonlyArray<PanelMachine>;
  readonly selected: EnvironmentId | undefined;
  readonly onPick: (environmentId: EnvironmentId) => void;
}) {
  return (
    <View>
      {props.machines.map((machine) => (
        <Pressable
          key={machine.environmentId}
          accessibilityRole="button"
          accessibilityState={{ selected: machine.environmentId === props.selected }}
          className="flex-row items-center gap-3 rounded-xl px-1 py-2.5"
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          onPress={() => props.onPick(machine.environmentId)}
        >
          <EnvironmentMachineSymbol
            kind={machine.kind}
            size={18}
            tintColorClassName="accent-foreground-muted"
          />
          <View className="flex-1">
            <Text className="text-base" numberOfLines={1}>
              {machine.label}
            </Text>
            {machine.connected ? null : (
              <Text className="text-xs text-foreground-muted">Not connected</Text>
            )}
          </View>
          {machine.environmentId === props.selected ? (
            <SymbolView name="checkmark" size={16} tintColorClassName="accent-primary" />
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

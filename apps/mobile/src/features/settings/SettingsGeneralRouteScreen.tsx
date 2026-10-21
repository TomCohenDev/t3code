import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsEnvironmentFilterHeader } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { VoiceTranscriptionKeySection } from "./VoiceTranscriptionKeySection";

type MicrophonePermission = "checking" | "granted" | "ask" | "denied";

function useMicrophonePermission() {
  const [permission, setPermission] = useState<MicrophonePermission>("checking");
  const apply = useCallback(
    (response: { readonly granted: boolean; readonly canAskAgain: boolean }) =>
      setPermission(response.granted ? "granted" : response.canAskAgain ? "ask" : "denied"),
    [],
  );
  const refresh = useCallback(
    () => void getRecordingPermissionsAsync().then(apply, () => setPermission("ask")),
    [apply],
  );
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  const request = useCallback(
    () => void requestRecordingPermissionsAsync().then(apply, refresh),
    [apply, refresh],
  );
  return { permission, request };
}

export function SettingsGeneralRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const voiceInputEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.voiceInputEnabled !== false
    : true;
  const { permission, request: requestPermission } = useMicrophonePermission();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="General" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <SettingsEnvironmentFilterHeader />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Voice input">
          <SettingsSwitchRow
            icon="mic"
            label="Show microphone"
            subtitle="Mic button in the composer for speech-to-text."
            value={voiceInputEnabled}
            disabled={!preferencesReady}
            onValueChange={(value) => savePreferences({ voiceInputEnabled: value })}
          />
        </SettingsSection>
        {permission === "ask" || permission === "denied" ? (
          <>
            <SettingsSection title="Microphone access">
              <SettingsActionRow
                icon="mic"
                label={permission === "ask" ? "Allow microphone access" : "Open system Settings"}
                onPress={
                  permission === "ask" ? requestPermission : () => void Linking.openSettings()
                }
              />
            </SettingsSection>
            <Text className="px-2 text-sm text-foreground-muted">
              {permission === "ask"
                ? "Voice input needs microphone access before it can record."
                : "Microphone access is off for T3 Code. Turn it on in system Settings to use voice input."}
            </Text>
          </>
        ) : null}
        <Text className="px-2 text-sm text-foreground-muted">
          Turn this on to show the mic. On Android, transcription needs an OpenAI API key on the
          selected environment. On iPhone, the device can transcribe without a key when it can.
        </Text>
        <VoiceTranscriptionKeySection />
        {Platform.OS === "ios" ? (
          <SettingsSection title="Device">
            <SettingsRow
              icon="mic"
              label="Microphone order"
              target="SettingsMicrophone"
              value="Preferred input"
              valuePosition="trailing"
            />
          </SettingsSection>
        ) : null}
      </ScrollView>
    </View>
  );
}

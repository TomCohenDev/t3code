import type { MenuAction } from "@react-native-menu/menu";
import { msg, useGT, useMessages } from "gt-react-native";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { takePhotoWith } from "../../lib/forkComposerCamera";
import {
  TAKE_PHOTO_ACTION_ID,
  useComposerCameraEnabled,
  withTakePhoto,
} from "./forkComposerCamera";

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "photos", title: msg("Photo Library"), image: "photo" },
  { id: "files", title: msg("Choose Files"), image: "folder" },
];

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
}) {
  const gt = useGT();
  const m = useMessages();
  const { scale } = useAndroidControlSizing();
  // Fork: "Take Photo" in the menu while `mobileComposerCamera` is on (forkComposerCamera.ts).
  const camera = useComposerCameraEnabled();
  const button = (
    <Pressable
      accessibilityLabel={gt("Add attachment")}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={props.supportsFiles || camera ? undefined : () => void props.onPickMedia()}
    >
      <SymbolView
        name="plus"
        size={Math.round((props.size === "large" ? 26 : 20) * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled || (!props.supportsFiles && !camera)) {
    return button;
  }

  return (
    <Menu
      accessible
      accessibilityLabel={gt("Add attachment")}
      accessibilityRole="button"
      actions={(camera
        ? withTakePhoto(ATTACHMENT_MENU_ACTIONS, props.supportsFiles)
        : ATTACHMENT_MENU_ACTIONS
      ).map((action) => ({ ...action, title: m(action.title) }))}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === TAKE_PHOTO_ACTION_ID) {
          void takePhotoWith(props.onPickMedia);
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {button}
    </Menu>
  );
}

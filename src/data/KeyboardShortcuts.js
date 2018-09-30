// @flow

export type KeyboardAction =
  | {|
      type: "EnterHintsMode",
      mode: HintsMode,
    |}
  | {|
      type: "ExitHintsMode",
    |}
  | {|
      type: "RotateHints",
      forward: boolean,
    |}
  | {|
      type: "RefreshHints",
    |}
  | {|
      type: "Escape",
    |}
  | {|
      type: "ReverseSelection",
    |};

export type KeyboardShortcut = {|
  key: string,
  code: string,
  altKey: boolean,
  ctrlKey: boolean,
  metaKey: boolean,
  shiftKey: boolean,
|};

export type KeyboardMapping = {|
  shortcut: KeyboardShortcut,
  action: KeyboardAction,
|};

export type KeyboardOptions = {|
  suppressByDefault: boolean,
  sendAll: boolean,
|};

export type HintsMode =
  | "Click"
  | "Many"
  | "BackgroundTab"
  | "ForegroundTab"
  | "Select";

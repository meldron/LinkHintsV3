// @flow

const currentBrowser = getBrowser();

const ICON_SIZES = [16, 32, 48, 64, 96, 128, 256];

module.exports = {
  browser: currentBrowser,
  src: "src",
  dist: "dist",
  rimraf: "src/compiled",
  webextIgnoreFiles: [
    `*.js`,
    `!(compiled)/**/*.js`,
    "icons/*.html",
    ...browserSpecificIgnores(currentBrowser),
  ],
  icons: {
    light: makeIcons("light", ".svg"),
    dark: makeIcons("dark", ".svg"),
    png: makeIcons("png", ".png"),
    testPage: "icons/test.html",
  },
  iconsCompilation: {
    input: "icons.js",
    output: "../icon.svg",
  },
  polyfill: {
    input: "../node_modules/webextension-polyfill/dist/browser-polyfill.min.js",
    output: "compiled/browser-polyfill.js",
  },
  setup: {
    input: "utils/setup.js",
    output: "compiled/setup.js",
  },
  background: {
    input: "background/main.js",
    output: "compiled/background.js",
  },
  allFrames: {
    input: "allFrames/main.js",
    output: "compiled/allFrames.js",
  },
  topFrame: {
    input: "topFrame/main.js",
    output: "compiled/topFrame.js",
  },
  manifest: {
    input: "manifest.js",
    output: "manifest.json",
  },
};

function getBrowser(): ?Browser {
  switch (process.env.BROWSER) {
    case ("chrome": Browser):
      return "chrome";
    case ("firefox": Browser):
      return "firefox";
    default:
      return undefined;
  }
}

function browserSpecificIgnores(browser: ?Browser): Array<string> {
  switch (browser) {
    case "chrome":
      return ["icons/**/*.svg"];
    case "firefox":
      return ["icons/**/*.png"];
    default:
      return [];
  }
}

function makeIcons(name: string, extension: string): Array<[number, string]> {
  return ICON_SIZES.map(size => [size, `icons/${name}/${size}${extension}`]);
}

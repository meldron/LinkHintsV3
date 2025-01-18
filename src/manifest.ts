import config from "../project.config";

type IconsList = Array<[number, string]>;
type Icons = { svg: IconsList; png: IconsList };
type IconSizes = Record<string, string>;

export default (): string =>
  toJSON({
    manifest_version: 3,
    version: config.meta.version,
    name: config.meta.name,
    author: config.meta.author,
    description: config.meta.description,
    homepage_url: config.meta.homepage,
    browser_specific_settings: getBrowserSpecificSettings(config.browser),
    icons: getIcons(config.icons, config.browser),
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
    },
    permissions: [
      "storage",
      "scripting",
      "tabs",
      "activeTab"
    ],
    host_permissions: [
      "<all_urls>"
    ],
    action: {
      default_popup: config.popupHtml,
      default_icon: getIcons(config.icons, config.browser),
    },
    options_ui: {
      page: config.optionsHtml,
      open_in_tab: true,
    },
    background: {
      service_worker: "service-worker.js",
      type: "module"
    },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        all_frames: true,
        match_about_blank: true,
        run_at: "document_start",
        js: [
          config.needsPolyfill ? config.polyfill.output : undefined,
          config.worker.output,
        ].filter((script) => script !== undefined),
      },
      {
        matches: ["<all_urls>"],
        run_at: "document_start",
        js: [
          config.needsPolyfill ? config.polyfill.output : undefined,
          config.renderer.output,
        ].filter((script) => script !== undefined),
      },
    ],
  });

function toJSON(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, undefined, 2);
}

function getBrowserSpecificSettings(browser: Browser | undefined): unknown {
  switch (browser) {
    case "chrome":
      return undefined;

    case "firefox":
    case undefined:
      return {
        gecko: {
          id: config.meta.geckoId,
        },
      };
  }
}

function makeSizes(icons: Array<[number, string]>): IconSizes {
  return Object.fromEntries(
    icons.map(([size, path]) => [size.toString(), path])
  );
}

function getIcons(icons: Icons, browser: Browser | undefined): IconSizes {
  switch (browser) {
    case "firefox":
      return makeSizes(icons.svg);

    case "chrome":
    case undefined:
      return makeSizes(icons.png);
  }
}

// Embedded browser pane: address normalisation, input mapping, picker →
// composer formatting, local-link routing and right-dock availability rules.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const browser = loader.loadModule("@liveagent/ui/lib/browser/embeddedBrowser.ts");
const router = loader.loadModule("@liveagent/ui/lib/browser/inAppLinkRouter.ts");
const dockModel = loader.loadModule("@liveagent/ui/components/project-tools/rightDockModel.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

test("local development hosts cover loopback, private ranges and dev TLDs", () => {
  for (const host of [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "[::1]",
    "10.0.0.8",
    "172.16.4.2",
    "172.31.255.255",
    "192.168.1.20",
    "169.254.1.1",
    "myapp.local",
    "site.test",
  ]) {
    assert.equal(browser.isLocalDevelopmentHost(host), true, host);
  }
  for (const host of ["example.com", "172.32.0.1", "8.8.8.8", "localhost.example.com", ""]) {
    assert.equal(browser.isLocalDevelopmentHost(host), false, host);
  }
  assert.equal(browser.isLocalDevelopmentUrl("http://localhost:5173/app"), true);
  assert.equal(browser.isLocalDevelopmentUrl("https://127.0.0.1:8443"), true);
  assert.equal(browser.isLocalDevelopmentUrl("https://example.com"), false);
  assert.equal(browser.isLocalDevelopmentUrl("file:///etc/passwd"), false);
  assert.equal(browser.isLocalDevelopmentUrl("not a url"), false);
});

test("address bar input becomes a navigable URL, a search or a rejection", () => {
  const url = (input) => browser.normalizeBrowserAddress(input);
  assert.deepEqual(url("  "), { kind: "rejected", reason: "empty" });
  assert.deepEqual(url("about:blank"), { kind: "url", url: "about:blank" });
  assert.deepEqual(url("https://example.com/a?b=1"), {
    kind: "url",
    url: "https://example.com/a?b=1",
  });
  assert.deepEqual(url("localhost:3000"), { kind: "url", url: "http://localhost:3000/" });
  assert.deepEqual(url("localhost"), { kind: "url", url: "http://localhost/" });
  assert.deepEqual(url("127.0.0.1:8080/docs"), { kind: "url", url: "http://127.0.0.1:8080/docs" });
  assert.deepEqual(url("example.com"), { kind: "url", url: "https://example.com/" });
  assert.deepEqual(url("example.com:8080"), { kind: "url", url: "http://example.com:8080/" });
  assert.deepEqual(url("[::1]:5173"), { kind: "url", url: "http://[::1]:5173/" });
  assert.equal(url("javascript:alert(1)").kind, "rejected");
  assert.equal(url("file:///etc/hosts").kind, "rejected");
  assert.equal(url("chrome://settings").kind, "rejected");
  assert.equal(url("data:text/html,hi").kind, "rejected");
  const search = url("how to center a div");
  assert.equal(search.kind, "search");
  assert.ok(search.url.startsWith(browser.EMBEDDED_BROWSER_SEARCH_URL));
  assert.ok(search.url.endsWith(encodeURIComponent("how to center a div")));
});

test("tab labels and blank detection", () => {
  assert.equal(browser.isBlankBrowserTab(null), true);
  assert.equal(browser.isBlankBrowserTab({ url: "about:blank" }), true);
  assert.equal(browser.isBlankBrowserTab({ url: "http://localhost:3000/" }), false);
  assert.equal(browser.browserTabLabel({ url: "about:blank", title: "" }, "New tab"), "New tab");
  assert.equal(
    browser.browserTabLabel({ url: "http://localhost:3000/", title: "Dashboard" }, "New tab"),
    "Dashboard",
  );
  assert.equal(
    browser.browserTabLabel(
      { url: "http://localhost:3000/x", title: "http://localhost:3000/x" },
      "New tab",
    ),
    "localhost:3000",
  );
  assert.equal(browser.browserAddressDisplay("about:blank"), "");
  assert.equal(browser.browserAddressDisplay("http://a.test/"), "http://a.test/");
});

test("pointer positions map into page CSS pixels through object-fit contain", () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 };
  // Same aspect: 1:1 scale.
  assert.deepEqual(browser.mapPointerToViewport(500, 350, rect, { width: 800, height: 600 }), {
    x: 400,
    y: 300,
  });
  // Page viewport twice as large: half scale, letterboxed below.
  assert.deepEqual(browser.mapPointerToViewport(200, 100, rect, { width: 1600, height: 1000 }), {
    x: 200,
    y: 100,
  });
  // Below the drawn image (1000 * 0.5 = 500px tall) → not interactive.
  assert.equal(browser.mapPointerToViewport(200, 580, rect, { width: 1600, height: 1000 }), null);
  assert.equal(browser.mapPointerToViewport(50, 60, rect, { width: 800, height: 600 }), null);
  assert.equal(browser.mapPointerToViewport(10, 10, { ...rect, width: 0 }, { width: 1, height: 1 }), null);
});

test("modifier, mouse button and key forwarding rules", () => {
  assert.equal(
    browser.cdpModifiers({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true }),
    1 | 4 | 8,
  );
  assert.equal(browser.cdpMouseButton(0), "left");
  assert.equal(browser.cdpMouseButton(2), "right");
  assert.equal(browser.cdpMouseButton(9), "none");
  const key = (key, mods = {}) =>
    browser.shouldForwardBrowserKey({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  assert.equal(key("a"), true);
  assert.equal(key("Enter"), true);
  assert.equal(key("Process"), false);
  assert.equal(key("v", { metaKey: true }), false, "paste goes through the paste event");
  assert.equal(key("a", { metaKey: true }), true);
  assert.equal(key("c", { ctrlKey: true }), true);
  assert.equal(key("w", { metaKey: true }), false, "host shortcuts stay with the host");
});

test("picked elements format as a fenced markdown context block", () => {
  const markdown = browser.formatPickedElementsMarkdown([
    {
      pageUrl: "http://localhost:3000/",
      pageTitle: "Fixture",
      tagName: "button",
      role: "",
      accessibleName: "Save",
      selector: "#save",
      xpath: "/html[1]/body[1]/button[1]",
      text: "Save ``` now",
      nearbyText: "",
      htmlExcerpt: '<button id="save">Save</button>',
      attributes: { id: "save", type: "submit" },
      rect: { x: 10, y: 20, width: 80, height: 32 },
      style: {},
    },
  ]);
  assert.match(markdown, /^# Web page elements\n\n## Element 1\n/);
  assert.match(markdown, /- Selector: `#save`/);
  assert.match(markdown, /- Attributes: type="submit"/);
  assert.match(markdown, /- Rect: x=10, y=20, 80×32/);
  // The fence is longer than any backtick run inside the page text.
  assert.match(markdown, /````text\nSave ``` now\n````/);
  assert.equal(browser.formatPickedElementsMarkdown([]), "");
});

test("screenshot helpers", () => {
  assert.equal(
    browser.embeddedBrowserScreenshotFileName(new Date(2026, 0, 2, 3, 4, 5)),
    "browser-screenshot-20260102-030405.png",
  );
  assert.deepEqual(Array.from(browser.base64ToBytes("iVBORw==")), [0x89, 0x50, 0x4e, 0x47]);
});

test("chat links route into the pane only for local dev URLs with a handler", () => {
  const opened = [];
  assert.equal(router.tryOpenInAppBrowser("http://localhost:3000"), false);
  const unregister = router.setInAppBrowserLinkHandler((url) => {
    opened.push(url);
    return true;
  });
  assert.equal(router.hasInAppBrowserLinkHandler(), true);
  assert.equal(router.tryOpenInAppBrowser(" http://localhost:3000/a "), true);
  assert.equal(router.tryOpenInAppBrowser("https://example.com"), false);
  assert.deepEqual(opened, ["http://localhost:3000/a"]);
  // A stale unregister must not clear a newer handler.
  const unregisterNext = router.setInAppBrowserLinkHandler(() => false);
  unregister();
  assert.equal(router.hasInAppBrowserLinkHandler(), true);
  unregisterNext();
  assert.equal(router.hasInAppBrowserLinkHandler(), false);
});

test("right dock offers the browser only on hosts that provide it", () => {
  const withBrowser = { tunnelAvailable: false, browserAvailable: true };
  const withoutBrowser = { tunnelAvailable: true };
  assert.equal(dockModel.rightDockTabRequiresProject("browser"), false);
  assert.equal(dockModel.rightDockToolOffered("browser", withBrowser), true);
  assert.equal(dockModel.rightDockToolOffered("browser", withoutBrowser), false);
  assert.equal(dockModel.rightDockToolOffered("tunnel", withoutBrowser), true);
  assert.equal(dockModel.rightDockStandaloneToolAvailable("browser", withBrowser), true);
  assert.equal(dockModel.rightDockStandaloneToolAvailable("browser", withoutBrowser), false);
  assert.equal(dockModel.rightDockStandaloneToolAvailable("fileTree", withBrowser), false);
  assert.equal(dockModel.anyRightDockStandaloneToolAvailable(withBrowser), true);
  assert.equal(
    dockModel.anyRightDockStandaloneToolAvailable({ tunnelAvailable: false }),
    false,
  );

  const opened = settings.openRightDockSingletonTab(
    settings.normalizeSettings({}),
    "/w/app",
    "browser",
  );
  const projectState = settings.getRightDockProjectState(opened.customSettings, "/w/app");
  assert.ok(projectState.tools.browser, "browser is a persisted right-dock tool kind");
  const visible = (browserAvailable) =>
    dockModel
      .getRightDockVisibleTabs({
        backgroundTasksVisible: false,
        browserAvailable,
        localSessions: [],
        projectPathKey: "/w/app",
        projectState,
        tunnelAvailable: false,
      })
      .map((tab) => tab.id);
  assert.deepEqual(visible(true), [settings.RIGHT_DOCK_SINGLETON_TAB_IDS.browser]);
  // A browser tab synced from the desktop stays hidden on the web UI.
  assert.deepEqual(visible(false), []);
});

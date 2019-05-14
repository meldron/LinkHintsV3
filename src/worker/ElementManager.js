// @flow strict-local

import type {
  ElementType,
  ElementTypes,
  HintMeasurements,
  Point,
  VisibleElement,
} from "../shared/hints";
import {
  type Box,
  Resets,
  addEventListener,
  bind,
  getVisibleBox,
  log,
  partition,
  setStyles,
  unreachable,
  walkTextNodes,
} from "../shared/main";
import type { Durations, Stats, TimeTracker } from "../shared/perf";
import { tweakable } from "../shared/tweakable";
import injected, {
  CLICKABLE_EVENT,
  CLICKABLE_EVENT_NAMES,
  CLICKABLE_EVENT_PROPS,
  EVENT_ATTRIBUTE,
  INJECTED_VAR,
  INJECTED_VAR_PATTERN,
  MESSAGE_FLUSH,
  MESSAGE_RESET,
  QUEUE_EVENT,
  SECRET,
  UNCLICKABLE_EVENT,
} from "./injected";

// Keep the above imports and this object in sync. See injected.js.
const constants = {
  CLICKABLE_EVENT: JSON.stringify(CLICKABLE_EVENT),
  CLICKABLE_EVENT_NAMES: JSON.stringify(CLICKABLE_EVENT_NAMES),
  CLICKABLE_EVENT_PROPS: JSON.stringify(CLICKABLE_EVENT_PROPS),
  EVENT_ATTRIBUTE: JSON.stringify(EVENT_ATTRIBUTE),
  INJECTED_VAR: JSON.stringify(INJECTED_VAR),
  INJECTED_VAR_PATTERN: INJECTED_VAR_PATTERN.toString(),
  MESSAGE_FLUSH: JSON.stringify(MESSAGE_FLUSH),
  MESSAGE_RESET: JSON.stringify(MESSAGE_RESET),
  QUEUE_EVENT: JSON.stringify(QUEUE_EVENT),
  SECRET: JSON.stringify(SECRET),
  UNCLICKABLE_EVENT: JSON.stringify(UNCLICKABLE_EVENT),
};

const ATTRIBUTES_CLICKABLE = new Set<string>([
  // These are supposed to be used with a `role` attribute. In some GitHub
  // dropdowns some items only have this attribute hinting that they are
  // clickable, though.
  "aria-checked",
  "aria-selected",
  // Ember.
  "data-ember-action",
  // Bootstrap.
  "data-dismiss",
  // Twitter.
  "data-permalink-path",
  "data-image-url",
  // Gmail.
  "jsaction",
]);

export const t = {
  // The single-page HTML specification has over 70K links! If trying to track all
  // of those with `IntersectionObserver`, scrolling is noticeably laggy. On my
  // computer, the lag starts somewhere between 10K and 20K tracked links.
  // Tracking at most 10K should be enough for regular sites.
  MAX_INTERSECTION_OBSERVED_ELEMENTS: 10e3,

  ELEMENT_TYPES_LOW_QUALITY: new Set<string>(["clickable-event"]),

  // Give worse hints to scrollable elements and (selectable) frames. They are
  // usually very large by nature, but not that commonly used.
  ELEMENT_TYPES_WORSE: new Set<string>(["scrollable", "selectable"]),

  // Elements this many pixels high or taller always get their hint placed at the
  // very left edge.
  MIN_HEIGHT_BOX: 110, // px

  // Avoid placing hints too far to the right side. The first non-empty text node
  // of an element does not necessarily have to come first, due to CSS. For
  // example, it is not uncommon to see menu items with a label to the left and a
  // number to the right. That number is usually positioned using `float: right;`
  // and due to how floats work it then needs to come _before_ the label in DOM
  // order. This avoids targeting such text.
  MAX_HINT_X_PERCENTAGE_OF_WIDTH: 0.75,

  // Maximum area for elements with only click listeners. Elements larger than
  // this are most likely not clickable, and only used for event delegation.
  MAX_CLICKABLE_EVENT_AREA: 1e6, // px

  PROTOCOLS_LINK: new Set<string>(
    [
      "http:",
      "https:",
      "ftp:",
      "chrome-extension:",
      "moz-extension:",
      // Firefox does not allow opening `file://` URLs in new tabs, but Chrome
      // does. Both allow _clicking_ them.
      // See: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/create>
      BROWSER === "chrome" ? "file:" : undefined,
    ].filter(Boolean)
  ),

  // http://w3c.github.io/aria/#widget_roles
  ROLES_CLICKABLE: new Set<string>([
    "button",
    "checkbox",
    "gridcell",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "searchbox",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
    "treeitem",
    // Omitted since they don’t seem useful to click:
    // "progressbar",
    // "scrollbar",
    // "separator",
    // "slider",
    // "tabpanel",
  ]),

  // "true" indicates that contenteditable on. Chrome also supports
  // "plaintext-only". There may be more modes in the future, such as "caret", so
  // it’s better to only list the values that indicate that an element _isn’t_
  // contenteditable.
  VALUES_NON_CONTENTEDITABLE: new Set<string>([
    // The default value. If a parent is contenteditable, it means that this
    // element is as well (and `element.isContentEditable` is true). But we only
    // want hints for the “root” contenteditable element.
    "inherit",
    // Explicitly turned off:
    "false",
  ]),

  VALUES_SCROLLABLE_OVERFLOW: new Set<string>(["auto", "scroll"]),

  MIN_SIZE_FRAME: 6, // px
  MIN_SIZE_TEXT_RECT: 2, // px
  MIN_SIZE_ICON: 10, // px

  ATTRIBUTES_CLICKABLE,

  ATTRIBUTES_MUTATION: new Set<string>([
    "contenteditable",
    "href",
    "role",
    ...CLICKABLE_EVENT_PROPS,
    ...ATTRIBUTES_CLICKABLE,
  ]),

  // Find actual images as well as icon font images. Matches for example “Icon”,
  // “glyphicon”, “fa” and “fa-thumbs-up” but not “face or “alfa”.
  SELECTOR_IMAGE:
    "img, svg, [class*='icon' i], [class~='fa'], [class^='fa-'], [class*=' fa-']",
};

export const tMeta = tweakable("ElementManager", t);

type Record = {
  addedNodes: Array<Node>,
  removedNodes: Array<Node>,
  attributeName: ?string,
  target: Node,
};

type QueueItem =
  | {|
      type: "Records",
      records: Array<MutationRecord> | Array<Record>,
      recordIndex: number,
      addedNodeIndex: number,
      removedNodeIndex: number,
      childIndex: number,
      children: ?NodeList<HTMLElement>,
      removalsOnly: boolean,
    |}
  | {|
      type: "ClickableChanged",
      target: EventTarget,
      clickable: boolean,
    |}
  | {|
      type: "OverflowChanged",
      target: EventTarget,
    |};

type MutationType = "added" | "removed" | "changed";

const NON_WHITESPACE = /\S/;
const LAST_NON_WHITESPACE = /\S\s*$/;

// If the `<html>` element has for example `transform: translate(-10px, -10px);`
// it can cause the probe to be off-screen, but both Firefox and Chrome seem to
// trigger the IntersectionObserver anyway so we can safely position the probe
// at (0, 0).
const PROBE_STYLES = {
  all: "unset",
  position: "fixed",
  top: "0",
  left: "0",
  width: "1px",
  height: "1px",
};

type Deadline = { timeRemaining: () => number };

const infiniteDeadline: Deadline = {
  timeRemaining: () => Infinity,
};

export default class ElementManager {
  probe: HTMLElement;
  queue: Queue<QueueItem> = makeEmptyQueue();
  injectedHasQueue: boolean = false;
  elements: Map<HTMLElement, ElementType> = new Map();
  visibleElements: Set<HTMLElement> = new Set();
  visibleFrames: Set<HTMLIFrameElement | HTMLFrameElement> = new Set();
  elementsWithClickListeners: WeakSet<HTMLElement> = new WeakSet();
  elementsWithScrollbars: WeakSet<HTMLElement> = new WeakSet();
  idleCallbackId: ?IdleCallbackID = undefined;
  bailed: boolean = false;
  resets: Resets = new Resets();
  observerProbeCallback: ?() => void = undefined;
  flushObserversPromise: ?Promise<void> = undefined;

  intersectionObserver: IntersectionObserver = new IntersectionObserver(
    this.onIntersection.bind(this)
  );

  frameIntersectionObserver: IntersectionObserver = new IntersectionObserver(
    this.onFrameIntersection.bind(this)
  );

  mutationObserver: MutationObserver = new MutationObserver(
    this.onMutation.bind(this)
  );

  removalObserver: MutationObserver = new MutationObserver(
    this.onRemoval.bind(this)
  );

  constructor() {
    const probe = document.createElement("div");
    setStyles(probe, PROBE_STYLES);
    this.probe = probe;

    bind(this, [
      this.onClickableElement,
      this.onUnclickableElement,
      this.onInjectedQueue,
      this.onOverflowChange,
    ]);
  }

  async start() {
    const { documentElement } = document;
    if (documentElement == null) {
      return;
    }

    this.resets.add(
      addEventListener(window, CLICKABLE_EVENT, this.onClickableElement),
      addEventListener(window, UNCLICKABLE_EVENT, this.onUnclickableElement),
      addEventListener(window, QUEUE_EVENT, this.onInjectedQueue),
      addEventListener(window, "overflow", this.onOverflowChange),
      addEventListener(window, "underflow", this.onOverflowChange)
    );

    injectScript();

    // Wait for tweakable values to load before starting the MutationObserver,
    // in case the user has changed `ATTRIBUTES_MUTATION`. After the
    // MutationObserver has been started, queue all elements and frames added
    // before the observer was running.
    await tMeta.loaded;

    this.mutationObserver.observe(documentElement, {
      childList: true,
      subtree: true,
      attributeFilter: Array.from(t.ATTRIBUTES_MUTATION),
    });

    // Pick up all elements present in the initial HTML payload. Large HTML
    // pages are usually streamed in chunks. As later chunks arrive and are
    // rendered, each new element will trigger the MutationObserver.
    const records: Array<Record> = [
      {
        addedNodes: [documentElement],
        removedNodes: [],
        attributeName: undefined,
        target: documentElement,
      },
    ];
    this.queueRecords(records);

    for (const frame of document.querySelectorAll("iframe, frame")) {
      this.frameIntersectionObserver.observe(frame);
    }
  }

  stop() {
    if (this.idleCallbackId != null) {
      cancelIdleCallback(this.idleCallbackId);
    }

    this.intersectionObserver.disconnect();
    this.frameIntersectionObserver.disconnect();
    this.mutationObserver.disconnect();
    this.removalObserver.disconnect();
    this.queue = makeEmptyQueue();
    this.elements.clear();
    this.visibleElements.clear();
    this.visibleFrames.clear();
    // `WeakSet`s don’t have a `.clear()` method.
    // this.elementsWithClickListeners.clear();
    // this.elementsWithScrollbars.clear();
    this.idleCallbackId = undefined;
    this.resets.reset();
    sendInjectedMessage(MESSAGE_RESET);
  }

  // Stop using the intersection observer for everything except frames. The
  // reason to still track frames is because it saves more than half a second
  // when generating hints on the single-page HTML specification.
  bail() {
    if (this.bailed) {
      return;
    }

    const { size } = this.elements;

    this.intersectionObserver.disconnect();
    this.visibleElements.clear();
    this.bailed = true;

    log(
      "warn",
      "ElementManager#bail",
      size,
      t.MAX_INTERSECTION_OBSERVED_ELEMENTS
    );
  }

  makeStats(durations: Durations): Stats {
    return {
      url: window.location.href,
      numElements: this.elements.size,
      numVisibleElements: this.visibleElements.size,
      numVisibleFrames: this.visibleFrames.size,
      bailed: this.bailed ? 1 : 0,
      durations,
    };
  }

  queueItem(item: QueueItem) {
    this.queue.items.push(item);
    this.requestIdleCallback();
  }

  queueRecords(
    records: Array<MutationRecord> | Array<Record>,
    { removalsOnly = false }: { removalsOnly?: boolean } = {}
  ) {
    this.queueItem({
      type: "Records",
      records,
      recordIndex: 0,
      addedNodeIndex: 0,
      removedNodeIndex: 0,
      childIndex: 0,
      children: undefined,
      removalsOnly,
    });
  }

  requestIdleCallback() {
    if (this.idleCallbackId == null) {
      this.idleCallbackId = requestIdleCallback(deadline => {
        this.idleCallbackId = undefined;
        this.flushQueue(deadline);
      });
    }
  }

  onIntersection(entries: Array<IntersectionObserverEntry>) {
    let probed = false;

    for (const entry of entries) {
      if (entry.target === this.probe) {
        probed = true;
      } else if (entry.isIntersecting) {
        this.visibleElements.add(entry.target);
      } else {
        this.visibleElements.delete(entry.target);
      }
    }

    if (probed) {
      log("debug", "ElementManager#onIntersection", "observerProbeCallback");
      if (this.observerProbeCallback != null) {
        this.observerProbeCallback();
      }
    }
  }

  onFrameIntersection(entries: Array<IntersectionObserverEntry>) {
    for (const entry of entries) {
      const element = entry.target;
      if (
        element instanceof HTMLIFrameElement ||
        element instanceof HTMLFrameElement
      ) {
        if (entry.isIntersecting) {
          this.visibleFrames.add(element);
        } else {
          this.visibleFrames.delete(element);
        }
      }
    }
  }

  onMutation(records: Array<MutationRecord>) {
    let shouldQueue = true;
    let probed = false;

    if (this.observerProbeCallback != null) {
      shouldQueue = false;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node === this.probe) {
            probed = true;
          } else {
            shouldQueue = true;
          }
          if (probed && shouldQueue) {
            break;
          }
        }

        if (record.removedNodes.length > 0 || record.attributeName != null) {
          shouldQueue = true;
        }

        if (probed && shouldQueue) {
          break;
        }
      }
    }

    if (shouldQueue) {
      this.queueRecords(records);
      this.observeRemovals(records);
    }

    if (probed) {
      log("debug", "ElementManager#onMutation", "observerProbeCallback", {
        didQueue: shouldQueue,
        queue: {
          length: this.queue.items.length,
          index: this.queue.index,
        },
      });
      if (this.observerProbeCallback != null) {
        this.observerProbeCallback();
      }
    }
  }

  onRemoval(records: Array<MutationRecord>) {
    this.queueRecords(records, {
      // Ignore added nodes and changed attributes.
      removalsOnly: true,
    });
    this.observeRemovals(records);
  }

  // Imagine this scenario:
  //
  // 1. A grand-parent of a clickable element is removed.
  // 2. This triggers `onMutation`.
  // 3. The page removes the clickable element (or a parent of it) from the
  //    grand-parent for some reason (even though the grand-parent is already
  //    removed from the DOM).
  // 4. This does not trigger `onMutation`, since it listens to changes inside
  //    `documentElement`, but this happens in a detached tree.
  // 5. The queue is flushed. Running `.querySelectorAll("*")` on the
  //    grand-parent now won’t include the clickable element, leaving it behind in
  //    `this.elements` even though it has been removed.
  //
  // For this reason, we have to immediately observe all removed nodes for more
  // removals in their subtree, so that we don’t miss any removed elements.
  // MutationObservers don’t have an `.unobserve` method, so all of these are
  // unsubscribed in bulk when `this.queue` is emptied by calling
  // `.disconnect()`.
  observeRemovals(records: Array<MutationRecord>) {
    for (const record of records) {
      for (const node of record.removedNodes) {
        this.removalObserver.observe(node, {
          childList: true,
          subtree: true,
        });
      }
    }
  }

  onClickableElement(event: CustomEvent) {
    const { target } = event;
    this.queueItem({
      type: "ClickableChanged",
      target,
      clickable: true,
    });
  }

  onUnclickableElement(event: CustomEvent) {
    const { target } = event;
    this.queueItem({
      type: "ClickableChanged",
      target,
      clickable: false,
    });
  }

  onInjectedQueue(event: CustomEvent) {
    const { detail } = event;
    if (detail == null) {
      return;
    }

    const { hasQueue } = detail;
    if (typeof hasQueue !== "boolean") {
      return;
    }

    this.injectedHasQueue = hasQueue;
  }

  onOverflowChange(event: UIEvent) {
    const { target } = event;
    this.queueItem({ type: "OverflowChanged", target });
  }

  addOrRemoveElement(mutationType: MutationType, element: HTMLElement) {
    this.consumeEventAttribute(element);

    if (
      element instanceof HTMLIFrameElement ||
      element instanceof HTMLFrameElement
    ) {
      switch (mutationType) {
        case "added":
          // In theory, this can lead to more than
          // `maxIntersectionObservedElements` frames being tracked by the
          // intersection observer, but in practice there are never that many
          // frames. YAGNI.
          this.frameIntersectionObserver.observe(element);
          break;
        case "removed":
          this.frameIntersectionObserver.unobserve(element);
          this.visibleFrames.delete(element); // Just to be sure.
          break;
        case "changed":
          // Do nothing.
          break;
        default:
          unreachable(mutationType);
      }
      return;
    }

    const type =
      mutationType === "removed" ? undefined : this.getElementType(element);
    if (type == null) {
      if (mutationType !== "added") {
        this.elements.delete(element);
        // Removing an element from the DOM also triggers the
        // IntersectionObserver (removing it from `this.visibleElements`), but
        // changing an attribute of an element so that it isn't considered
        // clickable anymore requires a manual deletion from
        // `this.visibleElements` since the element might still be on-screen.
        this.visibleElements.delete(element);
        this.intersectionObserver.unobserve(element);
        // The element must not be removed from `elementsWithClickListeners`
        // or `elementsWithScrollbars` (if `mutationType === "removed"`), even
        // though it might seem logical at first. But the element (or one of
        // its parents) could temporarily be removed from the paged and then
        // re-inserted. Then it would still have its click listener, but we
        // wouldn’t know. So instead of removing `element` here a `WeakSet` is
        // used, to avoid memory leaks. An example of this is the sortable
        // table headings on Wikipedia:
        // <https://en.wikipedia.org/wiki/Help:Sorting>
        // this.elementsWithClickListeners.delete(element);
        // this.elementsWithScrollbars.delete(element);
      }
    } else {
      this.elements.set(element, type);
      if (!this.bailed) {
        this.intersectionObserver.observe(element);
        if (this.elements.size > t.MAX_INTERSECTION_OBSERVED_ELEMENTS) {
          this.bail();
        }
      }
    }
  }

  consumeEventAttribute(element: HTMLElement) {
    const value = element.getAttribute(EVENT_ATTRIBUTE);
    switch (value) {
      case CLICKABLE_EVENT:
        this.elementsWithClickListeners.add(element);
        break;
      case UNCLICKABLE_EVENT:
        this.elementsWithClickListeners.delete(element);
        break;
      default:
        return;
    }
    element.removeAttribute(EVENT_ATTRIBUTE);
  }

  flushQueue(deadline: Deadline) {
    const startQueueIndex = this.queue.index;

    log(
      "debug",
      "ElementManager#flushQueue",
      { length: this.queue.items.length, index: startQueueIndex },
      { ...this.queue.items[startQueueIndex] }
    );

    for (; this.queue.index < this.queue.items.length; this.queue.index++) {
      if (this.queue.index > startQueueIndex && deadline.timeRemaining() <= 0) {
        this.requestIdleCallback();
        return;
      }

      const item = this.queue.items[this.queue.index];

      switch (item.type) {
        // This case is really tricky as all of the loops need to be able to
        // resume where they were during the last idle callback. That’s why we
        // mutate stuff on the current item, saving the indexes for the next
        // idle callback. Be careful not to cause duplicate work.
        case "Records": {
          const startRecordIndex = item.recordIndex;

          for (; item.recordIndex < item.records.length; item.recordIndex++) {
            if (
              item.recordIndex > startRecordIndex &&
              deadline.timeRemaining() <= 0
            ) {
              this.requestIdleCallback();
              return;
            }

            const record = item.records[item.recordIndex];
            const startAddedNodeIndex = item.addedNodeIndex;
            const startRemovedNodeIndex = item.removedNodeIndex;

            if (!item.removalsOnly) {
              for (
                ;
                item.addedNodeIndex < record.addedNodes.length;
                item.addedNodeIndex++
              ) {
                if (
                  item.addedNodeIndex > startAddedNodeIndex &&
                  deadline.timeRemaining() <= 0
                ) {
                  this.requestIdleCallback();
                  return;
                }

                const element = record.addedNodes[item.addedNodeIndex];
                let { children } = item;

                if (children == null && element instanceof HTMLElement) {
                  // When a streaming HTML chunk arrives, _all_ elements in it
                  // will produce its own MutationRecord, even nested elements.
                  // Parent elements come first. Since we do a
                  // `element.querySelectorAll("*")` below, after processing the
                  // first element we have already gone through that entire
                  // subtree. So the next MutationRecord (for a child of the
                  // first element) will be duplicate work. So if we’ve already
                  // gone through an addition of an element in this queue,
                  // simply skip to the next one.
                  // When inserting elements with JavaScript, the number of
                  // MutationRecords for an insert depends on how the code was
                  // written. Every `.append()` on an element that is in the DOM
                  // causes a record. But `.append()` on a non-yet-inserted
                  // element does not. So we can’t simply skip the
                  // `.querySelectorAll("*")` business.
                  // It should be safe to keep the `.addedElements` set even
                  // though the queue lives over time. If an already gone
                  // through element is changed that will cause removal or
                  // attribute mutations, which will be run eventually.
                  if (this.queue.addedElements.has(element)) {
                    continue;
                  }

                  // In my testing on the single-page HTML specification (which
                  // is huge!), `.getElementsByTagName("*")` is faster, but it’s
                  // not like `.querySelectorAll("*")` is super slow. We can use
                  // the former because it returns a live `HTMLCollection` which
                  // mutates as the DOM mutates. If for example a bunch of nodes
                  // are removed, `item.addedNodeIndex` could now be too far
                  // ahead in the list, missing some added elements.
                  children = element.querySelectorAll("*");
                  item.children = children;

                  this.addOrRemoveElement("added", element);
                  this.queue.addedElements.add(element);

                  if (deadline.timeRemaining() <= 0) {
                    this.requestIdleCallback();
                    return;
                  }
                }

                if (children != null && children.length > 0) {
                  const startChildIndex = item.childIndex;
                  for (; item.childIndex < children.length; item.childIndex++) {
                    if (
                      item.childIndex > startChildIndex &&
                      deadline.timeRemaining() <= 0
                    ) {
                      this.requestIdleCallback();
                      return;
                    }
                    const child = children[item.childIndex];
                    if (!this.queue.addedElements.has(child)) {
                      this.addOrRemoveElement("added", child);
                      this.queue.addedElements.add(child);
                    }
                  }
                }

                item.childIndex = 0;
                item.children = undefined;
              }
            }

            for (
              ;
              item.removedNodeIndex < record.removedNodes.length;
              item.removedNodeIndex++
            ) {
              if (
                item.removedNodeIndex > startRemovedNodeIndex &&
                deadline.timeRemaining() <= 0
              ) {
                this.requestIdleCallback();
                return;
              }

              const element = record.removedNodes[item.removedNodeIndex];
              let { children } = item;

              if (children == null && element instanceof HTMLElement) {
                children = element.querySelectorAll("*");
                item.children = children;
                this.addOrRemoveElement("removed", element);
                this.queue.addedElements.delete(element);
                if (deadline.timeRemaining() <= 0) {
                  this.requestIdleCallback();
                  return;
                }
              }

              if (children != null && children.length > 0) {
                const startChildIndex = item.childIndex;
                for (; item.childIndex < children.length; item.childIndex++) {
                  if (
                    item.childIndex > startChildIndex &&
                    deadline.timeRemaining() <= 0
                  ) {
                    this.requestIdleCallback();
                    return;
                  }
                  const child = children[item.childIndex];
                  this.addOrRemoveElement("removed", child);
                  // The same element might be added, removed and then added
                  // again, all in the same queue. So unmark it as already gone
                  // through so it can be re-added again.
                  this.queue.addedElements.delete(child);
                }
              }

              item.childIndex = 0;
              item.children = undefined;
            }

            item.addedNodeIndex = 0;
            item.removedNodeIndex = 0;

            if (!item.removalsOnly && record.attributeName != null) {
              const element = record.target;
              if (element instanceof HTMLElement) {
                this.addOrRemoveElement("changed", element);
              }
            }
          }
          break;
        }

        case "ClickableChanged": {
          const element = item.target;
          if (element instanceof HTMLElement) {
            if (item.clickable) {
              this.elementsWithClickListeners.add(element);
            } else {
              this.elementsWithClickListeners.delete(element);
            }
            this.addOrRemoveElement("changed", element);
          }
          break;
        }

        case "OverflowChanged": {
          const element = item.target;
          if (element instanceof HTMLElement) {
            // An element might have `overflow-x: hidden; overflow-y: auto;`. The events
            // don't tell which direction changed its overflow, so we must check that
            // ourselves. We're only interested in elements with scrollbars, not with
            // hidden overflow.
            if (isScrollable(element)) {
              if (!this.elementsWithScrollbars.has(element)) {
                this.elementsWithScrollbars.add(element);
                this.addOrRemoveElement("changed", element);
              }
            } else if (this.elementsWithScrollbars.has(element)) {
              this.elementsWithScrollbars.delete(element);
              this.addOrRemoveElement("changed", element);
            }
          }
          break;
        }

        default:
          unreachable(item.type, item);
      }
    }

    this.queue = makeEmptyQueue();
    this.removalObserver.disconnect();
    log("debug", "ElementManager#flushQueue", "Empty queue.");
  }

  flushObservers(): Promise<void> {
    const { documentElement } = document;
    if (documentElement == null) {
      return Promise.resolve();
    }

    // Another `.getVisibleElements` is already pending and waiting for observers.
    if (this.flushObserversPromise != null) {
      return this.flushObserversPromise;
    }

    const flushObserversPromise = new Promise(resolve => {
      const intersectionCallback = () => {
        this.observerProbeCallback = undefined;
        this.intersectionObserver.unobserve(this.probe);
        // It is up to the caller of `flushObservers` to remove the probe, since
        // doing so triggers the MutationObserver, queueing a removed element.
        // this.probe.remove();
        resolve();
      };

      const mutationCallback = () => {
        this.observerProbeCallback = intersectionCallback;
        this.intersectionObserver.observe(this.probe);
      };

      // Trigger first the MutationObserver, then the IntersectionObserver.
      // Setting `this.observerProbeCallback` like this is a bit ugly, but it
      // works (at least until we need concurrent flushes).
      this.observerProbeCallback = mutationCallback;
      documentElement.append(this.probe);
    });

    this.flushObserversPromise = flushObserversPromise;
    flushObserversPromise.finally(() => {
      this.flushObserversPromise = undefined;
    });

    return flushObserversPromise;
  }

  async getVisibleElements(
    types: ElementTypes,
    viewports: Array<Box>,
    time: TimeTracker,
    passedCandidates?: Array<HTMLElement>
  ): Promise<Array<?VisibleElement>> {
    const isUpdate = passedCandidates != null;
    const prefix = `ElementManager#getVisibleElements${
      isUpdate ? " (update)" : ""
    }`;

    // Make sure that the MutationObserver and the IntersectionObserver have had
    // a chance to run. This is important if you click a button that adds new
    // elements and really quickly enter hints mode after that. Only do this in
    // the top frame, because that cuts the time to first paint in half on
    // Twitter. Hopefully, while waiting for the observers in the top frame the
    // child frame observers run too. Also, don’t flush observers when updating
    // the positions during hints mode. The thinking is that it should be
    // faster, and observer updates get through during the next update anyway.
    time.start("flush observers");
    if (window.top === window && !isUpdate) {
      log("log", prefix, "flush observers (top frame only)");
      await this.flushObservers();
    }

    time.start("flush queues");

    const injectedNeedsFlush = this.injectedHasQueue;

    if (injectedNeedsFlush) {
      log("log", prefix, "flush injected");
      sendInjectedMessage(MESSAGE_FLUSH);
    }

    // If `injectedNeedsFlush` then `this.queue` will be modified, so check the
    // length _after_ flusing injected.js.
    const needsFlush = this.queue.items.length > 0;

    if (needsFlush) {
      log("log", prefix, "flush queue", this.queue);
      this.flushQueue(infiniteDeadline);
    }

    if (injectedNeedsFlush || needsFlush) {
      log("log", prefix, "flush observers", { injectedNeedsFlush, needsFlush });
      await this.flushObservers();
    }

    this.probe.remove();

    const candidates =
      passedCandidates != null
        ? passedCandidates
        : types === "selectable"
        ? document.getElementsByTagName("*")
        : this.bailed
        ? this.elements.keys()
        : this.visibleElements;
    const range = document.createRange();
    const deduper = new Deduper();

    time.start("loop");
    const maybeResults = Array.from(candidates, element => {
      const type: ?ElementType =
        types === "selectable"
          ? getElementTypeSelectable(element)
          : this.elements.get(element);

      if (type == null) {
        return undefined;
      }

      if (types !== "selectable" && !types.includes(type)) {
        return undefined;
      }

      // Ignore `<label>` elements with no control and no click listeners.
      if (
        type === "label" &&
        element instanceof HTMLLabelElement &&
        element.control == null
      ) {
        return undefined;
      }

      const measurements = getMeasurements(element, type, viewports, range);

      if (measurements == null) {
        return undefined;
      }

      const visibleElement: VisibleElement = {
        element,
        type,
        measurements,
        hasClickListener: this.elementsWithClickListeners.has(element),
      };

      // In selectable mode we need to be able to select `<label>` text, and
      // click listeners aren't taken into account at all, so skip the deduping.
      // Also, a paragraph starting with an inline element shouldn't be deduped
      // away – both should be selectable.
      if (types !== "selectable") {
        deduper.add(visibleElement);
      }

      return visibleElement;
    });

    time.start("filter");
    return maybeResults.map(result =>
      result == null || deduper.rejects(result) ? undefined : result
    );
  }

  getVisibleFrames(
    viewports: Array<Box>
  ): Array<HTMLIFrameElement | HTMLFrameElement> {
    // In theory this might need flushing, but in practice this method is always
    // called _after_ `getVisibleElements`, so everything should already be
    // flushed.
    return Array.from(this.visibleFrames, element => {
      if (
        // Needed on reddit.com. There's a Google Ads iframe where
        // `contentWindow` is null.
        element.contentWindow == null
      ) {
        return undefined;
      }
      // Frames are slow to visit. Gmail has ~10 weird frames that are super
      // small. Not sure what they do. But not visiting saves around ~80ms on my
      // machine.
      const box = getVisibleBox(element.getBoundingClientRect(), viewports);
      return box != null &&
        box.width > t.MIN_SIZE_FRAME &&
        box.height > t.MIN_SIZE_FRAME
        ? element
        : undefined;
    }).filter(Boolean);
  }

  getElementType(element: HTMLElement): ?ElementType {
    switch (element.nodeName) {
      case "A":
        return element instanceof HTMLAnchorElement
          ? getLinkElementType(element)
          : undefined;
      case "BUTTON":
      case "SELECT":
      case "SUMMARY":
      case "AUDIO":
      case "VIDEO":
        return "clickable";
      case "INPUT":
        return element instanceof HTMLInputElement && element.type !== "hidden"
          ? "clickable"
          : undefined;
      // Twitter and DuckDuckGo have useless click handlers on the `<form>`
      // around their search inputs, whose hints end up below the hint of the
      // input. It feels like `<form>`s are never relevant to click, so exclude
      // them.
      case "FORM":
        return undefined;
      case "TEXTAREA":
        return "textarea";
      default: {
        const document = element.ownerDocument;

        // Even `<html>` and `<body>` can be contenteditable. That trumps all
        // the below types.
        // Note: For SVG elements, `.contentEditable` is `undefined`.
        if (
          element.contentEditable != null &&
          !t.VALUES_NON_CONTENTEDITABLE.has(element.contentEditable)
        ) {
          return "textarea";
        }

        if (
          this.elementsWithScrollbars.has(element) &&
          // Allow `<html>` (or `<body>`) to get hints only if they are
          // scrollable and in a frame. This allows focusing frames to scroll
          // them. In Chrome, `iframeElement.focus()` allows for scrolling a
          // specific frame, but I haven’t found a good way to show hints only
          // for _scrollable_ frames. Chrome users can use the "select element"
          // command instead. See `getElementTypeSelectable`.
          !(element === document.scrollingElement && window.top === window)
        ) {
          return "scrollable";
        }

        // `<html>` and `<body>` might have click listeners or role attributes
        // etc. but we never want hints for them.
        if (element === document.documentElement || element === document.body) {
          return undefined;
        }

        const role = element.getAttribute("role");
        if (role != null && t.ROLES_CLICKABLE.has(role)) {
          return "clickable";
        }

        if (
          hasClickListenerProp(element) ||
          this.elementsWithClickListeners.has(element) ||
          Array.from(t.ATTRIBUTES_CLICKABLE).some(attr =>
            element.hasAttribute(attr)
          )
        ) {
          return "clickable-event";
        }

        // Match `<label>` elements last so that labels without controls but
        // with click listeners are matched as clickable.
        if (element.nodeName === "LABEL") {
          return "label";
        }

        return undefined;
      }
    }
  }
}

type Queue<T> = {|
  items: Array<T>,
  index: number,
  addedElements: Set<HTMLElement>,
|};

function makeEmptyQueue<T>(): Queue<T> {
  return {
    items: [],
    index: 0,
    addedElements: new Set(),
  };
}

// Attempt to remove hints that do the same thing as some other element
// (`<label>`–`<input>` pairs) or hints that are most likely false positives
// (`<div>`s with click listeners wrapping a `<button>`).
class Deduper {
  positionMap: Map<string, Array<VisibleElement>> = new Map();
  rejected: Set<HTMLElement> = new Set();

  add(visibleElement: VisibleElement) {
    const { element } = visibleElement;

    // Exclude `<label>` elements whose associated control has a hint.
    // $FlowIgnore: Only some types of elements have `.labels`, and I'm not going to `instanceof` check them all.
    if (element.labels instanceof NodeList) {
      for (const label of element.labels) {
        this.rejected.add(label);
      }
    }

    const key = hintPositionKey(visibleElement.measurements);
    const elements = this.positionMap.get(key);

    if (elements == null) {
      this.positionMap.set(key, [visibleElement]);
      return;
    }

    elements.push(visibleElement);

    const [bad, good] = partition(elements, ({ type }) =>
      t.ELEMENT_TYPES_LOW_QUALITY.has(type)
    );

    // If hints are positioned in the exact same spot, reject those of low
    // quality (for exmaple those that only have click listeners and nothing
    // else) since they are likely just noise. Many `<button>`s and `<a>`s on
    // Twitter and Gmail are wrapped in `<div>`s with click listeners. And on
    // GitHub there are dropdown menus near the top where the hint for the
    // `<summary>` elements that open them are covered by the hint for a
    // `<details>` element with a click listener that doesn't do anything when
    // clicked.
    if (bad.length > 0 && good.length > 0) {
      for (const { element: badElement } of bad) {
        this.rejected.add(badElement);
      }
    }
  }

  rejects({ element }: VisibleElement): boolean {
    return this.rejected.has(element);
  }
}

function hintPositionKey(measurements: HintMeasurements): string {
  return [
    String(Math.round(measurements.x)),
    String(Math.round(measurements.y)),
    measurements.align,
  ].join(",");
}

function getMeasurements(
  element: HTMLElement,
  elementType: ElementType,
  viewports: Array<Box>,
  // The `range` is passed in since it is faster to re-use the same one than
  // creating a new one for every element candidate.
  range: Range
): ?HintMeasurements {
  // If an inline `<a>` wraps a block `<div>`, the link gets three rects. The
  // first and last have 0 width. The middle is the "real" one. Remove the
  // "empty" ones, so that the link is considered a "card" and not a
  // line-wrapped text link.
  const allRects = Array.from(element.getClientRects());
  const filteredRects = allRects.filter(
    rect =>
      rect.width >= t.MIN_SIZE_TEXT_RECT && rect.height >= t.MIN_SIZE_TEXT_RECT
  );
  // For links with only floated children _all_ rects might have 0 width/height.
  // In that case, use the "empty" ones after all. Floated children is handled
  // further below.
  const rects = filteredRects.length > 0 ? filteredRects : allRects;

  // Ignore elements with only click listeners that are really large. These are
  // most likely not clickable, and only used for event delegation.
  if (elementType === "clickable-event" && rects.length === 1) {
    if (area(rects[0]) > t.MAX_CLICKABLE_EVENT_AREA) {
      return undefined;
    }
  }

  const [offsetX, offsetY] = viewports.reduceRight(
    ([x, y], viewport) => [x + viewport.x, y + viewport.y],
    [0, 0]
  );

  const visibleBoxes = Array.from(rects, rect => getVisibleBox(rect, viewports))
    .filter(Boolean)
    // Remove `offsetX` and `offsetY` to turn `x` and `y` back to the coordinate
    // system of the current frame. This is so we can easily make comparisons
    // with other rects of the frame.
    .map(box => ({ ...box, x: box.x - offsetX, y: box.y - offsetY }));

  if (visibleBoxes.length === 0) {
    // If there’s only one rect and that rect has no width it means that all
    // children are floated or absolutely positioned (and that `element` hasn’t
    // been made to “contain” the floats). For example, a link in a menu could
    // contain a span of text floated to the left and an icon floated to the
    // right. Those are still clickable. So return the measurements of one of
    // the children instead. At least for now we just pick the first (in DOM
    // order), but there might be a more clever way of doing it.
    if (rects.length === 1) {
      const rect = rects[0];
      if (rect.width === 0) {
        for (const child of element.children) {
          const measurements = getMeasurements(
            child,
            elementType,
            viewports,
            range
          );
          if (measurements != null) {
            return measurements;
          }
        }
      }
    }

    return undefined;
  }

  const hintPoint =
    rects.length === 1
      ? getSingleRectPoint({
          element,
          elementType,
          rect: rects[0],
          visibleBox: visibleBoxes[0],
          viewports,
          range,
        })
      : getMultiRectPoint({ element, visibleBoxes, viewports, range });

  const maxX = Math.max(...visibleBoxes.map(box => box.x + box.width));

  // Check that the element isn’t covered. A little bit expensive, but totally
  // worth it since it makes link hints in fixed menus so much easier find.
  // If this runs in a frame, the element can still be covered by something in a
  // parent frame, but it's not worth the trouble to try and check that.
  const nonCoveredPoint = getNonCoveredPoint(element, {
    // Rounding upwards is required in html/tridactyl/index.html.
    x: Math.ceil(hintPoint.x),
    y: Math.round(hintPoint.y),
    maxX,
  });

  if (nonCoveredPoint == null) {
    // Putting a large `<input type="file">` inside a smaller wrapper element
    // with `overflow: hidden;` seems to be a common pattern, used both on
    // addons.mozilla.org and <https://blueimp.github.io/jQuery-File-Upload/>.
    if (
      element instanceof HTMLInputElement &&
      element.type === "file" &&
      element.parentNode instanceof HTMLElement &&
      area(element.parentNode.getBoundingClientRect()) < area(rects[0])
    ) {
      const measurements = getMeasurements(
        element.parentNode,
        elementType,
        viewports,
        range
      );
      return measurements == null ? undefined : measurements;
    }

    // CodeMirror editor uses a tiny hidden textarea positioned at the caret.
    // Targeting those are the only reliable way of focusing CodeMirror
    // editors, and doing so without moving the caret.
    // <https://codemirror.net/demo/complete.html>
    if (
      !(
        element instanceof HTMLTextAreaElement &&
        // Use `element.clientWidth` instead of `pointBox.width` because the
        // latter includes the width of the borders of the textarea, which are
        // unreliable.
        element.clientWidth <= 1
      )
    ) {
      return undefined;
    }
  }

  const { x, y } = nonCoveredPoint == null ? hintPoint : nonCoveredPoint;

  // Where to place the hint and the weight of the element.
  return {
    x: x + offsetX,
    y: y + offsetY,
    align: hintPoint.align,
    maxX: maxX + offsetX,
    weight: hintWeight(elementType, visibleBoxes),
  };
}

function getSingleRectPoint({
  element,
  elementType,
  rect,
  visibleBox,
  viewports,
  range,
}: {|
  element: HTMLElement,
  elementType: ElementType,
  rect: ClientRect,
  visibleBox: Box,
  viewports: Array<Box>,
  range: Range,
|}): Point {
  // Scrollbars are usually on the right side, so put the hint there, making it
  // easier to see that the hint is for scrolling and reducing overlap.
  if (elementType === "scrollable") {
    return {
      ...getXY(visibleBox),
      x: visibleBox.x + visibleBox.width - 1,
      align: "right",
    };
  }

  // Always put hints for "tall" elements at the left-center edge – except in
  // selectable mode (long paragraphs). Then it is nicer to put the marker at
  // the start of the text.
  // Also do not look for text nodes or images in `<textarea>` (which does have
  // hidden text nodes) and `contenteditable` elements, since it looks nicer
  // always placing the hint at the edge for such elements. Usually they are
  // tall enough to have their hint end up there. This ensures the hint is
  // _always_ placed there for consistency.
  if (
    elementType === "textarea" ||
    (elementType !== "selectable" && rect.height >= t.MIN_HEIGHT_BOX)
  ) {
    return {
      ...getXY(visibleBox),
      align: "left",
    };
  }

  function isAcceptable(point: Point): boolean {
    return isWithin(point, visibleBox);
  }

  // Try to place the hint at the text of the element.
  // Don’t try to look for text nodes in `<select>` elements. There
  // _are_ text nodes inside the `<option>` elements and their rects _can_ be
  // measured, but if the dropdown opens _upwards_ the `elementAtPoint` check
  // will fail. An example is the signup form at <https://www.facebook.com/>.
  // Also, ignore fallback text inside `<canvas>` elements.
  if (
    !(
      element instanceof HTMLSelectElement ||
      element instanceof HTMLCanvasElement
    )
  ) {
    const textPoint = getBestNonEmptyTextPoint({
      element,
      elementRect: rect,
      viewports,
      isAcceptable,
      preferTextStart: elementType === "selectable",
      range,
    });

    if (textPoint != null) {
      return textPoint;
    }
  }

  // Try to place the hint near an image. Many buttons have just an icon and no
  // (visible) text.
  const imagePoint = getFirstImagePoint(element, viewports);
  if (
    imagePoint != null &&
    // For images that are taller than the element, allow the point to be
    // outside the rects. It's common to find `p > a > img` where the `<a>` is
    // just a regular inline element with the `<img>` sticking out the top.
    (isAcceptable(imagePoint.point) || rect.height < imagePoint.rect.height)
  ) {
    return imagePoint.point;
  }

  // Checkboxes and radio buttons are typically small and we don't want to cover
  // them with the hint.
  if (
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
  ) {
    return {
      ...getXY(visibleBox),
      align: "right",
    };
  }

  // Take border and padding into account. This is nice since it places the hint
  // nearer the placeholder in `<input>` elements and nearer the text in `<input
  // type="button">` and `<select>`.
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement
  ) {
    const borderAndPaddingPoint = getBorderAndPaddingPoint(
      element,
      rect,
      visibleBox
    );
    if (isAcceptable(borderAndPaddingPoint)) {
      return borderAndPaddingPoint;
    }
  }

  return {
    ...getXY(visibleBox),
    align: "left",
  };
}

function getMultiRectPoint({
  element,
  visibleBoxes,
  viewports,
  range,
}: {|
  element: HTMLElement,
  visibleBoxes: Array<Box>,
  viewports: Array<Box>,
  range: Range,
|}): Point {
  function isAcceptable(point: Point): boolean {
    return visibleBoxes.some(box => isWithin(point, box));
  }

  const textPoint = getBestNonEmptyTextPoint({
    element,
    elementRect: element.getBoundingClientRect(),
    viewports,
    isAcceptable,
    preferTextStart: true,
    range,
  });
  if (textPoint != null) {
    return textPoint;
  }

  const minY = Math.min(...visibleBoxes.map(box => box.y));
  const maxY = Math.max(...visibleBoxes.map(box => box.y + box.height));

  return {
    x: Math.min(...visibleBoxes.map(box => box.x)),
    y: (minY + maxY) / 2,
    align: "right",
  };
}

function getFirstImagePoint(
  element: HTMLElement,
  viewports: Array<Box>
): ?{| point: Point, rect: ClientRect |} {
  const images = [
    // First try to find an image _child._ For example, <button
    // class="icon-button"><img></button>`. (This button should get the hint at
    // the image, not at the edge of the button.)
    ...element.querySelectorAll(t.SELECTOR_IMAGE),
    // Then, see if the element itself is an image. For example, `<button
    // class="Icon Icon-search"></button>`. The element itself can also be an
    // `<img>` due to the `float` case in `getMeasurements`.
    ...(element.matches(t.SELECTOR_IMAGE) ? [element] : []),
  ];

  // Some buttons on Twitter have two icons inside – one shown, one hidden (and
  // it toggles between them based on if the button is active or not). At least
  // for now we just pick the first image (in DOM order) that gets a
  // `visibleBox`, but there might be a more clever way of doing it.
  for (const image of images) {
    const rect = image.getBoundingClientRect();
    const visibleBox = getVisibleBox(rect, viewports);

    if (visibleBox != null) {
      return {
        point: {
          // The image might have padding around it.
          ...getBorderAndPaddingPoint(image, rect, visibleBox),
          align: rect.height >= t.MIN_HEIGHT_BOX ? "left" : "right",
        },
        rect,
      };
    }
  }

  return undefined;
}

function getBorderAndPaddingPoint(
  element: HTMLElement,
  rect: ClientRect,
  visibleBox: Box
): Point {
  const computedStyle = window.getComputedStyle(element);

  const left =
    parseFloat(computedStyle.getPropertyValue("border-left-width")) +
    parseFloat(computedStyle.getPropertyValue("padding-left"));

  return {
    ...getXY(visibleBox),
    x: rect.left + left,
    align:
      element instanceof HTMLInputElement &&
      (element.type === "file" ||
        (element.type === "image" && element.src !== ""))
        ? "left"
        : "right",
  };
}

function getNonCoveredPoint(
  element: HTMLElement,
  { x, y, maxX }: {| x: number, y: number, maxX: number |}
): ?{| x: number, y: number |} {
  const elementAtPoint = document.elementFromPoint(x, y);

  // (x, y) is off-screen.
  if (elementAtPoint == null) {
    return undefined;
  }

  // `.contains` also checks `element === elementAtPoint`.
  if (element.contains(elementAtPoint)) {
    return { x, y };
  }

  const rect = elementAtPoint.getBoundingClientRect();

  // `.getBoundingClientRect()` does not include pseudo-elements that are
  // absolutely positioned so that they go outside of the element, but calling
  // `.elementAtPoint()` on the pseudo-element _does_ return the element. For
  // `/###\`-looking tabs, which overlap each other slightly, the slanted parts
  // are often made using pseudo-elements. When trying to position a hint for
  // tab 2, `.elementAtPoint()` might return tab 1. So if we get a non-sensical
  // rect (one that does not cover (x, y)) for the "covering" element it's
  // better to treat (x, y) as non-covered.
  if (rect.left > x || rect.right <= x || rect.top > y || rect.bottom <= y) {
    return { x, y };
  }

  const newX = Math.round(rect.right + 1);

  // Try once to the right of the covering element (if it doesn't cover all the
  // way to the right of `element`). For example, there could be an absolutely
  // positioned search icon at the left of an `<input>`. Just trying once to the
  // right seemed to be a good tradeoff between correctness and performance in
  // the VimFx add-on.
  if (newX > x && newX <= maxX) {
    const elementAtPoint2 = document.elementFromPoint(newX, y);

    if (elementAtPoint2 != null && element.contains(elementAtPoint2)) {
      return { x: newX, y };
    }
  }

  return undefined;
}

// Try to find the best piece of text to place the hint at. This is difficult,
// since lots of types of elements end up here: Everything from simple text
// links to "cards" with titles, subtitles, badges and price tags. See the
// inline comments for more details.
function getBestNonEmptyTextPoint({
  element,
  elementRect,
  viewports,
  isAcceptable,
  preferTextStart = false,
  range,
}: {|
  element: HTMLElement,
  elementRect: ClientRect,
  viewports: Array<Box>,
  isAcceptable: Point => boolean,
  preferTextStart: boolean,
  range: Range,
|}): ?Point {
  const align = "right";

  // This goes through _all_ text nodes inside the element. That sounds
  // expensive, but in reality I have not noticed this to slow things down. Note
  // that `range.selectNodeContents(element); range.getClientRects()` might seem
  // easier to use, but it takes padding and such of child elements into
  // account. Also, it would count leading visible whitespace as the first
  // character.
  const rects = [].concat(
    ...Array.from(walkTextNodes(element), textNode => {
      const start = textNode.data.search(NON_WHITESPACE);
      const end = textNode.data.search(LAST_NON_WHITESPACE);
      if (start >= 0 && end >= 0) {
        range.setStart(textNode, start);
        range.setEnd(textNode, end + 1);
        return Array.from(range.getClientRects(), rect => {
          const point = { ...getXY(rect), align };
          return (
            // Exclude screen reader only text.
            rect.width >= t.MIN_SIZE_TEXT_RECT &&
              rect.height >= t.MIN_SIZE_TEXT_RECT &&
              // Make sure that the text is inside the element.
              isAcceptable(point)
              ? rect
              : undefined
          );
        }).filter(Boolean);
      }
      return [];
    })
  );

  if (rects.length === 0) {
    return undefined;
  }

  // In selectable mode, prefer placing the hint at the start of the text
  // (visually) rather than at the most eye-catching text. Also used for
  // line-wrapped links, where the hint should be at the start of the link (if
  // possible), not at the left-most part of it:
  //
  //     text text text [F]link
  //     link text text
  //
  if (preferTextStart) {
    // Prefer the top-most part of the line. In case of a tie, prefer the
    // left-most one.
    const leftMostRect = rects.reduce((a, b) =>
      b.top < a.top ? b : b.top === a.top && b.left < a.left ? b : a
    );
    return { ...getXY(leftMostRect), align };
  }

  // Prefer the tallest one. In case of a tie, prefer the widest one.
  const largestRect = rects.reduce((a, b) =>
    b.height > a.height ? b : b.height === a.height && b.width > a.width ? b : a
  );

  // There could be smaller text just to the left of the tallest text. It feels
  // more natural to be looking for the tallest _line_ rather than the tallest
  // piece of text and place the hint at the beginning of the line.
  const sameLineRects = rects.filter(
    rect => rect.top < largestRect.bottom && rect.bottom > largestRect.top
  );

  // Prefer the left-most part of the line. In case of a tie, prefer the
  // top-most one.
  const leftMostRect = sameLineRects.reduce((a, b) =>
    b.left < a.left ? b : b.left === a.left && b.top < a.top ? b : a
  );

  // If the text of the element is a single line and there's room to the left of
  // the text for an icon, look for an icon (image) and place the hint there
  // instead. It is common to have a little icon before the text of buttons.
  // This avoids covering the icon with the hint.
  const isSingleLine = sameLineRects.length === rects.length;
  if (isSingleLine && leftMostRect.left >= elementRect.left + t.MIN_SIZE_ICON) {
    const imagePoint = getFirstImagePoint(element, viewports);
    if (
      imagePoint != null &&
      imagePoint.point.x < leftMostRect.left &&
      isAcceptable(imagePoint.point)
    ) {
      return imagePoint.point;
    }
  }

  return { ...getXY(leftMostRect), align };
}

function isWithin(point: Point, box: Box): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width * t.MAX_HINT_X_PERCENTAGE_OF_WIDTH &&
    point.y >= box.y &&
    // Use `<`, not `<=`, since a point at `box.y + box.height` is located at
    // the first pixel _below_ the box.
    point.y < box.y + box.height
  );
}

function injectScript() {
  // Neither Chrome nor Firefox allow inline scripts in the options page. It's
  // not needed there anyway.
  if (window.location.protocol.endsWith("-extension:")) {
    return;
  }

  const { documentElement } = document;
  if (documentElement == null) {
    return;
  }

  const rawCode = replaceConstants(injected.toString());
  const code = `(${rawCode})()`;

  // In Firefox, `eval !== window.eval`. `eval` executes in the content script
  // context, while `window.eval` executes in the page context. So in Firefox we
  // can use `window.eval` instead of a script tag.
  let hasCSP = false;
  if (BROWSER === "firefox") {
    try {
      // Hide the eval call from linters and Rollup since this is a legit and
      // safe usage of eval: The input is static and known, and this is just a
      // substitute for running the code as an inline script (see below). Also,
      // it is run in the _page_ context.
      window["ev".concat("al")](code);
      return;
    } catch {
      // However, the `window.eval` can fail if the page has a Content Security
      // Policy. In such a case we have to resort to injecting a `<script
      // src="...">`. Script tags with URLs injected by a web extension seems to
      // be allowed regardless of CSP. In theory an inline script _could_ be
      // allowed by the CSP (which would be a better choice since inline scripts
      // execute synchronously while scripts with URLs are always async – and we
      // want to ideally execute as early as possible in case the page adds
      // click listeners via an inline script), but there's no easy way of
      // detecting if inline scrips are allowed. As a last note, if the
      // `window.eval` fails a warning is unfortunately logged to the console. I
      // wish there was a way to avoid that.
      hasCSP = true;
    }
  }

  const script = document.createElement("script");

  if (hasCSP) {
    script.src = `data:application/javascript;utf8,${encodeURIComponent(code)}`;
  } else {
    // Chrome nicely allows inline scripts inserted by an extension regardless
    // of CSP. I look forward to the day Firefox works this way too. See
    // <bugzil.la/1446231> and <bugzil.la/1267027>.
    script.textContent = code;
  }

  documentElement.append(script);
  script.remove();
}

function replaceConstants(code: string): string {
  const regex = RegExp(`\\b(${Object.keys(constants).join("|")})\\b`, "g");
  return code.replace(regex, name => constants[name]);
}

function isScrollable(element: HTMLElement): boolean {
  const computedStyle = window.getComputedStyle(element);

  // `.scrollLeftMax` and `.scrollTopMax` are Firefox-only, but this function is
  // only called from the "overflow" and "underflow" event listeners, and those
  // are Firefox-only as well. Those properties are the easiest way to check if
  // an element overflows in either the X or Y direction.
  return (
    // $FlowIgnore: See above.
    (element.scrollLeftMax > 0 &&
      (t.VALUES_SCROLLABLE_OVERFLOW.has(
        computedStyle.getPropertyValue("overflow-x")
      ) ||
        element === document.scrollingElement)) ||
    // $FlowIgnore: See above.
    (element.scrollTopMax > 0 &&
      (t.VALUES_SCROLLABLE_OVERFLOW.has(
        computedStyle.getPropertyValue("overflow-y")
      ) ||
        element === document.scrollingElement))
  );
}

function hasClickListenerProp(element: HTMLElement): boolean {
  // Adding a `onclick="..."` attribute in HTML automatically sets
  // `.onclick` of the element to a function. But in Chrome, `.onclick`
  // is `undefined` when inspected from a content script, so we need to
  // use `.hasAttribute` instead. That works, except in rare edge cases
  // where `.onclick = null` is set afterwards (the attribute string
  // will remain but the listener will be gone).
  return CLICKABLE_EVENT_PROPS.some(prop =>
    BROWSER === "chrome"
      ? element.hasAttribute(prop)
      : // $FlowIgnore: I _do_ want to dynamically read properties here.
        typeof element[prop] === "function"
  );
}

function sendInjectedMessage(message: string) {
  try {
    if (window.wrappedJSObject != null) {
      window.wrappedJSObject[INJECTED_VAR](message, SECRET);
    } else {
      const { documentElement } = document;
      if (documentElement == null) {
        return;
      }
      // I guess the page can read the secret via a MutationObserver, but at
      // least in the Firefox case the page shouldn't be able to read it. The
      // page can't do much with the secret anyway. However, this probably runs
      // so early that the page never has a chance to set up a MutationObserver
      // in time.
      const script = document.createElement("script");
      script.textContent = `window[${JSON.stringify(
        INJECTED_VAR
      )}](${JSON.stringify(message)}, ${JSON.stringify(SECRET)});`;
      documentElement.append(script);
      script.remove();
    }
  } catch (error) {
    log("error", "Failed to message injected.js", error);
  }
}

function getXY(box: Box | ClientRect): {| x: number, y: number |} {
  return {
    // $FlowIgnore: Chrome and Firefox _do_ support `.x` and `.y` on ClientRects (aka DOMRects).
    x: box.x,
    // $FlowIgnore: See above.
    y: box.y + box.height / 2,
  };
}

function area(rect: ClientRect): number {
  return rect.width * rect.height;
}

function hintWeight(
  elementType: ElementType,
  visibleBoxes: Array<Box>
): number {
  // Use the height as the weight. In a list of links, all links will then get
  // the same weight, since they have the same weight. (They’re all as important
  // as the other.) A multiline link gets the height of one of its lines as
  // weight. But use the width as weight if it is smaller so that very tall but
  // not very wide elements aren’t over powered.
  // If there are a bunch boxes next to each other with seemingly the same size
  // (and no other clickable elements around) the first box should get the first
  // hint chars as a hint, the second should get the second hint char, and so
  // on. However, the sizes of the boxes can differ ever so slightly (by less
  // than 1px). So round the weight to make the order more predictable.
  const weight = Math.round(
    Math.min(
      Math.max(...visibleBoxes.map(box => box.width)),
      Math.max(...visibleBoxes.map(box => box.height))
    )
  );

  // Use logarithms too make the difference between small and large elements
  // smaller. Instead of an “image card” being 10 times heavier than a
  // navigation link, it’ll only be about 3 times heavier. Give worse hints to
  // some types, such as scrollable elements, by using a logarithm with a higher
  // base. A tall scrollable element (1080px) gets a weight slightly smaller
  // than that of a small link (12px high).
  const lg = t.ELEMENT_TYPES_WORSE.has(elementType) ? Math.log10 : Math.log2;

  return Math.max(1, lg(weight));
}

function getElementTypeSelectable(element: HTMLElement): ?ElementType {
  switch (element.nodeName) {
    // Links _could_ be marked as "clickable" as well for simplicity, but
    // marking them as "link" allows opening them in a new tab by holding alt
    // for consistency with all other hints modes.
    case "A":
      return element instanceof HTMLAnchorElement
        ? getLinkElementType(element)
        : undefined;
    // Always consider the following elements as selectable, regardless of their
    // children, since they have special context menu items. A
    // `<canvas><p>fallback</p></canvas>` could be considered a wrapper element
    // and be skipped otherwise. Making frames selectable also allows Chrome
    // users to scroll frames using the arrow keys. It would be convenient to
    // give frames hints during regular click hints mode for that reason, but
    // unfortunately for example Twitter uses iframes for many of its little
    // widgets/embeds which would result in many unnecessary/confusing hints.
    case "AUDIO":
    case "BUTTON":
    case "SELECT":
    case "TEXTAREA":
    case "VIDEO":
      return "clickable";
    case "INPUT":
      return element instanceof HTMLInputElement && element.type !== "hidden"
        ? "clickable"
        : undefined;
    case "CANVAS":
    case "EMBED":
    case "FRAME":
    case "IFRAME":
    case "IMG":
    case "OBJECT":
      return "selectable";
    default: {
      // If an element has no child _elements_ (but possibly child text nodes),
      // consider it selectable. This allows focusing `<div>`-based "buttons"
      // with only a background image as icon inside. It also catches many
      // elements with text without having to iterate through all child text
      // nodes.
      if (element.childElementCount === 0) {
        return "selectable";
      }

      // If the element has at least one immediate non-blank text node, consider
      // it selectable. If an element contains only other elements, whitespace
      // and comments it is a "wrapper" element that would just cause duplicate
      // hints.
      for (const node of element.childNodes) {
        if (node instanceof Text && NON_WHITESPACE.test(node.data)) {
          return "selectable";
        }
      }
      return undefined;
    }
  }
}

function getLinkElementType(element: HTMLAnchorElement): ElementType {
  const hrefAttr = element.getAttribute("href");
  return (
    // Exclude `<a>` tags used as buttons.
    typeof hrefAttr === "string" &&
      hrefAttr !== "" &&
      hrefAttr !== "#" &&
      // Exclude `javascript:`, `mailto:`, `tel:` and other protocols that
      // don’t make sense to open in a new tab.
      t.PROTOCOLS_LINK.has(element.protocol)
      ? "link"
      : "clickable"
  );
}

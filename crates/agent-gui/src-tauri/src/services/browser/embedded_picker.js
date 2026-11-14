// Element picker injected into the embedded browser pane's active tab.
// Evaluated via Runtime.evaluate(awaitPromise) and resolves with a plain
// object describing the clicked element, or null when cancelled (Escape or
// window.__liveagentElementPicker.cancel()).
(() => {
  const STATE_KEY = "__liveagentElementPicker";
  const existing = window[STATE_KEY];
  if (existing && typeof existing.cancel === "function") {
    existing.cancel();
  }

  const MAX_TEXT = 1200;
  const MAX_HTML = 2400;
  const ATTRIBUTE_ALLOWLIST = new Set([
    "id",
    "class",
    "href",
    "src",
    "alt",
    "title",
    "name",
    "type",
    "placeholder",
    "role",
    "for",
    "action",
    "method",
    "target",
    "rel",
    "data-testid",
  ]);

  const clip = (value, max) => {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  const squash = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const cssEscape = (value) =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(value)
      : String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);

  const isPassword = (el) =>
    el instanceof HTMLInputElement && String(el.type).toLowerCase() === "password";

  const buildSelector = (el) => {
    if (!(el instanceof Element)) return "";
    if (el.id && document.querySelectorAll(`#${cssEscape(el.id)}`).length === 1) {
      return `#${cssEscape(el.id)}`;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = node.localName;
      if (node.id && document.querySelectorAll(`#${cssEscape(node.id)}`).length === 1) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      const classes = Array.from(node.classList || [])
        .filter((name) => /^[a-zA-Z_-][\w-]*$/.test(name))
        .slice(0, 2);
      if (classes.length) part += classes.map((name) => `.${cssEscape(name)}`).join("");
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.localName === node.localName,
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };

  const buildXPath = (el) => {
    const segments = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.localName === node.localName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      segments.unshift(`${node.localName}[${index}]`);
      node = node.parentElement;
    }
    return `/${segments.join("/")}`;
  };

  const accessibleName = (el) => {
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      if (squash(text)) return clip(squash(text), 200);
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(squash(aria), 200);
    if (el instanceof HTMLImageElement && el.alt) return clip(squash(el.alt), 200);
    if (
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
      el.labels &&
      el.labels.length
    ) {
      return clip(squash(el.labels[0].textContent), 200);
    }
    const title = el.getAttribute("title");
    if (title) return clip(squash(title), 200);
    if (isPassword(el)) return "";
    return clip(squash(el.innerText || el.textContent), 200);
  };

  const sanitizedHtml = (el) => {
    const clone = el.cloneNode(true);
    const scrub = (node) => {
      if (!(node instanceof Element)) return;
      if (node instanceof HTMLInputElement) {
        node.removeAttribute("value");
      }
      if (node instanceof HTMLTextAreaElement) {
        node.textContent = "";
      }
      for (const attr of Array.from(node.attributes)) {
        if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      }
    };
    scrub(clone);
    clone.querySelectorAll("*").forEach(scrub);
    clone.querySelectorAll("script,style").forEach((child) => child.remove());
    return clip(clone.outerHTML, MAX_HTML);
  };

  const describe = (el) => {
    const rect = el.getBoundingClientRect();
    const attributes = {};
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (ATTRIBUTE_ALLOWLIST.has(name) || name.startsWith("aria-")) {
        attributes[name] = clip(attr.value, 300);
      }
    }
    const style = window.getComputedStyle(el);
    const text = isPassword(el)
      ? "[masked password input]"
      : clip(squash(el.innerText || el.textContent), MAX_TEXT);
    const nearby = el.parentElement
      ? clip(squash(el.parentElement.innerText || el.parentElement.textContent), 400)
      : "";
    return {
      pageUrl: location.href,
      pageTitle: document.title,
      tagName: el.localName,
      role: el.getAttribute("role") || "",
      accessibleName: accessibleName(el),
      selector: buildSelector(el),
      xpath: buildXPath(el),
      text,
      nearbyText: isPassword(el) ? "" : nearby,
      htmlExcerpt: sanitizedHtml(el),
      attributes,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      style: {
        display: style.display,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
      },
    };
  };

  return new Promise((resolve) => {
    const root = document.documentElement;
    const overlay = document.createElement("div");
    overlay.setAttribute("data-liveagent-picker", "overlay");
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483646",
      pointerEvents: "none",
      border: "2px solid rgb(37, 99, 235)",
      background: "rgba(37, 99, 235, 0.12)",
      borderRadius: "3px",
      boxSizing: "border-box",
      display: "none",
      transition: "all 60ms ease-out",
    });
    const label = document.createElement("div");
    label.setAttribute("data-liveagent-picker", "label");
    Object.assign(label.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      padding: "2px 6px",
      font: "600 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace",
      color: "#fff",
      background: "rgb(37, 99, 235)",
      borderRadius: "3px",
      whiteSpace: "nowrap",
      display: "none",
    });
    root.appendChild(overlay);
    root.appendChild(label);

    let current = null;
    const pickable = (target) =>
      target instanceof Element && !target.hasAttribute("data-liveagent-picker") ? target : null;

    const highlight = (el) => {
      current = el;
      if (!el) {
        overlay.style.display = "none";
        label.style.display = "none";
        return;
      }
      const rect = el.getBoundingClientRect();
      Object.assign(overlay.style, {
        display: "block",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      const classes = Array.from(el.classList || []).slice(0, 2);
      label.textContent = `${el.localName}${el.id ? `#${el.id}` : ""}${
        classes.length ? `.${classes.join(".")}` : ""
      }  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
      label.style.display = "block";
      const top = rect.top >= 22 ? rect.top - 20 : rect.bottom + 4;
      label.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - 220))}px`;
      label.style.top = `${Math.max(0, top)}px`;
    };

    const block = (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const onMove = (event) => {
      highlight(pickable(event.target));
    };
    const onClick = (event) => {
      block(event);
      const target = pickable(event.target) || current;
      finish(target ? describe(target) : null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        block(event);
        finish(null);
      }
    };

    const listeners = [
      ["mousemove", onMove],
      ["mouseover", onMove],
      ["click", onClick],
      ["mousedown", block],
      ["mouseup", block],
      ["pointerdown", block],
      ["pointerup", block],
      ["keydown", onKey],
    ];
    for (const [type, handler] of listeners) {
      window.addEventListener(type, handler, true);
    }

    let done = false;
    function finish(result) {
      if (done) return;
      done = true;
      for (const [type, handler] of listeners) {
        window.removeEventListener(type, handler, true);
      }
      overlay.remove();
      label.remove();
      if (window[STATE_KEY] && window[STATE_KEY].finish === finish) {
        delete window[STATE_KEY];
      }
      resolve(result);
    }
    window[STATE_KEY] = { cancel: () => finish(null), finish };
  });
})()

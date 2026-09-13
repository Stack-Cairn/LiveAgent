(function (config) {
  if (window.__LIVEAGENT_TUNNEL__ && window.__LIVEAGENT_TUNNEL__.installed) return;
  var base = String(config.basePath || "").replace(/\/+$/, "");
  window.__LIVEAGENT_TUNNEL__ = { basePath: base, installed: true };

  function rw(input) {
    if (input == null || !base) return input;
    var raw = input instanceof URL ? input.href : String(input);
    var u;
    try {
      u = new URL(raw, location.href);
    } catch (_) {
      return input;
    }
    if (u.host !== location.host || !/^(http:|https:|ws:|wss:)$/i.test(u.protocol)) return input;
    if (u.pathname === base || u.pathname.indexOf(base + "/") === 0) return u.href;
    u.pathname = base + (u.pathname === "/" ? "/" : u.pathname);
    return u.href;
  }

  function rwWs(input) {
    var out = rw(input);
    try {
      var u = new URL(String(out), location.href);
      if (u.protocol === "http:") u.protocol = "ws:";
      if (u.protocol === "https:") u.protocol = "wss:";
      return u.href;
    } catch (_) {
      return out;
    }
  }

  if (window.WebSocket) {
    var NativeWebSocket = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      return new NativeWebSocket(rwWs(url), protocols);
    };
    window.WebSocket.prototype = NativeWebSocket.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
      window.WebSocket[k] = NativeWebSocket[k];
    });
  }
  if (window.EventSource) {
    var NativeEventSource = window.EventSource;
    window.EventSource = function (url, options) {
      return new NativeEventSource(rw(url), options);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }
  if (window.fetch) {
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (input instanceof Request) return nativeFetch(new Request(rw(input.url), input), init);
      return nativeFetch(rw(input), init);
    };
  }
  if (window.XMLHttpRequest) {
    var open = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      arguments[1] = rw(url);
      return open.apply(this, arguments);
    };
  }

  // Dynamic script/link requests are issued by the browser's resource loader,
  // not window.fetch. Rewrite synchronously before invoking native setters;
  // a MutationObserver runs too late to prevent a request to the gateway root.
  function resourceURL(value) {
    // Preserve relative URLs, external origins, non-HTTP schemes and typed
    // values (e.g. TrustedScriptURL) instead of bypassing their native checks.
    if (typeof value !== "string" || !base) return value;
    var raw = value.trim();
    if (!/^(\/|https?:\/\/)/i.test(raw)) return value;
    var u;
    try {
      u = new URL(raw, document.baseURI);
    } catch (_) {
      return value;
    }
    if (u.origin !== location.origin) return value;
    if (u.pathname === base || u.pathname.indexOf(base + "/") === 0) return value;
    return rw(u.href);
  }

  function resourceAttribute(element) {
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") return "";
    if (element.localName === "script") return "src";
    if (element.localName === "link") return "href";
    return "";
  }

  function patchURLSetter(constructor, property) {
    if (!constructor) return;
    var prototype = constructor.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor || !descriptor.set || !descriptor.configurable) return;
    var nativeSet = descriptor.set;
    descriptor.set = function (value) {
      return nativeSet.call(this, resourceURL(value));
    };
    Object.defineProperty(prototype, property, descriptor);
  }
  patchURLSetter(window.HTMLScriptElement, "src");
  patchURLSetter(window.HTMLLinkElement, "href");

  var nativeSetAttribute = Element.prototype.setAttribute;
  var nativeGetAttribute = Element.prototype.getAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (typeof name === "string" && name.toLowerCase() === resourceAttribute(this)) {
      value = resourceURL(value);
    }
    return nativeSetAttribute.call(this, name, value);
  };
  var nativeSetAttributeNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (namespace, name, value) {
    if ((namespace == null || namespace === "") && name === resourceAttribute(this)) {
      value = resourceURL(value);
    }
    return nativeSetAttributeNS.call(this, namespace, name, value);
  };

  // Clones and nodes parsed in a detached fragment can bypass the setters.
  // Normalize their resource attributes before insertion starts loading them.
  function rewriteElement(element) {
    var attribute = resourceAttribute(element);
    if (!attribute) return;
    var value = nativeGetAttribute.call(element, attribute);
    var rewritten = resourceURL(value);
    if (rewritten !== value) nativeSetAttribute.call(element, attribute, rewritten);
  }
  function rewriteTree(node) {
    if (!node || typeof node !== "object") return;
    if (node.nodeType === 1) rewriteElement(node);
    if ((node.nodeType === 1 || node.nodeType === 11) && node.querySelectorAll) {
      node.querySelectorAll("script[src],link[href]").forEach(rewriteElement);
    }
  }
  function patchInsertion(prototype, name, allArguments) {
    if (!prototype || typeof prototype[name] !== "function") return;
    var native = prototype[name];
    prototype[name] = function () {
      var count = allArguments ? arguments.length : Math.min(arguments.length, 1);
      for (var i = 0; i < count; i++) rewriteTree(arguments[i]);
      return native.apply(this, arguments);
    };
  }
  ["appendChild", "insertBefore", "replaceChild"].forEach(function (name) {
    patchInsertion(Node.prototype, name, false);
  });
  [Element.prototype, Document.prototype, DocumentFragment.prototype].forEach(function (prototype) {
    ["append", "prepend", "replaceChildren"].forEach(function (name) {
      patchInsertion(prototype, name, true);
    });
  });
  [Element.prototype, CharacterData.prototype, DocumentType.prototype].forEach(function (prototype) {
    ["before", "after", "replaceWith"].forEach(function (name) {
      patchInsertion(prototype, name, true);
    });
  });
  patchInsertion(Element.prototype, "insertAdjacentElement", true);
})

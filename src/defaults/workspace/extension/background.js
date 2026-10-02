var browserPolyfill$1 = { exports: {} }, browserPolyfill = browserPolyfill$1.exports, hasRequiredBrowserPolyfill;
function requireBrowserPolyfill() {
  return hasRequiredBrowserPolyfill || (hasRequiredBrowserPolyfill = 1, (function(e, t) {
    (function(s, o) {
      o(e);
    })(typeof globalThis < "u" ? globalThis : typeof self < "u" ? self : browserPolyfill, function(s) {
      if (!(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id))
        throw new Error("This script should only be loaded in a browser extension.");
      if (globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.id)
        s.exports = globalThis.browser;
      else {
        const o = "The message port closed before a response was received.", n = (a) => {
          const r = {
            alarms: {
              clear: {
                minArgs: 0,
                maxArgs: 1
              },
              clearAll: {
                minArgs: 0,
                maxArgs: 0
              },
              get: {
                minArgs: 0,
                maxArgs: 1
              },
              getAll: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            bookmarks: {
              create: {
                minArgs: 1,
                maxArgs: 1
              },
              get: {
                minArgs: 1,
                maxArgs: 1
              },
              getChildren: {
                minArgs: 1,
                maxArgs: 1
              },
              getRecent: {
                minArgs: 1,
                maxArgs: 1
              },
              getSubTree: {
                minArgs: 1,
                maxArgs: 1
              },
              getTree: {
                minArgs: 0,
                maxArgs: 0
              },
              move: {
                minArgs: 2,
                maxArgs: 2
              },
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              removeTree: {
                minArgs: 1,
                maxArgs: 1
              },
              search: {
                minArgs: 1,
                maxArgs: 1
              },
              update: {
                minArgs: 2,
                maxArgs: 2
              }
            },
            browserAction: {
              disable: {
                minArgs: 0,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              enable: {
                minArgs: 0,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              getBadgeBackgroundColor: {
                minArgs: 1,
                maxArgs: 1
              },
              getBadgeText: {
                minArgs: 1,
                maxArgs: 1
              },
              getPopup: {
                minArgs: 1,
                maxArgs: 1
              },
              getTitle: {
                minArgs: 1,
                maxArgs: 1
              },
              openPopup: {
                minArgs: 0,
                maxArgs: 0
              },
              setBadgeBackgroundColor: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              setBadgeText: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              setIcon: {
                minArgs: 1,
                maxArgs: 1
              },
              setPopup: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              setTitle: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              }
            },
            browsingData: {
              remove: {
                minArgs: 2,
                maxArgs: 2
              },
              removeCache: {
                minArgs: 1,
                maxArgs: 1
              },
              removeCookies: {
                minArgs: 1,
                maxArgs: 1
              },
              removeDownloads: {
                minArgs: 1,
                maxArgs: 1
              },
              removeFormData: {
                minArgs: 1,
                maxArgs: 1
              },
              removeHistory: {
                minArgs: 1,
                maxArgs: 1
              },
              removeLocalStorage: {
                minArgs: 1,
                maxArgs: 1
              },
              removePasswords: {
                minArgs: 1,
                maxArgs: 1
              },
              removePluginData: {
                minArgs: 1,
                maxArgs: 1
              },
              settings: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            commands: {
              getAll: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            contextMenus: {
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              removeAll: {
                minArgs: 0,
                maxArgs: 0
              },
              update: {
                minArgs: 2,
                maxArgs: 2
              }
            },
            cookies: {
              get: {
                minArgs: 1,
                maxArgs: 1
              },
              getAll: {
                minArgs: 1,
                maxArgs: 1
              },
              getAllCookieStores: {
                minArgs: 0,
                maxArgs: 0
              },
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              set: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            devtools: {
              inspectedWindow: {
                eval: {
                  minArgs: 1,
                  maxArgs: 2,
                  singleCallbackArg: !1
                }
              },
              panels: {
                create: {
                  minArgs: 3,
                  maxArgs: 3,
                  singleCallbackArg: !0
                },
                elements: {
                  createSidebarPane: {
                    minArgs: 1,
                    maxArgs: 1
                  }
                }
              }
            },
            downloads: {
              cancel: {
                minArgs: 1,
                maxArgs: 1
              },
              download: {
                minArgs: 1,
                maxArgs: 1
              },
              erase: {
                minArgs: 1,
                maxArgs: 1
              },
              getFileIcon: {
                minArgs: 1,
                maxArgs: 2
              },
              open: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              pause: {
                minArgs: 1,
                maxArgs: 1
              },
              removeFile: {
                minArgs: 1,
                maxArgs: 1
              },
              resume: {
                minArgs: 1,
                maxArgs: 1
              },
              search: {
                minArgs: 1,
                maxArgs: 1
              },
              show: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              }
            },
            extension: {
              isAllowedFileSchemeAccess: {
                minArgs: 0,
                maxArgs: 0
              },
              isAllowedIncognitoAccess: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            history: {
              addUrl: {
                minArgs: 1,
                maxArgs: 1
              },
              deleteAll: {
                minArgs: 0,
                maxArgs: 0
              },
              deleteRange: {
                minArgs: 1,
                maxArgs: 1
              },
              deleteUrl: {
                minArgs: 1,
                maxArgs: 1
              },
              getVisits: {
                minArgs: 1,
                maxArgs: 1
              },
              search: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            i18n: {
              detectLanguage: {
                minArgs: 1,
                maxArgs: 1
              },
              getAcceptLanguages: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            identity: {
              launchWebAuthFlow: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            idle: {
              queryState: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            management: {
              get: {
                minArgs: 1,
                maxArgs: 1
              },
              getAll: {
                minArgs: 0,
                maxArgs: 0
              },
              getSelf: {
                minArgs: 0,
                maxArgs: 0
              },
              setEnabled: {
                minArgs: 2,
                maxArgs: 2
              },
              uninstallSelf: {
                minArgs: 0,
                maxArgs: 1
              }
            },
            notifications: {
              clear: {
                minArgs: 1,
                maxArgs: 1
              },
              create: {
                minArgs: 1,
                maxArgs: 2
              },
              getAll: {
                minArgs: 0,
                maxArgs: 0
              },
              getPermissionLevel: {
                minArgs: 0,
                maxArgs: 0
              },
              update: {
                minArgs: 2,
                maxArgs: 2
              }
            },
            pageAction: {
              getPopup: {
                minArgs: 1,
                maxArgs: 1
              },
              getTitle: {
                minArgs: 1,
                maxArgs: 1
              },
              hide: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              setIcon: {
                minArgs: 1,
                maxArgs: 1
              },
              setPopup: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              setTitle: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              show: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              }
            },
            permissions: {
              contains: {
                minArgs: 1,
                maxArgs: 1
              },
              getAll: {
                minArgs: 0,
                maxArgs: 0
              },
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              request: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            runtime: {
              getBackgroundPage: {
                minArgs: 0,
                maxArgs: 0
              },
              getPlatformInfo: {
                minArgs: 0,
                maxArgs: 0
              },
              openOptionsPage: {
                minArgs: 0,
                maxArgs: 0
              },
              requestUpdateCheck: {
                minArgs: 0,
                maxArgs: 0
              },
              sendMessage: {
                minArgs: 1,
                maxArgs: 3
              },
              sendNativeMessage: {
                minArgs: 2,
                maxArgs: 2
              },
              setUninstallURL: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            sessions: {
              getDevices: {
                minArgs: 0,
                maxArgs: 1
              },
              getRecentlyClosed: {
                minArgs: 0,
                maxArgs: 1
              },
              restore: {
                minArgs: 0,
                maxArgs: 1
              }
            },
            storage: {
              local: {
                clear: {
                  minArgs: 0,
                  maxArgs: 0
                },
                get: {
                  minArgs: 0,
                  maxArgs: 1
                },
                getBytesInUse: {
                  minArgs: 0,
                  maxArgs: 1
                },
                remove: {
                  minArgs: 1,
                  maxArgs: 1
                },
                set: {
                  minArgs: 1,
                  maxArgs: 1
                }
              },
              managed: {
                get: {
                  minArgs: 0,
                  maxArgs: 1
                },
                getBytesInUse: {
                  minArgs: 0,
                  maxArgs: 1
                }
              },
              sync: {
                clear: {
                  minArgs: 0,
                  maxArgs: 0
                },
                get: {
                  minArgs: 0,
                  maxArgs: 1
                },
                getBytesInUse: {
                  minArgs: 0,
                  maxArgs: 1
                },
                remove: {
                  minArgs: 1,
                  maxArgs: 1
                },
                set: {
                  minArgs: 1,
                  maxArgs: 1
                }
              }
            },
            tabs: {
              captureVisibleTab: {
                minArgs: 0,
                maxArgs: 2
              },
              create: {
                minArgs: 1,
                maxArgs: 1
              },
              detectLanguage: {
                minArgs: 0,
                maxArgs: 1
              },
              discard: {
                minArgs: 0,
                maxArgs: 1
              },
              duplicate: {
                minArgs: 1,
                maxArgs: 1
              },
              executeScript: {
                minArgs: 1,
                maxArgs: 2
              },
              get: {
                minArgs: 1,
                maxArgs: 1
              },
              getCurrent: {
                minArgs: 0,
                maxArgs: 0
              },
              getZoom: {
                minArgs: 0,
                maxArgs: 1
              },
              getZoomSettings: {
                minArgs: 0,
                maxArgs: 1
              },
              goBack: {
                minArgs: 0,
                maxArgs: 1
              },
              goForward: {
                minArgs: 0,
                maxArgs: 1
              },
              highlight: {
                minArgs: 1,
                maxArgs: 1
              },
              insertCSS: {
                minArgs: 1,
                maxArgs: 2
              },
              move: {
                minArgs: 2,
                maxArgs: 2
              },
              query: {
                minArgs: 1,
                maxArgs: 1
              },
              reload: {
                minArgs: 0,
                maxArgs: 2
              },
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              removeCSS: {
                minArgs: 1,
                maxArgs: 2
              },
              sendMessage: {
                minArgs: 2,
                maxArgs: 3
              },
              setZoom: {
                minArgs: 1,
                maxArgs: 2
              },
              setZoomSettings: {
                minArgs: 1,
                maxArgs: 2
              },
              update: {
                minArgs: 1,
                maxArgs: 2
              }
            },
            topSites: {
              get: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            webNavigation: {
              getAllFrames: {
                minArgs: 1,
                maxArgs: 1
              },
              getFrame: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            webRequest: {
              handlerBehaviorChanged: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            windows: {
              create: {
                minArgs: 0,
                maxArgs: 1
              },
              get: {
                minArgs: 1,
                maxArgs: 2
              },
              getAll: {
                minArgs: 0,
                maxArgs: 1
              },
              getCurrent: {
                minArgs: 0,
                maxArgs: 1
              },
              getLastFocused: {
                minArgs: 0,
                maxArgs: 1
              },
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              update: {
                minArgs: 2,
                maxArgs: 2
              }
            }
          };
          if (Object.keys(r).length === 0)
            throw new Error("api-metadata.json has not been included in browser-polyfill");
          class i extends WeakMap {
            constructor(p, E = void 0) {
              super(E), this.createItem = p;
            }
            get(p) {
              return this.has(p) || this.set(p, this.createItem(p)), super.get(p);
            }
          }
          const c = (h) => h && typeof h == "object" && typeof h.then == "function", d = (h, p) => (...E) => {
            a.runtime.lastError ? h.reject(new Error(a.runtime.lastError.message)) : p.singleCallbackArg || E.length <= 1 && p.singleCallbackArg !== !1 ? h.resolve(E[0]) : h.resolve(E);
          }, m = (h) => h == 1 ? "argument" : "arguments", l = (h, p) => function(S, ...y) {
            if (y.length < p.minArgs)
              throw new Error(`Expected at least ${p.minArgs} ${m(p.minArgs)} for ${h}(), got ${y.length}`);
            if (y.length > p.maxArgs)
              throw new Error(`Expected at most ${p.maxArgs} ${m(p.maxArgs)} for ${h}(), got ${y.length}`);
            return new Promise((C, O) => {
              if (p.fallbackToNoCallback)
                try {
                  S[h](...y, d({
                    resolve: C,
                    reject: O
                  }, p));
                } catch (w) {
                  console.warn(`${h} API method doesn't seem to support the callback parameter, falling back to call it without a callback: `, w), S[h](...y), p.fallbackToNoCallback = !1, p.noCallback = !0, C();
                }
              else p.noCallback ? (S[h](...y), C()) : S[h](...y, d({
                resolve: C,
                reject: O
              }, p));
            });
          }, u = (h, p, E) => new Proxy(p, {
            apply(S, y, C) {
              return E.call(y, h, ...C);
            }
          });
          let g = Function.call.bind(Object.prototype.hasOwnProperty);
          const f = (h, p = {}, E = {}) => {
            let S = /* @__PURE__ */ Object.create(null), y = {
              has(O, w) {
                return w in h || w in S;
              },
              get(O, w, T) {
                if (w in S)
                  return S[w];
                if (!(w in h))
                  return;
                let _ = h[w];
                if (typeof _ == "function")
                  if (typeof p[w] == "function")
                    _ = u(h, h[w], p[w]);
                  else if (g(E, w)) {
                    let D = l(w, E[w]);
                    _ = u(h, h[w], D);
                  } else
                    _ = _.bind(h);
                else if (typeof _ == "object" && _ !== null && (g(p, w) || g(E, w)))
                  _ = f(_, p[w], E[w]);
                else if (g(E, "*"))
                  _ = f(_, p[w], E["*"]);
                else
                  return Object.defineProperty(S, w, {
                    configurable: !0,
                    enumerable: !0,
                    get() {
                      return h[w];
                    },
                    set(D) {
                      h[w] = D;
                    }
                  }), _;
                return S[w] = _, _;
              },
              set(O, w, T, _) {
                return w in S ? S[w] = T : h[w] = T, !0;
              },
              defineProperty(O, w, T) {
                return Reflect.defineProperty(S, w, T);
              },
              deleteProperty(O, w) {
                return Reflect.deleteProperty(S, w);
              }
            }, C = Object.create(h);
            return new Proxy(C, y);
          }, R = (h) => ({
            addListener(p, E, ...S) {
              p.addListener(h.get(E), ...S);
            },
            hasListener(p, E) {
              return p.hasListener(h.get(E));
            },
            removeListener(p, E) {
              p.removeListener(h.get(E));
            }
          }), A = new i((h) => typeof h != "function" ? h : function(E) {
            const S = f(E, {}, {
              getContent: {
                minArgs: 0,
                maxArgs: 0
              }
            });
            h(S);
          }), b = new i((h) => typeof h != "function" ? h : function(E, S, y) {
            let C = !1, O, w = new Promise((x) => {
              O = function(W) {
                C = !0, x(W);
              };
            }), T;
            try {
              T = h(E, S, O);
            } catch (x) {
              T = Promise.reject(x);
            }
            const _ = T !== !0 && c(T);
            if (T !== !0 && !_ && !C)
              return !1;
            const D = (x) => {
              x.then((W) => {
                y(W);
              }, (W) => {
                let M;
                W && (W instanceof Error || typeof W.message == "string") ? M = W.message : M = "An unexpected error occurred", y({
                  __mozWebExtensionPolyfillReject__: !0,
                  message: M
                });
              }).catch((W) => {
                console.error("Failed to send onMessage rejected reply", W);
              });
            };
            return D(_ ? T : w), !0;
          }), I = ({
            reject: h,
            resolve: p
          }, E) => {
            a.runtime.lastError ? a.runtime.lastError.message === o ? p() : h(new Error(a.runtime.lastError.message)) : E && E.__mozWebExtensionPolyfillReject__ ? h(new Error(E.message)) : p(E);
          }, P = (h, p, E, ...S) => {
            if (S.length < p.minArgs)
              throw new Error(`Expected at least ${p.minArgs} ${m(p.minArgs)} for ${h}(), got ${S.length}`);
            if (S.length > p.maxArgs)
              throw new Error(`Expected at most ${p.maxArgs} ${m(p.maxArgs)} for ${h}(), got ${S.length}`);
            return new Promise((y, C) => {
              const O = I.bind(null, {
                resolve: y,
                reject: C
              });
              S.push(O), E.sendMessage(...S);
            });
          }, N = {
            devtools: {
              network: {
                onRequestFinished: R(A)
              }
            },
            runtime: {
              onMessage: R(b),
              onMessageExternal: R(b),
              sendMessage: P.bind(null, "sendMessage", {
                minArgs: 1,
                maxArgs: 3
              })
            },
            tabs: {
              sendMessage: P.bind(null, "sendMessage", {
                minArgs: 2,
                maxArgs: 3
              })
            }
          }, v = {
            clear: {
              minArgs: 1,
              maxArgs: 1
            },
            get: {
              minArgs: 1,
              maxArgs: 1
            },
            set: {
              minArgs: 1,
              maxArgs: 1
            }
          };
          return r.privacy = {
            network: {
              "*": v
            },
            services: {
              "*": v
            },
            websites: {
              "*": v
            }
          }, f(a, N, r);
        };
        s.exports = n(chrome);
      }
    });
  })(browserPolyfill$1)), browserPolyfill$1.exports;
}
requireBrowserPolyfill();
const DEFAULT_PORT = 23151, LOG_PREFIX = "[Wolffish]", SESSION_PARAM = "__wfSession", RECONNECT_ALARM_MINUTES = 0.5, HEARTBEAT_INTERVAL_MS = 15e3, COMMAND_TIMEOUT_MS = 3e4, CONTENT_SCRIPT_PING_TIMEOUT_MS = 500, RING_BUFFER_SIZE = 500, NETWORK_BODY_MAX_CHARS = 2e5, ACTION_NAV_START_MS = 200, ACTION_DOM_QUIET_MS = 120, ACTION_DOM_QUIET_MAX_MS = 1500, ACTION_NAV_SETTLE_MAX_MS = 5e3, OVERLAY_IDLE_MS = 2e4, OVERLAY_IDLE_ALARM_MINUTES = 0.5, OVERLAY_CURSOR_MIN_INTERVAL_MS = 16, STORAGE_KEY_OVERLAY_ENABLED = "wf:overlay-enabled", STORAGE_KEY_CDP_TABS = "wf:cdp-tabs", STORAGE_KEY_INUSE = "wf:inuse", STORAGE_KEY_SNAPSHOT_PREFIX = "wf:snap:", BRIDGE_TOKEN_FILE = "bridge-token.json", WolffishCommands = {
  // Navigation
  BROWSER_NAVIGATE: "browser_navigate",
  BROWSER_BACK: "browser_back",
  BROWSER_FORWARD: "browser_forward",
  BROWSER_RELOAD: "browser_reload",
  // Page Interaction
  BROWSER_CLICK: "browser_click",
  BROWSER_TYPE: "browser_type",
  BROWSER_SELECT: "browser_select",
  BROWSER_HOVER: "browser_hover",
  BROWSER_SCROLL: "browser_scroll",
  BROWSER_FOCUS: "browser_focus",
  BROWSER_KEYPRESS: "browser_keypress",
  BROWSER_DRAG_DROP: "browser_drag_drop",
  BROWSER_FILE_UPLOAD: "browser_file_upload",
  BROWSER_SET_VALUE: "browser_set_value",
  BROWSER_SUBMIT_FORM: "browser_submit_form",
  // Page Reading
  BROWSER_READ_PAGE: "browser_read_page",
  BROWSER_QUERY_SELECTOR: "browser_query_selector",
  BROWSER_GET_ATTRIBUTE: "browser_get_attribute",
  BROWSER_GET_VALUE: "browser_get_value",
  BROWSER_GET_URL: "browser_get_url",
  BROWSER_GET_PAGE_INFO: "browser_get_page_info",
  // Tab Management
  BROWSER_TABS_LIST: "browser_tabs_list",
  BROWSER_TAB_OPEN: "browser_tab_open",
  BROWSER_TAB_CLOSE: "browser_tab_close",
  BROWSER_TAB_SWITCH: "browser_tab_switch",
  BROWSER_TAB_DUPLICATE: "browser_tab_duplicate",
  BROWSER_TAB_MOVE: "browser_tab_move",
  // Window Management
  BROWSER_WINDOWS_LIST: "browser_windows_list",
  BROWSER_WINDOW_OPEN: "browser_window_open",
  BROWSER_WINDOW_CLOSE: "browser_window_close",
  BROWSER_WINDOW_RESIZE: "browser_window_resize",
  // Screenshots & Visual
  BROWSER_SCREENSHOT: "browser_screenshot",
  BROWSER_PDF: "browser_pdf",
  // Cookies & Storage
  BROWSER_COOKIES_GET: "browser_cookies_get",
  BROWSER_COOKIES_SET: "browser_cookies_set",
  BROWSER_COOKIES_REMOVE: "browser_cookies_remove",
  BROWSER_STORAGE_GET: "browser_storage_get",
  BROWSER_STORAGE_SET: "browser_storage_set",
  // Clipboard
  BROWSER_CLIPBOARD_READ: "browser_clipboard_read",
  BROWSER_CLIPBOARD_WRITE: "browser_clipboard_write",
  // Downloads
  BROWSER_DOWNLOAD: "browser_download",
  // JavaScript Execution
  BROWSER_EXECUTE_JS: "browser_execute_js",
  // Wait & Polling
  // browser_wait is the generic entry models reach for first (it mirrors
  // the playwright capability's browser_wait): a plain sleep, or a
  // selector/navigation/network-idle wait dispatched on `type`. The
  // specific BROWSER_WAIT_FOR_* commands below remain the primary tools.
  BROWSER_WAIT: "browser_wait",
  BROWSER_WAIT_FOR: "browser_wait_for",
  BROWSER_WAIT_FOR_NAVIGATION: "browser_wait_for_navigation",
  BROWSER_WAIT_FOR_NETWORK_IDLE: "browser_wait_for_network_idle",
  // Notifications
  BROWSER_NOTIFY: "browser_notify",
  // Wolffish tab group — the label the model puts on its own workspace
  BROWSER_SET_ACTIVITY: "browser_set_activity",
  // Debugger Mode
  DEBUGGER_ATTACH: "browser_debugger_attach",
  DEBUGGER_DETACH: "browser_debugger_detach",
  DEBUGGER_STATUS: "browser_debugger_status",
  // Mouse Interaction (coordinate- or selector-based; trusted input in debugger mode)
  BROWSER_MOUSE_MOVE: "browser_mouse_move",
  BROWSER_MOUSE_CLICK: "browser_mouse_click",
  BROWSER_MOUSE_DOWN: "browser_mouse_down",
  BROWSER_MOUSE_UP: "browser_mouse_up",
  BROWSER_MOUSE_DRAG: "browser_mouse_drag",
  // Coordinate ↔ DOM bridging (read-only)
  BROWSER_ELEMENT_FROM_POINT: "browser_element_from_point",
  BROWSER_GET_INTERACTIVE_ELEMENTS: "browser_get_interactive_elements",
  // Humanize
  HUMANIZE: "browser_humanize",
  // Snapshot + uid element references (v2)
  BROWSER_TAKE_SNAPSHOT: "browser_take_snapshot",
  BROWSER_RESOLVE_UID: "browser_resolve_uid",
  BROWSER_FIND: "browser_find",
  BROWSER_FILL: "browser_fill",
  BROWSER_FILL_FORM: "browser_fill_form",
  // CDP-backed observation (v2)
  BROWSER_LIST_NETWORK_REQUESTS: "browser_list_network_requests",
  BROWSER_GET_NETWORK_REQUEST: "browser_get_network_request",
  BROWSER_LIST_CONSOLE_MESSAGES: "browser_list_console_messages",
  BROWSER_HANDLE_DIALOG: "browser_handle_dialog",
  BROWSER_EMULATE: "browser_emulate",
  // Readiness probe (v2)
  BROWSER_DOCTOR: "browser_doctor"
}, CONTENT_SCRIPT_COMMANDS = /* @__PURE__ */ new Set([
  WolffishCommands.BROWSER_CLICK,
  WolffishCommands.BROWSER_TYPE,
  WolffishCommands.BROWSER_SELECT,
  WolffishCommands.BROWSER_HOVER,
  WolffishCommands.BROWSER_SCROLL,
  WolffishCommands.BROWSER_FOCUS,
  WolffishCommands.BROWSER_KEYPRESS,
  WolffishCommands.BROWSER_DRAG_DROP,
  WolffishCommands.BROWSER_FILE_UPLOAD,
  WolffishCommands.BROWSER_SET_VALUE,
  WolffishCommands.BROWSER_SUBMIT_FORM,
  WolffishCommands.BROWSER_READ_PAGE,
  WolffishCommands.BROWSER_QUERY_SELECTOR,
  WolffishCommands.BROWSER_GET_ATTRIBUTE,
  WolffishCommands.BROWSER_GET_VALUE,
  WolffishCommands.BROWSER_GET_PAGE_INFO,
  WolffishCommands.BROWSER_STORAGE_GET,
  WolffishCommands.BROWSER_STORAGE_SET,
  WolffishCommands.BROWSER_CLIPBOARD_READ,
  WolffishCommands.BROWSER_CLIPBOARD_WRITE,
  WolffishCommands.BROWSER_WAIT_FOR,
  WolffishCommands.BROWSER_WAIT_FOR_NETWORK_IDLE,
  WolffishCommands.BROWSER_ELEMENT_FROM_POINT,
  WolffishCommands.BROWSER_GET_INTERACTIVE_ELEMENTS,
  // v2: snapshot/fill/find have a content-script (DOM) implementation that
  // is the fallback when the tab has no CDP session; the dispatcher swaps to
  // the CDP handler when one exists (see DEBUGGER_ROUTABLE_COMMANDS).
  WolffishCommands.BROWSER_TAKE_SNAPSHOT,
  WolffishCommands.BROWSER_RESOLVE_UID,
  WolffishCommands.BROWSER_FIND,
  WolffishCommands.BROWSER_FILL,
  WolffishCommands.BROWSER_FILL_FORM
]), SERVICE_WORKER_COMMANDS = /* @__PURE__ */ new Set([
  WolffishCommands.BROWSER_NAVIGATE,
  WolffishCommands.BROWSER_BACK,
  WolffishCommands.BROWSER_FORWARD,
  WolffishCommands.BROWSER_RELOAD,
  WolffishCommands.BROWSER_TABS_LIST,
  WolffishCommands.BROWSER_TAB_OPEN,
  WolffishCommands.BROWSER_TAB_CLOSE,
  WolffishCommands.BROWSER_TAB_SWITCH,
  WolffishCommands.BROWSER_TAB_DUPLICATE,
  WolffishCommands.BROWSER_TAB_MOVE,
  WolffishCommands.BROWSER_WINDOWS_LIST,
  WolffishCommands.BROWSER_WINDOW_OPEN,
  WolffishCommands.BROWSER_WINDOW_CLOSE,
  WolffishCommands.BROWSER_WINDOW_RESIZE,
  WolffishCommands.BROWSER_SCREENSHOT,
  WolffishCommands.BROWSER_PDF,
  WolffishCommands.BROWSER_COOKIES_GET,
  WolffishCommands.BROWSER_COOKIES_SET,
  WolffishCommands.BROWSER_COOKIES_REMOVE,
  WolffishCommands.BROWSER_DOWNLOAD,
  WolffishCommands.BROWSER_EXECUTE_JS,
  // Service-worker side so a bare sleep works with no page attached; the
  // selector/network-idle variants delegate to the content script.
  WolffishCommands.BROWSER_WAIT,
  WolffishCommands.BROWSER_WAIT_FOR_NAVIGATION,
  WolffishCommands.BROWSER_NOTIFY,
  WolffishCommands.BROWSER_SET_ACTIVITY,
  WolffishCommands.BROWSER_GET_URL,
  WolffishCommands.BROWSER_FILE_UPLOAD,
  WolffishCommands.DEBUGGER_ATTACH,
  WolffishCommands.DEBUGGER_DETACH,
  WolffishCommands.DEBUGGER_STATUS,
  WolffishCommands.BROWSER_MOUSE_MOVE,
  WolffishCommands.BROWSER_MOUSE_CLICK,
  WolffishCommands.BROWSER_MOUSE_DOWN,
  WolffishCommands.BROWSER_MOUSE_UP,
  WolffishCommands.BROWSER_MOUSE_DRAG,
  WolffishCommands.HUMANIZE,
  // v2: these need a CDP session and live in the service worker; without a
  // session they answer with a deterministic "needs the debugger" error.
  WolffishCommands.BROWSER_LIST_NETWORK_REQUESTS,
  WolffishCommands.BROWSER_GET_NETWORK_REQUEST,
  WolffishCommands.BROWSER_LIST_CONSOLE_MESSAGES,
  WolffishCommands.BROWSER_HANDLE_DIALOG,
  WolffishCommands.BROWSER_EMULATE,
  WolffishCommands.BROWSER_DOCTOR
]), DEBUGGER_ROUTABLE_COMMANDS = /* @__PURE__ */ new Set([
  WolffishCommands.BROWSER_CLICK,
  WolffishCommands.BROWSER_TYPE,
  WolffishCommands.BROWSER_SCROLL,
  WolffishCommands.BROWSER_HOVER,
  WolffishCommands.BROWSER_KEYPRESS,
  WolffishCommands.BROWSER_TAKE_SNAPSHOT,
  WolffishCommands.BROWSER_RESOLVE_UID,
  WolffishCommands.BROWSER_FIND,
  WolffishCommands.BROWSER_FILL,
  WolffishCommands.BROWSER_FILL_FORM,
  WolffishCommands.BROWSER_FILE_UPLOAD,
  WolffishCommands.BROWSER_SET_VALUE,
  WolffishCommands.BROWSER_GET_VALUE,
  WolffishCommands.BROWSER_FOCUS,
  WolffishCommands.BROWSER_SELECT,
  WolffishCommands.BROWSER_GET_ATTRIBUTE
]), INPUT_COMMANDS = /* @__PURE__ */ new Set([
  WolffishCommands.BROWSER_CLICK,
  WolffishCommands.BROWSER_TYPE,
  WolffishCommands.BROWSER_SELECT,
  WolffishCommands.BROWSER_HOVER,
  WolffishCommands.BROWSER_SCROLL,
  WolffishCommands.BROWSER_FOCUS,
  WolffishCommands.BROWSER_KEYPRESS,
  WolffishCommands.BROWSER_DRAG_DROP,
  WolffishCommands.BROWSER_FILE_UPLOAD,
  WolffishCommands.BROWSER_SET_VALUE,
  WolffishCommands.BROWSER_SUBMIT_FORM,
  WolffishCommands.BROWSER_FILL,
  WolffishCommands.BROWSER_FILL_FORM,
  WolffishCommands.BROWSER_MOUSE_MOVE,
  WolffishCommands.BROWSER_MOUSE_CLICK,
  WolffishCommands.BROWSER_MOUSE_DOWN,
  WolffishCommands.BROWSER_MOUSE_UP,
  WolffishCommands.BROWSER_MOUSE_DRAG,
  WolffishCommands.BROWSER_NAVIGATE,
  WolffishCommands.BROWSER_BACK,
  WolffishCommands.BROWSER_FORWARD,
  WolffishCommands.BROWSER_RELOAD,
  WolffishCommands.BROWSER_EXECUTE_JS,
  WolffishCommands.HUMANIZE
]), READ_COMMANDS = /* @__PURE__ */ new Set([
  WolffishCommands.BROWSER_READ_PAGE,
  WolffishCommands.BROWSER_QUERY_SELECTOR,
  WolffishCommands.BROWSER_GET_ATTRIBUTE,
  WolffishCommands.BROWSER_GET_VALUE,
  WolffishCommands.BROWSER_GET_URL,
  WolffishCommands.BROWSER_GET_PAGE_INFO,
  WolffishCommands.BROWSER_SCREENSHOT,
  WolffishCommands.BROWSER_PDF,
  WolffishCommands.BROWSER_STORAGE_GET,
  WolffishCommands.BROWSER_WAIT,
  WolffishCommands.BROWSER_WAIT_FOR,
  WolffishCommands.BROWSER_WAIT_FOR_NAVIGATION,
  WolffishCommands.BROWSER_WAIT_FOR_NETWORK_IDLE,
  WolffishCommands.BROWSER_ELEMENT_FROM_POINT,
  WolffishCommands.BROWSER_GET_INTERACTIVE_ELEMENTS,
  WolffishCommands.BROWSER_TAKE_SNAPSHOT,
  WolffishCommands.BROWSER_RESOLVE_UID,
  WolffishCommands.BROWSER_FIND,
  WolffishCommands.BROWSER_LIST_NETWORK_REQUESTS,
  WolffishCommands.BROWSER_GET_NETWORK_REQUEST,
  WolffishCommands.BROWSER_LIST_CONSOLE_MESSAGES
]), DIALOG_BLOCKED_COMMANDS = /* @__PURE__ */ new Set([
  ...INPUT_COMMANDS,
  WolffishCommands.BROWSER_TAKE_SNAPSHOT,
  WolffishCommands.BROWSER_FIND,
  WolffishCommands.BROWSER_READ_PAGE,
  WolffishCommands.BROWSER_SCREENSHOT
]), api$9 = globalThis.chrome ?? globalThis.browser, log = (...e) => {
  console.log(LOG_PREFIX, ...e);
}, logError = (...e) => {
  console.error(LOG_PREFIX, ...e);
}, isFirefox = () => typeof globalThis.browser < "u", sendToContentScript = async (e, t) => {
  var s;
  return (s = api$9 == null ? void 0 : api$9.tabs) == null ? void 0 : s.sendMessage(e, t);
}, pingContentScript = async (e) => {
  var t;
  try {
    const s = {
      source: "service-worker",
      target: "content-script",
      payload: { type: "ping" }
    }, o = await Promise.race([
      (t = api$9 == null ? void 0 : api$9.tabs) == null ? void 0 : t.sendMessage(e, s),
      new Promise((n, a) => setTimeout(() => a(new Error("timeout")), CONTENT_SCRIPT_PING_TIMEOUT_MS))
    ]);
    return o && o.type === "pong";
  } catch {
    return !1;
  }
}, ensureContentScriptInjected = async (e) => {
  var s;
  await pingContentScript(e) || (await ((s = api$9 == null ? void 0 : api$9.scripting) == null ? void 0 : s.executeScript({
    target: { tabId: e },
    files: ["content/all.iife.js"]
  })), await new Promise((o, n) => {
    var i, c;
    const a = setTimeout(() => n(new Error("Content script injection timed out")), 5e3), r = (d) => {
      var m, l;
      (d == null ? void 0 : d.source) === "content-script" && "type" in d.payload && d.payload.type === "pong" && (clearTimeout(a), (l = (m = api$9 == null ? void 0 : api$9.runtime) == null ? void 0 : m.onMessage) == null || l.removeListener(r), o());
    };
    (c = (i = api$9 == null ? void 0 : api$9.runtime) == null ? void 0 : i.onMessage) == null || c.addListener(r);
  }));
};
let tabFallback = null;
const setTabFallback = (e) => {
  tabFallback = e;
}, resolveTabId = async (e) => {
  var s, o;
  if (e.tabId !== void 0 && await ((s = api$9 == null ? void 0 : api$9.tabs) == null ? void 0 : s.get(e.tabId).then(() => !0).catch(() => !1)))
    return e.tabId;
  if (tabFallback)
    return tabFallback(e.__wfSession);
  const t = await ((o = api$9 == null ? void 0 : api$9.tabs) == null ? void 0 : o.query({ active: !0, currentWindow: !0 }));
  if (!(t != null && t.length))
    throw new Error("No active tab found");
  return t[0].id;
}, withTimeout = (e) => e, makeResponse = (e, t) => ({ id: e, success: !0, data: t }), makeErrorResponse = (e, t) => ({ id: e, success: !1, error: t }), generateId = () => crypto.randomUUID();
var StorageEnum;
(function(e) {
  e.Local = "local", e.Sync = "sync", e.Managed = "managed", e.Session = "session";
})(StorageEnum || (StorageEnum = {}));
var SessionAccessLevelEnum;
(function(e) {
  e.ExtensionPagesOnly = "TRUSTED_CONTEXTS", e.ExtensionPagesAndContentScripts = "TRUSTED_AND_UNTRUSTED_CONTEXTS";
})(SessionAccessLevelEnum || (SessionAccessLevelEnum = {}));
const chrome$1 = globalThis.chrome, updateCache = async (e, t) => {
  const s = (n) => typeof n == "function", o = (n) => (
    // Use ReturnType to infer the return type of the function and check if it's a Promise
    n instanceof Promise
  );
  return s(e) ? (o(e), e(t)) : e;
};
let globalSessionAccessLevelFlag = !1;
const checkStoragePermission = (e) => {
  if (chrome$1 && !chrome$1.storage[e])
    throw new Error(`"storage" permission in manifest.ts: "storage ${e}" isn't defined`);
}, createStorage = (e, t, s) => {
  var R, A;
  let o = null, n = !1, a = [];
  const r = (s == null ? void 0 : s.storageEnum) ?? StorageEnum.Local, i = ((R = s == null ? void 0 : s.serialization) == null ? void 0 : R.serialize) ?? ((b) => b), c = ((A = s == null ? void 0 : s.serialization) == null ? void 0 : A.deserialize) ?? ((b) => b);
  globalSessionAccessLevelFlag === !1 && r === StorageEnum.Session && (s == null ? void 0 : s.sessionAccessForContentScripts) === !0 && (checkStoragePermission(r), chrome$1 == null || chrome$1.storage[r].setAccessLevel({
    accessLevel: SessionAccessLevelEnum.ExtensionPagesAndContentScripts
  }).catch((b) => {
    console.error(b), console.error("Please call .setAccessLevel() into different context, like a background script.");
  }), globalSessionAccessLevelFlag = !0);
  const d = async () => {
    checkStoragePermission(r);
    const b = await (chrome$1 == null ? void 0 : chrome$1.storage[r].get([e]));
    return b ? c(b[e]) ?? t : t;
  }, m = async (b) => {
    n || (o = await d()), o = await updateCache(b, o), await (chrome$1 == null ? void 0 : chrome$1.storage[r].set({ [e]: i(o) })), g();
  }, l = (b) => (a = [...a, b], () => {
    a = a.filter((I) => I !== b);
  }), u = () => o, g = () => {
    a.forEach((b) => b());
  }, f = async (b) => {
    if (b[e] === void 0)
      return;
    const I = c(b[e].newValue);
    o !== I && (o = await updateCache(I, o), g());
  };
  return d().then((b) => {
    o = b, n = !0, g();
  }), chrome$1 == null || chrome$1.storage[r].onChanged.addListener(f), {
    get: d,
    set: m,
    getSnapshot: u,
    subscribe: l
  };
}, storage = createStorage("wolffish-connection-config", { port: 23151 }, {
  storageEnum: StorageEnum.Local
}), wolffishConnectionStorage = {
  ...storage
}, api$8 = globalThis.chrome, restrictedPageError = (e) => `Cannot attach the debugger to a browser-internal page (${e}). Browser settings pages are outside the extension's reach; use computer use for those.`, ANOTHER_DEBUGGER_ERROR = "Cannot attach debugger: DevTools or another debugger is already attached to this tab. Close DevTools on that tab and retry.", notAttachedError = (e) => `Debugger not attached to tab ${e}`, needsDebuggerError = (e) => `${e} needs the debugger. Call ext_debugger_attach first.`, sessions = /* @__PURE__ */ new Map(), DOMAINS = ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable", "DOM.enable", "Accessibility.enable"], sendCDP$1 = (e, t, s = {}) => api$8.debugger.sendCommand({ tabId: e }, t, s), stateArea$2 = () => api$8.storage.session ?? api$8.storage.local, persistTabs = async () => {
  try {
    await stateArea$2().set({ [STORAGE_KEY_CDP_TABS]: [...sessions.keys()] });
  } catch {
  }
}, snapshotCounterKey = (e) => `${STORAGE_KEY_SNAPSHOT_PREFIX}${e}`, readSnapshotCounter = async (e) => {
  try {
    const t = await stateArea$2().get(snapshotCounterKey(e)), s = t == null ? void 0 : t[snapshotCounterKey(e)];
    return typeof s == "number" ? s : 0;
  } catch {
    return 0;
  }
}, nextSnapshotId = async (e) => {
  const t = await readSnapshotCounter(e.tabId), s = Math.max(t, e.snapshotId) + 1;
  e.snapshotId = s;
  try {
    await stateArea$2().set({ [snapshotCounterKey(e.tabId)]: s });
  } catch {
  }
  return s;
}, createSession = (e) => ({
  tabId: e,
  attachedAt: Date.now(),
  loaderId: "",
  snapshotId: 0,
  hasSnapshot: !1,
  uidMap: /* @__PURE__ */ new Map(),
  uidByNode: /* @__PURE__ */ new Map(),
  snapshotNodes: [],
  dialog: null,
  network: [],
  networkById: /* @__PURE__ */ new Map(),
  navigations: 0,
  console: [],
  reqSeq: 0,
  msgSeq: 0,
  emulation: {},
  cursor: { x: 0, y: 0 }
}), enableDomains = async (e) => {
  for (const t of DOMAINS) await sendCDP$1(e, t);
}, currentLoaderId = async (e) => {
  var t, s;
  try {
    return ((s = (t = (await sendCDP$1(e, "Page.getFrameTree")).frameTree) == null ? void 0 : t.frame) == null ? void 0 : s.loaderId) ?? "";
  } catch {
    return "";
  }
}, isRestrictedUrl = (e) => !e || e === "about:blank" ? !1 : ["chrome://", "chrome-extension://", "devtools://", "edge://", "brave://", "about:"].some((s) => e.startsWith(s)) ? !0 : e.startsWith("https://chromewebstore.google.com/"), attachError = (e, t) => {
  const s = e instanceof Error ? e.message : String(e);
  return s.includes("Another debugger") ? new Error(ANOTHER_DEBUGGER_ERROR) : s.includes("Cannot access") || s.includes("chrome://") || s.includes("chrome-extension://") ? new Error(restrictedPageError(t || "unknown url")) : new Error(`Failed to attach debugger: ${s}`);
}, getSession = (e) => sessions.get(e), hasSession = (e) => sessions.has(e), requireSession = (e) => {
  const t = sessions.get(e);
  if (!t) throw new Error(notAttachedError(e));
  return t;
}, attachTab = async (e) => {
  const t = sessions.get(e);
  if (t) return t;
  const s = await api$8.tabs.get(e).catch(() => null), o = (s == null ? void 0 : s.url) ?? (s == null ? void 0 : s.pendingUrl) ?? "";
  if (isRestrictedUrl(o)) throw new Error(restrictedPageError(o));
  try {
    await api$8.debugger.attach({ tabId: e }, "1.3");
  } catch (a) {
    throw attachError(a, o);
  }
  const n = createSession(e);
  sessions.set(e, n);
  try {
    await enableDomains(e);
  } catch (a) {
    throw sessions.delete(e), await api$8.debugger.detach({ tabId: e }).catch(() => {
    }), new Error(`Failed to attach debugger: ${a instanceof Error ? a.message : String(a)}`);
  }
  return n.loaderId = await currentLoaderId(e), n.snapshotId = await readSnapshotCounter(e), await persistTabs(), log(`Debugger attached to tab ${e}`), n;
}, dropSession = async (e) => {
  sessions.delete(e) && await persistTabs();
}, detachTab = async (e) => {
  const t = e === void 0 ? [...sessions.keys()] : [e], s = [];
  for (const o of t)
    sessions.has(o) && (await api$8.debugger.detach({ tabId: o }).catch(() => {
    }), sessions.delete(o), s.push(o), log(`Debugger detached from tab ${o}`));
  return await persistTabs(), s;
}, getDebuggerState = () => {
  const e = [...sessions.keys()];
  return { attached: e.length > 0, tabId: e[0] ?? null, tabs: e };
}, dialogOpenError = (e) => {
  var s;
  const t = (s = sessions.get(e)) == null ? void 0 : s.dialog;
  return t ? `A dialog is open (${t.type}: ${t.message}). Call ext_handle_dialog to accept or dismiss it first.` : null;
}, assertNoDialog = (e) => {
  const t = dialogOpenError(e.tabId);
  if (t) throw new Error(t);
}, pushNetwork = (e, t) => {
  for (e.network.push(t), e.networkById.set(t.requestId, t); e.network.length > RING_BUFFER_SIZE; ) {
    const s = e.network.shift();
    s && e.networkById.get(s.requestId) === s && e.networkById.delete(s.requestId);
  }
}, pushConsole = (e, t) => {
  for (e.console.push(t); e.console.length > RING_BUFFER_SIZE; ) e.console.shift();
}, resetForNavigation = (e, t) => {
  e.loaderId = t, e.uidMap.clear(), e.uidByNode.clear(), e.snapshotNodes = [], e.network = e.network.filter((s) => s.loaderId === t), e.networkById.clear();
  for (const s of e.network) e.networkById.set(s.requestId, s);
  e.console = [], e.dialog = null;
}, paginate = (e, t, s) => {
  const o = e.length;
  if (!t || t <= 0) return { items: e, total: o, page: { index: 0, size: o, pages: 1 } };
  const n = Math.floor(t), a = Math.max(1, Math.ceil(o / n)), r = Math.min(Math.max(0, Math.floor(s ?? 0)), a - 1);
  return { items: e.slice(r * n, (r + 1) * n), total: o, page: { index: r, size: n, pages: a } };
}, remoteText = (e) => e.unserializableValue !== void 0 ? e.unserializableValue : e.type === "string" ? String(e.value ?? "") : e.value !== void 0 ? typeof e.value == "object" ? JSON.stringify(e.value) : String(e.value) : e.description ?? e.type, formatStack = (e) => {
  const t = (e == null ? void 0 : e.callFrames) ?? [];
  if (t.length !== 0)
    return t.map(
      (s) => `    at ${s.functionName || "<anonymous>"} (${s.url ?? ""}:${(s.lineNumber ?? 0) + 1}:${(s.columnNumber ?? 0) + 1})`
    ).join(`
`);
}, CONSOLE_TYPE_MAP = {
  log: "log",
  info: "info",
  warning: "warn",
  warn: "warn",
  error: "error",
  debug: "debug",
  verbose: "debug",
  trace: "trace",
  assert: "assert",
  dir: "dir",
  dirxml: "dir",
  table: "table"
}, consoleType = (e) => CONSOLE_TYPE_MAP[e] ?? "other", onConsoleApiCalled = (e, t) => {
  var n, a;
  const s = t, o = (a = (n = s.stackTrace) == null ? void 0 : n.callFrames) == null ? void 0 : a[0];
  pushConsole(e, {
    msgid: ++e.msgSeq,
    type: consoleType(s.type),
    text: (s.args ?? []).map(remoteText).join(" "),
    timestamp: s.timestamp,
    url: (o == null ? void 0 : o.url) || void 0,
    line: o ? (o.lineNumber ?? 0) + 1 : void 0,
    column: o ? (o.columnNumber ?? 0) + 1 : void 0,
    stack: formatStack(s.stackTrace)
  });
}, onExceptionThrown = (e, t) => {
  var a;
  const s = t, o = s.exceptionDetails, n = ((a = o.exception) == null ? void 0 : a.description) ?? (o.exception ? remoteText(o.exception) : o.text);
  pushConsole(e, {
    msgid: ++e.msgSeq,
    type: "exception",
    text: n,
    timestamp: s.timestamp,
    url: o.url,
    line: o.lineNumber !== void 0 ? o.lineNumber + 1 : void 0,
    column: o.columnNumber !== void 0 ? o.columnNumber + 1 : void 0,
    stack: formatStack(o.stackTrace)
  });
}, onLogEntry = (e, t) => {
  const o = t.entry;
  pushConsole(e, {
    msgid: ++e.msgSeq,
    type: consoleType(o.level),
    text: o.source && o.source !== "javascript" ? `[${o.source}] ${o.text}` : o.text,
    timestamp: o.timestamp,
    url: o.url,
    line: o.lineNumber !== void 0 ? o.lineNumber + 1 : void 0,
    stack: formatStack(o.stackTrace)
  });
}, onRequestWillBeSent = (e, t) => {
  const s = t, o = e.networkById.get(s.requestId);
  o && s.redirectResponse && (o.status = s.redirectResponse.status, o.statusText = s.redirectResponse.statusText, o.responseHeaders = s.redirectResponse.headers ?? {}, o.mimeType = s.redirectResponse.mimeType ?? "", o.hasResponse = !0, o.endedAt = s.timestamp), pushNetwork(e, {
    reqid: ++e.reqSeq,
    requestId: s.requestId,
    loaderId: s.loaderId ?? "",
    method: s.request.method,
    url: s.request.url,
    headers: s.request.headers ?? {},
    postData: s.request.postData,
    type: (s.type ?? "Other").toLowerCase(),
    status: null,
    statusText: "",
    responseHeaders: {},
    mimeType: "",
    size: null,
    startedAt: s.timestamp,
    endedAt: null,
    failed: !1,
    fromCache: !1,
    hasResponse: !1
  });
}, onResponseReceived = (e, t) => {
  const s = t, o = e.networkById.get(s.requestId);
  o && (o.status = s.response.status, o.statusText = s.response.statusText ?? "", o.responseHeaders = s.response.headers ?? {}, o.mimeType = s.response.mimeType ?? "", o.hasResponse = !0, s.type && (o.type = s.type.toLowerCase()), s.response.fromDiskCache && (o.fromCache = !0));
}, onLoadingFinished = (e, t) => {
  const s = t, o = e.networkById.get(s.requestId);
  o && (o.endedAt = s.timestamp, o.size = s.encodedDataLength ?? null);
}, onLoadingFailed = (e, t) => {
  const s = t, o = e.networkById.get(s.requestId);
  o && (o.endedAt = s.timestamp, o.failed = !0, s.errorText && !o.statusText && (o.statusText = s.errorText));
}, onServedFromCache = (e, t) => {
  const s = t, o = e.networkById.get(s.requestId);
  o && (o.fromCache = !0);
}, onFrameNavigated = (e, t) => {
  const s = t;
  s.frame.parentId || (e.navigations += 1, resetForNavigation(e, s.frame.loaderId));
}, onDialogOpening = (e, t) => {
  const s = t;
  e.dialog = { type: s.type, message: s.message, defaultPrompt: s.defaultPrompt ?? "", url: s.url };
}, EVENT_HANDLERS = {
  "Page.javascriptDialogOpening": onDialogOpening,
  "Page.javascriptDialogClosed": (e) => {
    e.dialog = null;
  },
  "Page.frameNavigated": onFrameNavigated,
  "Network.requestWillBeSent": onRequestWillBeSent,
  "Network.responseReceived": onResponseReceived,
  "Network.loadingFinished": onLoadingFinished,
  "Network.loadingFailed": onLoadingFailed,
  "Network.requestServedFromCache": onServedFromCache,
  "Runtime.consoleAPICalled": onConsoleApiCalled,
  "Runtime.exceptionThrown": onExceptionThrown,
  "Log.entryAdded": onLogEntry
};
api$8.debugger.onEvent.addListener((e, t, s) => {
  if (e.tabId === void 0) return;
  const o = sessions.get(e.tabId);
  if (!o) return;
  const n = EVENT_HANDLERS[t];
  n && n(o, s ?? {});
});
api$8.debugger.onDetach.addListener((e, t) => {
  e.tabId === void 0 || !sessions.has(e.tabId) || (log(`Debugger detached from tab ${e.tabId}: ${t}`), dropSession(e.tabId));
});
api$8.tabs.onRemoved.addListener((e) => {
  sessions.has(e) && (log(`Attached tab ${e} was closed`), dropSession(e));
});
const restoreSessions = async () => {
  try {
    const e = await stateArea$2().get(STORAGE_KEY_CDP_TABS), t = (e == null ? void 0 : e[STORAGE_KEY_CDP_TABS]) ?? [];
    if (t.length === 0) return;
    const s = await api$8.debugger.getTargets(), o = new Set(s.filter((n) => n.attached && typeof n.tabId == "number").map((n) => n.tabId));
    for (const n of t) {
      if (!o.has(n) || sessions.has(n)) continue;
      const a = createSession(n);
      sessions.set(n, a);
      try {
        await enableDomains(n), a.loaderId = await currentLoaderId(n), a.snapshotId = await readSnapshotCounter(n), log(`Debugger session restored for tab ${n}`);
      } catch {
        sessions.delete(n);
      }
    }
  } catch (e) {
    log("Debugger session restore failed:", e instanceof Error ? e.message : String(e));
  } finally {
    await persistTabs();
  }
}, sessionsReady = restoreSessions(), exceptionMessage = (e) => {
  var o, n;
  const t = ((o = e.exception) == null ? void 0 : o.description) ?? (((n = e.exception) == null ? void 0 : n.value) !== void 0 ? String(e.exception.value) : e.text);
  return String(t).split(`
`)[0].replace(/^(Error|TypeError|RangeError|SyntaxError|ReferenceError|DOMException): /, "");
}, unwrap = (e) => {
  if (e.exceptionDetails) throw new Error(exceptionMessage(e.exceptionDetails));
  const t = e.result;
  return t.unserializableValue !== void 0 ? t.unserializableValue : t.value !== void 0 ? t.value : t.type === "undefined" || t.subtype === "null" ? t.subtype === "null" ? null : void 0 : t.description;
}, resolveObjectId = async (e, t) => {
  const s = await sendCDP$1(e, "DOM.resolveNode", { backendNodeId: t });
  if (!s.object.objectId) throw new Error("No node with given id found");
  return s.object.objectId;
}, releaseObject = (e, t) => {
  sendCDP$1(e, "Runtime.releaseObject", { objectId: t }).catch(() => {
  });
}, callOnNode = async (e, t, s, o = []) => {
  const n = await resolveObjectId(e, t);
  try {
    const a = await sendCDP$1(e, "Runtime.callFunctionOn", {
      objectId: n,
      functionDeclaration: `function(...args) { return (${s.toString()})(this, ...args); }`,
      arguments: o.map((r) => ({ value: r })),
      returnByValue: !0,
      awaitPromise: !0
    });
    return unwrap(a);
  } finally {
    releaseObject(e, n);
  }
}, findBySelectorInPage = (e) => {
  const t = (o) => o.replace(/\s+/g, " ").trim().toLowerCase(), s = (o) => {
    if (o.offsetParent !== null) return !0;
    const n = getComputedStyle(o);
    return n.display !== "none" && n.visibility !== "hidden";
  };
  if (e.startsWith("text=")) {
    const o = t(e.slice(5).replace(/^(["'])([\s\S]*)\1$/, "$2"));
    if (!o) return null;
    const n = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "WOLFFISH-OVERLAY"]), a = [], r = [], i = document.body ? Array.from(document.body.getElementsByTagName("*")) : [];
    for (const m of i) {
      const l = m;
      if (n.has(l.tagName)) continue;
      const u = t(l.textContent ?? "");
      !u || u.length > o.length + 200 || (u === o ? a.push(l) : u.includes(o) && r.push(l));
    }
    const c = a.length > 0 ? a : r;
    return c.filter((m) => !c.some((l) => l !== m && m.contains(l))).find(s) ?? null;
  }
  try {
    return document.querySelector(e);
  } catch {
    throw new Error(
      `selector syntax is incorrect: '${e}' is not valid CSS. Use a CSS selector, or text=<visible text> to target by text.`
    );
  }
}, resolveSelectorNode = async (e, t) => {
  const s = await sendCDP$1(e, "Runtime.evaluate", {
    expression: `(${findBySelectorInPage.toString()})(${JSON.stringify(t)})`,
    returnByValue: !1
  });
  if (s.exceptionDetails) throw new Error(exceptionMessage(s.exceptionDetails));
  const o = s.result.objectId;
  if (!o || s.result.subtype === "null") throw new Error(`Element not found: ${t}`);
  try {
    return (await sendCDP$1(e, "DOM.describeNode", { objectId: o })).node.backendNodeId;
  } finally {
    releaseObject(e, o);
  }
}, quadToRect = (e) => {
  const t = [e[0], e[2], e[4], e[6]], s = [e[1], e[3], e[5], e[7]], o = Math.min(...t), n = Math.min(...s);
  return { x: o, y: n, width: Math.max(...t) - o, height: Math.max(...s) - n };
}, rectFromPage = (e) => {
  const t = e.getBoundingClientRect();
  return { x: t.left, y: t.top, width: t.width, height: t.height };
}, nodeRect = async (e, t) => {
  try {
    const s = await sendCDP$1(e, "DOM.getBoxModel", { backendNodeId: t });
    return quadToRect(s.model.content);
  } catch {
    return callOnNode(e, t, rectFromPage);
  }
}, scrollNodeIntoView = async (e, t) => {
  try {
    await sendCDP$1(e, "DOM.scrollIntoViewIfNeeded", { backendNodeId: t });
  } catch (s) {
    const o = s instanceof Error ? s.message : String(s);
    if (/no node|not found|could not find/i.test(o)) throw s;
    await callOnNode(
      e,
      t,
      (n) => n.scrollIntoView({ block: "center", inline: "nearest" })
    ).catch(() => {
    });
  }
}, center = (e) => ({
  x: Math.round(e.x + e.width / 2),
  y: Math.round(e.y + e.height / 2)
}), focusInPage = (e) => e.focus(), nodeHrefInPage = (e) => {
  var t;
  return ((t = e.closest("a")) == null ? void 0 : t.href) || null;
}, nodeInfoInPage = (e) => ({
  tag: e.tagName.toLowerCase(),
  id: e.id || "",
  ariaLabel: e.getAttribute("aria-label") || ""
}), clearInPage = (e) => {
  var t;
  if (e.focus(), e.tagName === "INPUT" || e.tagName === "TEXTAREA") {
    const s = e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, o = (t = Object.getOwnPropertyDescriptor(s, "value")) == null ? void 0 : t.set;
    o ? o.call(e, "") : e.value = "", e.dispatchEvent(new Event("input", { bubbles: !0 }));
  } else e.isContentEditable && (document.execCommand("selectAll", !1), document.execCommand("delete", !1));
}, setValueInPage = (e, t) => {
  var s;
  if (e.focus(), e.tagName === "INPUT" || e.tagName === "TEXTAREA") {
    const o = e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, n = (s = Object.getOwnPropertyDescriptor(o, "value")) == null ? void 0 : s.set;
    n ? n.call(e, t) : e.value = t, e.dispatchEvent(new Event("input", { bubbles: !0 })), e.dispatchEvent(new Event("change", { bubbles: !0 }));
  } else if (e.isContentEditable)
    document.execCommand("selectAll", !1), document.execCommand("insertText", !1, t), e.dispatchEvent(new Event("input", { bubbles: !0 }));
  else
    throw new Error(`Element is not an input, textarea, or contenteditable: <${e.tagName.toLowerCase()}>`);
  return { success: !0, value: t };
}, getValueInPage = (e) => ({
  value: e.value ?? "",
  type: e.type || e.tagName.toLowerCase()
}), getAttributesInPage = (e, t) => {
  const s = {};
  for (const o of t) s[o] = e.getAttribute(o);
  return s;
}, selectInPage = (e, t) => {
  if (e.tagName !== "SELECT") throw new Error(`Element is not a <select>: <${e.tagName.toLowerCase()}>`);
  return e.value = t, e.dispatchEvent(new Event("input", { bubbles: !0 })), e.dispatchEvent(new Event("change", { bubbles: !0 })), { success: !0 };
}, fillInPage = (e, t) => {
  var n;
  const s = e.tagName, o = (a) => {
    e.dispatchEvent(new Event(a, { bubbles: !0 }));
  };
  if (e.focus(), s === "SELECT") {
    const a = e, r = t.trim().toLowerCase(), i = Array.from(a.options).find(
      (c) => c.value.trim().toLowerCase() === r || (c.textContent ?? "").trim().toLowerCase() === r
    );
    if (!i) throw new Error(`No option matches "${t}" in the <select>.`);
    return a.value = i.value, o("input"), o("change"), { success: !0, value: i.value, kind: "select" };
  }
  if (s === "INPUT" && (e.type === "checkbox" || e.type === "radio")) {
    if (t !== "true" && t !== "false") throw new Error('Checkbox/radio values must be "true" or "false".');
    const a = e, r = a.type === "checkbox" ? "checkbox" : "radio";
    return a.checked !== (t === "true") && (a.click(), a.checked !== (t === "true") && (a.checked = t === "true", o("input"), o("change"))), { success: !0, value: t, kind: r };
  }
  if (s === "INPUT" || s === "TEXTAREA") {
    const a = s === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, r = (n = Object.getOwnPropertyDescriptor(a, "value")) == null ? void 0 : n.set;
    return r ? r.call(e, t) : e.value = t, o("input"), o("change"), { success: !0, value: t, kind: s === "TEXTAREA" ? "textarea" : "input" };
  }
  if (e.isContentEditable)
    return document.execCommand("selectAll", !1), document.execCommand("insertText", !1, t), o("input"), { success: !0, value: t, kind: "contenteditable" };
  throw new Error(`Element is not fillable (tag <${s.toLowerCase()}>).`);
}, isFileInputInPage = (e) => e.tagName === "INPUT" && e.type === "file", setFilesInPage = (e, t) => {
  const s = new DataTransfer();
  for (const o of t) {
    const n = atob(o.content), a = new Uint8Array(n.length);
    for (let r = 0; r < n.length; r++) a[r] = n.charCodeAt(r);
    s.items.add(new File([a], o.name, { type: o.mimeType }));
  }
  return e.files = s.files, e.dispatchEvent(new Event("input", { bubbles: !0 })), e.dispatchEvent(new Event("change", { bubbles: !0 })), t.length;
}, anchorClickInPage = (e) => {
  const t = e.closest("a");
  t && t.click();
}, gaussianRandom = (e, t) => {
  let s = 0, o = 0;
  for (; s === 0; ) s = Math.random();
  for (; o === 0; ) o = Math.random();
  const n = Math.sqrt(-2 * Math.log(s)) * Math.cos(2 * Math.PI * o);
  return Math.round(e + n * t);
}, clamp = (e, t, s) => Math.max(t, Math.min(s, e)), gaussianDelay = (e, t, s) => {
  const o = s ?? (e + t) / 2, n = (t - e) / 4;
  return clamp(gaussianRandom(o, n), e, t);
}, sleep$1 = (e) => new Promise((t) => setTimeout(t, e)), overlayHooks = {
  beforeCapture: async (e) => {
  },
  afterCapture: async (e) => {
  },
  cursor: async (e, t, s, o, n) => {
  },
  pulse: async (e) => {
  },
  target: async (e, t) => {
  }
}, lastCursorPost = /* @__PURE__ */ new Map(), postCursor = (e, t, s, o, n, a) => {
  const r = Date.now(), i = lastCursorPost.get(e) ?? 0;
  !o && r - i < OVERLAY_CURSOR_MIN_INTERVAL_MS || (lastCursorPost.set(e, r), overlayHooks.cursor(e, t, s, n, a).catch(() => {
  }));
}, BUTTON_MASK = { left: 1, right: 2, middle: 4 }, generateBezierPath = (e, t, s, o, n) => {
  const a = e + (s - e) * 0.25 + (Math.random() - 0.5) * Math.abs(s - e) * 0.3, r = t + (o - t) * 0.25 + (Math.random() - 0.5) * Math.abs(o - t) * 0.3, i = e + (s - e) * 0.75 + (Math.random() - 0.5) * Math.abs(s - e) * 0.3, c = t + (o - t) * 0.75 + (Math.random() - 0.5) * Math.abs(o - t) * 0.3, d = [];
  for (let m = 1; m <= n; m++) {
    const l = m / n, u = 1 - l, g = u * u * u * e + 3 * u * u * l * a + 3 * u * l * l * i + l * l * l * s, f = u * u * u * t + 3 * u * u * l * r + 3 * u * l * l * c + l * l * l * o;
    d.push({ x: Math.round(g), y: Math.round(f) });
  }
  return d;
}, cdpMove = async (e, t, s, o = !1) => {
  const n = e.tabId, a = gaussianDelay(10, 20), r = generateBezierPath(e.cursor.x, e.cursor.y, t, s, a);
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    await sendCDP$1(n, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: c.x,
      y: c.y,
      ...o ? { button: "left", buttons: 1 } : {}
    }), postCursor(n, c.x, c.y, i === r.length - 1), await sleep$1(gaussianDelay(5, 15));
  }
  e.cursor = { x: t, y: s }, postCursor(n, t, s, !0);
}, cdpPress = async (e, t, s, o, n = 1) => {
  overlayHooks.pulse(e.tabId).catch(() => {
  }), await sendCDP$1(e.tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: t,
    y: s,
    button: o,
    buttons: BUTTON_MASK[o] ?? 1,
    clickCount: n
  });
}, cdpRelease = (e, t, s, o, n = 1) => sendCDP$1(e.tabId, "Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: t,
  y: s,
  button: o,
  buttons: 0,
  clickCount: n
}), cdpClick = async (e, t, s, o, n = !1) => {
  await cdpPress(e, t, s, o, 1), await sleep$1(gaussianDelay(30, 80)), await cdpRelease(e, t, s, o, 1), n && (await sleep$1(gaussianDelay(40, 90)), await cdpPress(e, t, s, o, 2), await sleep$1(gaussianDelay(30, 80)), await cdpRelease(e, t, s, o, 2));
}, cdpWheel = async (e, t, s, o, n) => {
  o === 0 && n === 0 || (await sendCDP$1(e.tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: t, y: s, deltaX: o, deltaY: n }), e.cursor = { x: t, y: s }, postCursor(e.tabId, t, s, !0));
}, MODIFIER_FLAGS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }, MODIFIER_KEYS = {
  alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 }
}, SPECIAL_KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Insert: { code: "Insert", keyCode: 45 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " " },
  F1: { code: "F1", keyCode: 112 },
  F2: { code: "F2", keyCode: 113 },
  F3: { code: "F3", keyCode: 114 },
  F4: { code: "F4", keyCode: 115 },
  F5: { code: "F5", keyCode: 116 },
  F6: { code: "F6", keyCode: 117 },
  F7: { code: "F7", keyCode: 118 },
  F8: { code: "F8", keyCode: 119 },
  F9: { code: "F9", keyCode: 120 },
  F10: { code: "F10", keyCode: 121 },
  F11: { code: "F11", keyCode: 122 },
  F12: { code: "F12", keyCode: 123 }
}, EDIT_COMMANDS = {
  a: "SelectAll",
  c: "Copy",
  v: "Paste",
  x: "Cut",
  z: "Undo",
  y: "Redo"
}, codeForChar = (e) => e >= "a" && e <= "z" ? `Key${e.toUpperCase()}` : e >= "A" && e <= "Z" ? `Key${e}` : e >= "0" && e <= "9" ? `Digit${e}` : e === " " ? "Space" : "", isPrintableAscii = (e) => {
  const t = e.charCodeAt(0);
  return e.length === 1 && t >= 32 && t <= 126;
}, keyEvent = (e, t) => sendCDP$1(e, "Input.dispatchKeyEvent", t), typeAsciiChar = async (e, t, s = 0) => {
  const o = t.charCodeAt(0), n = codeForChar(t), a = { key: t, code: n, windowsVirtualKeyCode: o, nativeVirtualKeyCode: o, modifiers: s };
  await keyEvent(e, { type: "keyDown", ...a }), await keyEvent(e, { type: "char", text: t, ...a }), await keyEvent(e, { type: "keyUp", ...a });
}, pressEnter = async (e, t = 0) => {
  const s = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: t };
  await keyEvent(e, { type: "keyDown", text: "\r", unmodifiedText: "\r", ...s }), await keyEvent(e, { type: "keyUp", ...s });
}, typeText = async (e, t, s) => {
  const o = e.tabId, n = Array.from(t);
  if (!s)
    return await sendCDP$1(o, "Input.insertText", { text: t }), n.length;
  for (const a of n)
    a === `
` || a === "\r" ? await pressEnter(o) : isPrintableAscii(a) ? await typeAsciiChar(o, a) : await sendCDP$1(o, "Input.insertText", { text: a }), await sleep$1(gaussianDelay(40, 120, 70));
  return n.length;
}, pressKey = async (e, t, s) => {
  const o = e.tabId, n = s.filter((i) => i in MODIFIER_FLAGS);
  let a = 0;
  const r = [];
  try {
    for (const f of n) {
      const R = MODIFIER_KEYS[f];
      a |= MODIFIER_FLAGS[f], await keyEvent(o, {
        type: "keyDown",
        key: R.key,
        code: R.code,
        windowsVirtualKeyCode: R.keyCode,
        nativeVirtualKeyCode: R.keyCode,
        modifiers: a
      }), r.push(f);
    }
    const i = SPECIAL_KEYS[t], c = t.length === 1, d = (i == null ? void 0 : i.code) ?? (c ? codeForChar(t) : t), m = (i == null ? void 0 : i.keyCode) ?? (c ? t.toUpperCase().charCodeAt(0) : 0), l = c && (a & (MODIFIER_FLAGS.meta | MODIFIER_FLAGS.ctrl)) !== 0, u = l ? EDIT_COMMANDS[t.toLowerCase()] : void 0, g = { key: t, code: d, windowsVirtualKeyCode: m, nativeVirtualKeyCode: m, modifiers: a };
    await keyEvent(o, {
      type: "keyDown",
      ...g,
      ...i != null && i.text && !l ? { text: i.text, unmodifiedText: i.text } : {},
      ...u ? { commands: [u] } : {}
    }), c && !l && (isPrintableAscii(t) ? await keyEvent(o, { type: "char", text: t, ...g }) : await sendCDP$1(o, "Input.insertText", { text: t })), await keyEvent(o, { type: "keyUp", ...g });
  } finally {
    for (const i of r.reverse()) {
      const c = MODIFIER_KEYS[i];
      a &= ~MODIFIER_FLAGS[i], await keyEvent(o, {
        type: "keyUp",
        key: c.key,
        code: c.code,
        windowsVirtualKeyCode: c.keyCode,
        nativeVirtualKeyCode: c.keyCode,
        modifiers: a
      }).catch(() => {
      });
    }
  }
}, api$7 = globalThis.chrome, INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem"
]), STRUCTURAL_ROLES = /* @__PURE__ */ new Set([
  "heading",
  "dialog",
  "alertdialog",
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "form",
  "region",
  "search",
  "table",
  "row",
  "cell",
  "columnheader",
  "rowheader",
  "list",
  "listitem",
  "img",
  "image",
  "figure",
  "article",
  "tabpanel",
  "tablist",
  "menu",
  "menubar",
  "toolbar",
  "status",
  "alert",
  "progressbar"
]), OVERLAY_TAG = "WOLFFISH-OVERLAY", indexDom = (e) => {
  const t = /* @__PURE__ */ new Map(), s = /* @__PURE__ */ new Set(), o = [{ node: e, inOverlay: !1 }];
  for (; o.length > 0; ) {
    const { node: n, inOverlay: a } = o.pop(), r = {}, i = n.attributes ?? [];
    for (let m = 0; m + 1 < i.length; m += 2) r[i[m]] = i[m + 1];
    const c = a || n.nodeName === OVERLAY_TAG;
    c && s.add(n.backendNodeId), t.set(n.backendNodeId, {
      tag: n.nodeName.toLowerCase(),
      attrs: r,
      hasContentDocument: n.contentDocument !== void 0,
      frameId: n.frameId
    });
    const d = [
      ...n.children ?? [],
      ...n.shadowRoots ?? [],
      ...n.contentDocument ? [n.contentDocument] : [],
      ...n.templateContent ? [n.templateContent] : []
    ];
    for (const m of d) o.push({ node: m, inOverlay: c });
  }
  return { dom: t, overlay: s };
}, fetchAXNodes = async (e, t) => (await sendCDP$1(e, "Accessibility.getFullAXTree", t ? { frameId: t } : {})).nodes ?? [], roleOf = (e) => {
  var s;
  const t = String(((s = e.role) == null ? void 0 : s.value) ?? "generic");
  return t.toLowerCase() === "rootwebarea" ? "RootWebArea" : t.toLowerCase();
}, NOISE_ROLES = /* @__PURE__ */ new Set(["inlinetextbox", "linebreak"]), graftChildFrames = async (e, t, s) => {
  const o = [...t.values()].filter((n) => roleOf(n) === "iframe" && !(n.childIds && n.childIds.length > 0));
  for (const n of o) {
    const a = n.backendDOMNodeId !== void 0 ? s.get(n.backendDOMNodeId) : void 0, r = (a == null ? void 0 : a.frameId) ?? n.frameId;
    if (!(a != null && a.hasContentDocument) || !r) continue;
    let i;
    try {
      i = await fetchAXNodes(e, r);
    } catch {
      continue;
    }
    const c = `${r}:`, d = [];
    for (const m of i) {
      const l = c + m.nodeId, u = {
        ...m,
        nodeId: l,
        parentId: m.parentId ? c + m.parentId : n.nodeId,
        childIds: (m.childIds ?? []).map((g) => c + g)
      };
      m.parentId || d.push(l), t.set(l, u);
    }
    n.childIds = d;
  }
}, escapeText = (e) => e.replace(/\s+/g, " ").replace(/"/g, '\\"'), clip = (e, t) => e.length > t ? `${e.slice(0, t)}…` : e, boolProp = (e, t) => e.get(t) === !0, triProp = (e, t) => {
  const s = e.get(t);
  return s === !0 || s === "true" ? t : s === "mixed" ? `${t}=mixed` : null;
}, attributesFor = (e, t, s) => {
  var l;
  const o = new Map((e.properties ?? []).map((u) => [u.name, u.value.value])), n = [], a = triProp(o, "checked");
  a && n.push(a), boolProp(o, "disabled") && n.push("disabled"), boolProp(o, "expanded") && n.push("expanded"), boolProp(o, "selected") && n.push("selected");
  const r = triProp(o, "pressed");
  r && n.push(r), boolProp(o, "focused") && n.push("focused"), boolProp(o, "focusable") && n.push("focusable"), boolProp(o, "required") && n.push("required"), boolProp(o, "readonly") && n.push("readonly");
  const i = o.get("level");
  typeof i == "number" && n.push(`level=${i}`);
  const c = (l = e.value) == null ? void 0 : l.value, d = c !== void 0 && c !== "" ? String(c) : (s == null ? void 0 : s.attrs.value) ?? "";
  d && n.push(`value="${escapeText(d)}"`);
  const m = (s == null ? void 0 : s.attrs.placeholder) ?? "";
  return m && n.push(`placeholder="${escapeText(m)}"`), t === "link" && (s != null && s.attrs.href) && n.push(`href="${escapeText(clip(s.attrs.href, 200))}"`), (t === "image" || t === "img") && (s != null && s.attrs.src) && n.push(`url="${escapeText(clip(s.attrs.src, 120))}"`), n.length > 0 ? ` ${n.join(" ")}` : "";
}, hostOf = (e) => {
  try {
    return new URL(e).host || e;
  } catch {
    return e;
  }
}, assignUid = (e, t) => {
  const s = t.backendDOMNodeId !== void 0 ? `${e.session.loaderId}:${t.backendDOMNodeId}` : `ax:${t.nodeId}`, o = e.session.uidByNode.get(s), n = o ?? `${e.snapshotId}_${e.counter++}`;
  return e.nextUidByNode.set(s, n), t.backendDOMNodeId !== void 0 && e.nextUidMap.set(n, {
    backendNodeId: t.backendDOMNodeId,
    loaderId: e.session.loaderId,
    frameId: t.frameId
  }), { uid: n, isNew: e.hadSnapshot && o === void 0 };
}, isInteresting = (e, t) => INTERACTIVE_ROLES.has(e) || STRUCTURAL_ROLES.has(e) || t.trim() !== "", emit = (e, t, s, o) => {
  const { uid: n, isNew: a } = assignUid(e, t);
  return e.lines.push(`${"  ".repeat(s)}${a ? "*" : ""}uid=${n} ${o}`), n;
}, walk = (e, t, s, o) => {
  var g;
  if (t.backendDOMNodeId !== void 0 && e.overlay.has(t.backendDOMNodeId)) return;
  const n = (t.childIds ?? []).map((f) => e.byId.get(f)).filter((f) => f !== void 0);
  if (t.ignored) {
    for (const f of n) walk(e, f, s, o);
    return;
  }
  let a = roleOf(t);
  if (NOISE_ROLES.has(a) && !e.verbose) {
    for (const f of n) walk(e, f, s, o);
    return;
  }
  const r = String(((g = t.name) == null ? void 0 : g.value) ?? "").replace(/\s+/g, " ").trim(), i = t.backendDOMNodeId !== void 0 ? e.dom.get(t.backendDOMNodeId) : void 0, c = i == null ? void 0 : i.attrs.contenteditable;
  if (a === "generic" && c !== void 0 && c !== "false" && (a = "textbox"), a === "iframe" && i && !i.hasContentDocument && n.length === 0) {
    emit(e, t, s, `iframe "${escapeText(hostOf(i.attrs.src ?? ""))}" (cross-origin)`);
    return;
  }
  let d = e.verbose || isInteresting(a, r);
  if (d && !e.verbose && a === "statictext" && o.includes(r.trim().toLowerCase()) && (d = !1), !d) {
    for (const f of n) walk(e, f, s, o);
    return;
  }
  const m = r ? ` "${escapeText(r)}"` : "", l = emit(e, t, s, `${a}${m}${attributesFor(t, a, i)}`);
  t.backendDOMNodeId !== void 0 && e.nodes.push({
    uid: l,
    role: a,
    name: r,
    tag: (i == null ? void 0 : i.tag) ?? "",
    backendNodeId: t.backendDOMNodeId,
    id: (i == null ? void 0 : i.attrs.id) ?? "",
    ariaLabel: (i == null ? void 0 : i.attrs["aria-label"]) ?? ""
  });
  const u = r.trim() ? [...o, r.trim().toLowerCase()] : o;
  for (const f of n) walk(e, f, s + 1, u);
}, takeSnapshot = async (e, t) => {
  const s = e.tabId, [o, n, a] = await Promise.all([
    fetchAXNodes(s),
    sendCDP$1(s, "DOM.getDocument", { depth: -1, pierce: !0 }),
    api$7.tabs.get(s).catch(() => null)
  ]), { dom: r, overlay: i } = indexDom(n.root), c = new Map(o.map((u) => [u.nodeId, u]));
  await graftChildFrames(s, c, r);
  const d = await nextSnapshotId(e), m = {
    session: e,
    verbose: t,
    snapshotId: d,
    byId: c,
    dom: r,
    overlay: i,
    lines: [],
    nextUidMap: /* @__PURE__ */ new Map(),
    nextUidByNode: /* @__PURE__ */ new Map(),
    nodes: [],
    counter: 0,
    hadSnapshot: e.hasSnapshot
  }, l = o.filter((u) => !u.parentId || !c.has(u.parentId));
  for (const u of l) walk(m, u, 0, []);
  return e.uidMap = m.nextUidMap, e.uidByNode = m.nextUidByNode, e.snapshotNodes = m.nodes, e.hasSnapshot = !0, {
    snapshot: m.lines.join(`
`),
    url: (a == null ? void 0 : a.url) ?? "",
    title: (a == null ? void 0 : a.title) ?? "",
    nodeCount: m.lines.length,
    source: "cdp",
    snapshotId: d
  };
}, NO_SNAPSHOT_ERROR = "No snapshot for this tab. Call ext_take_snapshot first.", uidNotFoundError = (e) => `Element uid "${e}" not found in the latest snapshot. Take a new snapshot with ext_take_snapshot.`, uidDetachedError = (e) => `Element uid "${e}" was detached or no longer exists on the page. Take a new snapshot with ext_take_snapshot.`, lookupUid = (e, t) => {
  if (!e.hasSnapshot) throw new Error(NO_SNAPSHOT_ERROR);
  const s = e.uidMap.get(t);
  if (!s || s.loaderId !== e.loaderId) throw new Error(uidNotFoundError(t));
  return s;
}, withUidErrors = async (e, t) => {
  try {
    return await t();
  } catch (s) {
    const o = s instanceof Error ? s.message : String(s);
    throw /no node|not found|could not find|detached|does not have a layout object|invalid/i.test(o) ? new Error(uidDetachedError(e)) : s;
  }
}, scoreNode = (e, t) => {
  const s = e.name.toLowerCase(), o = new Set(s.split(/[^\p{L}\p{N}]+/u).filter(Boolean)), n = e.id.toLowerCase(), a = e.ariaLabel.toLowerCase();
  let r = 0;
  for (const i of t)
    o.has(i) && (r += 10), (e.role === i || e.tag === i) && (r += 5), (n && n.includes(i) || a && a.includes(i)) && (r += 3), s.includes(i) && (r += 2);
  return r;
}, findInSnapshot = async (e, t, s) => {
  const o = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (o.length === 0) return [];
  const n = e.snapshotNodes.map((r) => ({ node: r, score: scoreNode(r, o) })).filter((r) => r.score > 0).sort((r, i) => i.score - r.score).slice(0, Math.max(1, s)), a = [];
  for (const { node: r, score: i } of n)
    try {
      const c = await nodeRect(e.tabId, r.backendNodeId);
      a.push({ uid: r.uid, tag: r.tag, role: r.role, text: r.name, score: i, center: center(c), rect: c });
    } catch {
    }
  return a;
}, api$6 = globalThis.chrome, tabOf = async (e) => (await sessionsReady, resolveTabId(e)), sessionFor = async (e) => requireSession(await tabOf(e)), sessionForCapture = async (e, t) => {
  const s = getSession(await tabOf(e));
  if (!s) throw new Error(needsDebuggerError(t));
  return s;
}, virtualCursor = /* @__PURE__ */ new Map(), getCursorPosition = (e) => {
  var o;
  const t = getDebuggerState().tabId;
  if (t !== null) return ((o = getSession(t)) == null ? void 0 : o.cursor) ?? { x: 0, y: 0 };
  const s = virtualCursor.values().next();
  return s.done ? { x: 0, y: 0 } : s.value;
}, MISSING_TARGET_ERROR = "Provide a uid, a selector, or x/y coordinates", resolveNodeTarget = async (e, t) => {
  if (t.uid)
    return { backendNodeId: lookupUid(e, t.uid).backendNodeId, ref: t.uid, uid: t.uid };
  if (t.selector)
    return { backendNodeId: await resolveSelectorNode(e.tabId, t.selector), ref: t.selector };
  throw new Error("Provide a uid or a selector");
}, onTarget = (e, t) => e.uid ? withUidErrors(e.uid, t) : t(), nodePoint = async (e, t, s) => onTarget(t, async () => {
  const o = e.tabId;
  s && await scrollNodeIntoView(o, t.backendNodeId);
  const n = await nodeRect(o, t.backendNodeId), a = await callOnNode(o, t.backendNodeId, nodeHrefInPage).catch(() => null);
  return overlayHooks.target(o, n).catch(() => {
  }), { ...center(n), backendNodeId: t.backendNodeId, rect: n, href: a };
}), resolveElementCoordsFallback = async (e, t, s) => {
  var a;
  const n = (a = (await api$6.scripting.executeScript({
    target: { tabId: e },
    func: (r, i) => {
      const c = (g) => g.replace(/\s+/g, " ").trim().toLowerCase(), d = (g) => {
        if (g.offsetParent !== null) return !0;
        const f = getComputedStyle(g);
        return f.display !== "none" && f.visibility !== "hidden";
      };
      let m = null;
      if (r.startsWith("text=")) {
        const g = c(r.slice(5).replace(/^(["'])([\s\S]*)\1$/, "$2"));
        if (g) {
          const f = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "WOLFFISH-OVERLAY"]), R = [], A = [], b = document.body ? Array.from(document.body.getElementsByTagName("*")) : [];
          for (const N of b) {
            const v = N;
            if (f.has(v.tagName)) continue;
            const h = c(v.textContent ?? "");
            !h || h.length > g.length + 200 || (h === g ? R.push(v) : h.includes(g) && A.push(v));
          }
          const I = R.length > 0 ? R : A;
          m = I.filter((N) => !I.some((v) => v !== N && N.contains(v))).find(d) ?? null;
        }
      } else
        try {
          m = document.querySelector(r);
        } catch {
          return {
            error: `selector syntax is incorrect: '${r}' is not valid CSS. Use a CSS selector, or text=<visible text> to target by text.`
          };
        }
      if (!m) return null;
      i && m.scrollIntoView({ behavior: "smooth", block: "center" });
      const l = m.getBoundingClientRect(), u = m.closest("a");
      return {
        x: Math.round(l.left + l.width / 2),
        y: Math.round(l.top + l.height / 2),
        href: (u == null ? void 0 : u.href) || null,
        rect: { x: l.left, y: l.top, width: l.width, height: l.height }
      };
    },
    args: [t, s],
    world: "MAIN"
  }))[0]) == null ? void 0 : a.result;
  if (n && "error" in n) throw new Error(n.error);
  if (!n) throw new Error(`Element not found: ${t}`);
  return n;
}, resolveUidViaContentScript = async (e, t) => {
  await ensureContentScriptInjected(e);
  const s = {
    id: generateId(),
    type: WolffishCommands.BROWSER_RESOLVE_UID,
    params: { uid: t, tabId: e }
  }, o = await sendToContentScript(e, {
    source: "service-worker",
    target: "content-script",
    payload: s
  });
  if (!(o != null && o.success)) throw new Error((o == null ? void 0 : o.error) ?? `Element uid "${t}" could not be resolved`);
  const n = o.data;
  if (!n.found || !n.center)
    throw new Error(
      `Element uid "${t}" not found in the latest snapshot. Take a new snapshot with ext_take_snapshot.`
    );
  return n.rect && overlayHooks.target(e, n.rect).catch(() => {
  }), { x: n.center.x, y: n.center.y, rect: n.rect, href: null };
}, resolveTargetPoint = async (e, t, s = {}) => {
  const o = s.scroll ?? !0, n = getSession(e);
  if (t.uid || t.selector) {
    if (n) return nodePoint(n, await resolveNodeTarget(n, t), o);
    if (t.uid) return resolveUidViaContentScript(e, t.uid);
    const a = await resolveElementCoordsFallback(e, t.selector, o);
    return overlayHooks.target(e, a.rect).catch(() => {
    }), a;
  }
  if (typeof t.x == "number" && typeof t.y == "number") return { x: t.x, y: t.y, href: null };
  throw new Error(s.missingError ?? MISSING_TARGET_ERROR);
}, handleDebuggerAttach = async (e) => {
  const t = await tabOf(e);
  return await attachTab(t), { success: !0, tabId: t };
}, handleDebuggerDetach = async (e) => {
  await sessionsReady;
  const { tabId: t } = e;
  return await detachTab(typeof t == "number" ? t : void 0), { success: !0 };
}, handleDebuggerStatus = async (e) => {
  await sessionsReady;
  const t = getDebuggerState();
  if (!t.attached) return t;
  const s = await resolveTabId(e).catch(() => null);
  return { ...t, tabId: s !== null && hasSession(s) ? s : t.tabId };
}, handleCDPClick = async (e) => {
  const t = e, s = await sessionFor(e);
  assertNoDialog(s);
  const o = s.tabId, n = await api$6.tabs.get(o).catch(() => null), a = await resolveTargetPoint(o, t, { scroll: !0, missingError: "Provide a uid or a selector" });
  if (await sleep$1(gaussianDelay(50, 150)), await cdpMove(s, a.x, a.y), await cdpClick(s, a.x, a.y, "left"), a.href && a.backendNodeId !== void 0) {
    await sleep$1(200);
    const r = await api$6.tabs.get(o).catch(() => null);
    !r || r.status === "loading" || (n == null ? void 0 : n.url) && r.url !== n.url || await callOnNode(o, a.backendNodeId, anchorClickInPage).catch(() => {
    });
  }
  return { success: !0, elementFound: !0 };
}, handleCDPType = async (e) => {
  const t = e, s = await sessionFor(e);
  assertNoDialog(s);
  const o = s.tabId, n = t.text ?? "", a = await resolveNodeTarget(s, t), r = await nodePoint(s, a, !0);
  return await onTarget(a, async () => {
    await sendCDP$1(o, "DOM.focus", { backendNodeId: a.backendNodeId }).catch(
      () => callOnNode(o, a.backendNodeId, focusInPage)
    ), t.clearFirst && await callOnNode(o, a.backendNodeId, clearInPage);
  }), overlayHooks.cursor(o, r.x, r.y, "keyboard").catch(() => {
  }), { success: !0, typed: await typeText(s, n, t.humanize !== !1) };
}, SCROLL_DELTAS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0]
}, handleCDPScroll = async (e) => {
  const t = e, s = await sessionFor(e);
  assertNoDialog(s);
  const o = t.amount ?? 300, [n, a] = t.direction && SCROLL_DELTAS[t.direction] || [0, 0], r = n * o, i = a * o;
  if (t.uid || t.selector) {
    const c = await resolveTargetPoint(s.tabId, t, { scroll: !0 });
    return (t.direction || t.amount !== void 0) && await cdpWheel(s, c.x, c.y, r, i), await sleep$1(gaussianDelay(50, 150)), { success: !0 };
  }
  return await cdpWheel(s, s.cursor.x || 400, s.cursor.y || 400, r, i), await sleep$1(gaussianDelay(50, 150)), { success: !0 };
}, handleCDPHover = async (e) => {
  const t = e, s = await sessionFor(e);
  assertNoDialog(s);
  const o = await resolveTargetPoint(s.tabId, t, {
    scroll: !0,
    missingError: "Provide a uid or a selector"
  });
  return await sleep$1(100), await cdpMove(s, o.x, o.y), { success: !0 };
}, handleCDPKeypress = async (e) => {
  const { key: t, modifiers: s } = e, o = await sessionFor(e);
  if (assertNoDialog(o), !t) throw new Error("Provide a key");
  return await pressKey(o, t, s ?? []), { success: !0 };
}, handleCDPFocus = async (e) => {
  const t = e, s = await sessionFor(e), o = await resolveNodeTarget(s, t);
  return await onTarget(
    o,
    () => sendCDP$1(s.tabId, "DOM.focus", { backendNodeId: o.backendNodeId }).catch(
      () => callOnNode(s.tabId, o.backendNodeId, focusInPage)
    )
  ), { success: !0 };
}, handleCDPSelect = async (e) => {
  const t = e, s = await sessionFor(e);
  assertNoDialog(s);
  const o = await resolveNodeTarget(s, t);
  return await onTarget(o, () => callOnNode(s.tabId, o.backendNodeId, selectInPage, [t.value])), { success: !0 };
}, fillTarget = async (e, t, s) => {
  const o = await resolveNodeTarget(e, t), n = await nodePoint(e, o, !0);
  return overlayHooks.cursor(e.tabId, n.x, n.y, "keyboard").catch(() => {
  }), onTarget(
    o,
    () => callOnNode(e.tabId, o.backendNodeId, fillInPage, [s])
  );
}, handleCDPFill = async (e) => {
  const t = e, s = await sessionFor(e);
  return assertNoDialog(s), fillTarget(s, t, t.value ?? "");
}, handleCDPFillForm = async (e) => {
  const t = e, s = await sessionFor(e);
  assertNoDialog(s);
  const o = Array.isArray(t.elements) ? t.elements : [], n = [];
  let a = 0;
  for (const r of o)
    try {
      await fillTarget(s, r, r.value ?? ""), a++;
    } catch (i) {
      n.push({
        ref: r.uid ?? r.selector ?? "?",
        error: i instanceof Error ? i.message : String(i)
      });
    }
  return { success: o.length === 0 || a > 0, filled: a, failures: n };
}, handleCDPSetValue = async (e) => {
  const t = e, s = await sessionFor(e);
  assertNoDialog(s);
  const o = await resolveNodeTarget(s, t);
  return onTarget(
    o,
    () => callOnNode(s.tabId, o.backendNodeId, setValueInPage, [t.value ?? ""])
  );
}, handleCDPGetValue = async (e) => {
  const t = e, s = await sessionFor(e), o = await resolveNodeTarget(s, t);
  return onTarget(o, () => callOnNode(s.tabId, o.backendNodeId, getValueInPage));
}, handleCDPGetAttribute = async (e) => {
  const t = e, s = await sessionFor(e), o = await resolveNodeTarget(s, t);
  return { attributes: await onTarget(
    o,
    () => callOnNode(s.tabId, o.backendNodeId, getAttributesInPage, [
      Array.isArray(t.attributes) ? t.attributes : []
    ])
  ) };
}, handleCDPFileUpload = async (e) => {
  const t = e, s = await sessionFor(e);
  assertNoDialog(s);
  const o = s.tabId, n = await resolveNodeTarget(s, t);
  return onTarget(n, async () => {
    if (!await callOnNode(o, n.backendNodeId, isFileInputInPage)) throw new Error(`Element is not a file input: ${n.ref}`);
    if (Array.isArray(t.filePaths) && t.filePaths.length > 0)
      return await sendCDP$1(o, "DOM.setFileInputFiles", { files: t.filePaths, backendNodeId: n.backendNodeId }), await callOnNode(o, n.backendNodeId, (r) => {
        r.dispatchEvent(new Event("input", { bubbles: !0 })), r.dispatchEvent(new Event("change", { bubbles: !0 }));
      }).catch(() => {
      }), { success: !0, count: t.filePaths.length, via: "paths" };
    if (Array.isArray(t.files) && t.files.length > 0)
      return { success: !0, count: await callOnNode(o, n.backendNodeId, setFilesInPage, [t.files]), via: "data" };
    throw new Error("Provide files (base64 content) or filePaths.");
  });
}, handleCDPTakeSnapshot = async (e) => {
  const { verbose: t } = e, s = await sessionFor(e);
  return assertNoDialog(s), takeSnapshot(s, t === !0);
}, handleCDPResolveUid = async (e) => {
  const { uid: t } = e, s = await sessionFor(e);
  if (!t) throw new Error("Provide a uid");
  const o = lookupUid(s, t), n = s.snapshotNodes.find((a) => a.uid === t);
  return withUidErrors(t, async () => {
    const a = s.tabId;
    await scrollNodeIntoView(a, o.backendNodeId);
    const r = await nodeRect(a, o.backendNodeId), i = await callOnNode(a, o.backendNodeId, nodeInfoInPage).catch(() => null);
    return {
      found: !0,
      center: center(r),
      rect: r,
      tag: (i == null ? void 0 : i.tag) ?? (n == null ? void 0 : n.tag),
      role: n == null ? void 0 : n.role,
      name: n == null ? void 0 : n.name
    };
  });
}, handleCDPFind = async (e) => {
  const { query: t, limit: s } = e, o = await sessionFor(e);
  if (assertNoDialog(o), !t) throw new Error("Provide a query");
  return o.hasSnapshot || await takeSnapshot(o, !1), { elements: await findInSnapshot(o, t, s ?? 10), snapshotId: o.snapshotId };
}, devicePixelRatio = async (e) => {
  const t = await sendCDP$1(e, "Runtime.evaluate", {
    expression: "window.devicePixelRatio",
    returnByValue: !0
  }), s = unwrap(t);
  return typeof s == "number" && s > 0 ? s : 1;
}, handleCDPScreenshot = async (e) => {
  const t = e, s = await sessionFor(e);
  assertNoDialog(s);
  const o = s.tabId, n = t.format === "jpeg" ? "jpeg" : "png", a = t.fullPage === !0, r = await sendCDP$1(o, "Page.getLayoutMetrics"), i = await devicePixelRatio(o);
  let c, d = r.cssLayoutViewport.clientWidth, m = r.cssLayoutViewport.clientHeight;
  if (t.uid || t.selector) {
    const u = await resolveTargetPoint(o, t, { scroll: !0 }), g = u.rect ?? { x: u.x, y: u.y, width: 1, height: 1 }, f = await sendCDP$1(o, "Page.getLayoutMetrics");
    c = {
      x: g.x + f.cssVisualViewport.pageX,
      y: g.y + f.cssVisualViewport.pageY,
      width: Math.max(1, g.width),
      height: Math.max(1, g.height),
      scale: 1
    }, d = c.width, m = c.height;
  } else a && (c = { x: 0, y: 0, width: r.cssContentSize.width, height: r.cssContentSize.height, scale: 1 }, d = c.width, m = c.height);
  await overlayHooks.beforeCapture(o).catch(() => {
  });
  let l;
  try {
    l = (await sendCDP$1(o, "Page.captureScreenshot", {
      format: n,
      ...n === "jpeg" && typeof t.quality == "number" ? { quality: t.quality } : {},
      captureBeyondViewport: a,
      fromSurface: !0,
      ...c ? { clip: c } : {}
    })).data;
  } finally {
    await overlayHooks.afterCapture(o).catch(() => {
    });
  }
  return {
    image: `data:image/${n};base64,${l}`,
    width: Math.round(d * i),
    height: Math.round(m * i),
    cssWidth: Math.round(d),
    cssHeight: Math.round(m),
    dpr: i,
    mode: "cdp"
  };
}, handleCDPExecuteJs = async (e) => {
  const { code: t, args: s } = e, o = await sessionFor(e);
  assertNoDialog(o);
  const n = o.tabId;
  if (typeof t != "string") throw new Error("Provide code");
  if (Array.isArray(s) && s.length > 0) {
    const i = [];
    try {
      for (const d of s) {
        const m = lookupUid(o, d);
        i.push(await withUidErrors(d, () => resolveObjectId(n, m.backendNodeId)));
      }
      let c;
      try {
        c = await sendCDP$1(n, "Runtime.callFunctionOn", {
          objectId: i[0],
          functionDeclaration: t,
          arguments: i.map((d) => ({ objectId: d })),
          returnByValue: !0,
          awaitPromise: !0
        });
      } catch (d) {
        const m = d instanceof Error ? d.message : String(d);
        throw /not.*function|does not evaluate/i.test(m) ? new Error("With args, code must be a function expression, e.g. (el) => el.innerText") : d;
      }
      return { result: unwrap(c), world: "MAIN" };
    } finally {
      for (const c of i) releaseObject(n, c);
    }
  }
  const a = /\b(return|await)\s/.test(t) ? `(async () => { ${t} })()` : t, r = await sendCDP$1(n, "Runtime.evaluate", {
    expression: a,
    awaitPromise: !0,
    returnByValue: !0
  });
  return { result: unwrap(r), world: "MAIN" };
}, summarize = (e) => ({
  reqid: e.reqid,
  method: e.method,
  url: e.url,
  status: e.status,
  type: e.type,
  mimeType: e.mimeType,
  size: e.size,
  durationMs: e.endedAt !== null ? Math.round((e.endedAt - e.startedAt) * 1e3) : null,
  failed: e.failed,
  fromCache: e.fromCache
}), handleListNetworkRequests = async (e) => {
  const { pageSize: t, pageIdx: s, resourceTypes: o } = e, n = await sessionForCapture(e, "Network capture"), a = Array.isArray(o) ? o.map((m) => String(m).toLowerCase()) : [], r = a.length > 0 ? n.network.filter((m) => a.includes(m.type)) : n.network, { items: i, total: c, page: d } = paginate(r, t, s);
  return {
    requests: i.map(summarize),
    total: c,
    page: d,
    captureSince: n.attachedAt,
    pageLoadedBeforeCapture: n.navigations === 0
  };
}, handleGetNetworkRequest = async (e) => {
  const { reqid: t, includeBody: s } = e, o = await sessionForCapture(e, "Network capture"), n = o.network.find((i) => i.reqid === t);
  if (!n)
    throw new Error(
      `Network request ${t} is not in the capture buffer. Call ext_list_network_requests for current ids.`
    );
  const a = {
    method: n.method,
    url: n.url,
    headers: n.headers,
    ...n.postData !== void 0 ? { postData: n.postData } : {}
  };
  if (!n.hasResponse || n.status === null) return { request: a, response: null };
  const r = {
    status: n.status,
    statusText: n.statusText,
    headers: n.responseHeaders,
    mimeType: n.mimeType
  };
  if (s !== !1)
    try {
      const i = await sendCDP$1(o.tabId, "Network.getResponseBody", { requestId: n.requestId });
      r.bodyTruncated = i.body.length > NETWORK_BODY_MAX_CHARS, r.body = r.bodyTruncated ? i.body.slice(0, NETWORK_BODY_MAX_CHARS) : i.body, r.base64Encoded = i.base64Encoded;
    } catch {
      r.bodyTruncated = !1;
    }
  return { request: a, response: r };
}, handleListConsoleMessages = async (e) => {
  const { pageSize: t, pageIdx: s, types: o, includeStackTraces: n } = e, a = await sessionForCapture(e, "Console capture"), r = Array.isArray(o) ? o.map((u) => String(u).toLowerCase()) : [], i = r.length > 0 ? a.console.filter((u) => r.includes(u.type)) : a.console, { items: c, total: d, page: m } = paginate(i, t, s);
  return { messages: c.map((u) => {
    if (n) return { ...u };
    const g = { ...u };
    return delete g.stack, g;
  }), total: d, page: m };
}, handleHandleDialog = async (e) => {
  const { action: t, promptText: s } = e, o = await sessionForCapture(e, "Dialog handling");
  if (t !== "accept" && t !== "dismiss") throw new Error('action must be "accept" or "dismiss".');
  const n = o.dialog;
  try {
    await sendCDP$1(o.tabId, "Page.handleJavaScriptDialog", {
      accept: t === "accept",
      ...typeof s == "string" ? { promptText: s } : {}
    });
  } catch (a) {
    if (!n) return { success: !0, handled: null };
    throw a;
  }
  return o.dialog = null, { success: !0, handled: n ? { type: n.type, message: n.message } : null };
}, parseViewport = (e) => {
  const [t, ...s] = e.split(",").map((a) => a.trim().toLowerCase()), o = /^(\d+)x(\d+)(?:x(\d+(?:\.\d+)?))?$/.exec(t ?? "");
  if (!o) return null;
  const n = /* @__PURE__ */ new Set(["mobile", "touch", "landscape"]);
  return s.some((a) => !n.has(a)) ? null : {
    width: Number(o[1]),
    height: Number(o[2]),
    dpr: o[3] ? Number(o[3]) : 0,
    mobile: s.includes("mobile"),
    touch: s.includes("touch"),
    landscape: s.includes("landscape")
  };
}, kbps = (e) => e * 1e3 / 8, mbps = (e) => e * 1e6 / 8, NETWORK_CONDITIONS = {
  Offline: { offline: !0, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  "Slow 3G": { offline: !1, latency: 400, downloadThroughput: kbps(500), uploadThroughput: kbps(500) },
  "Fast 3G": { offline: !1, latency: 150, downloadThroughput: mbps(1.6), uploadThroughput: kbps(750) },
  "Slow 4G": { offline: !1, latency: 150, downloadThroughput: mbps(4), uploadThroughput: mbps(3) },
  "Fast 4G": { offline: !1, latency: 40, downloadThroughput: mbps(20), uploadThroughput: mbps(10) },
  none: { offline: !1, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
}, applyViewport = async (e, t) => {
  const s = e.tabId;
  if (t === "") {
    await sendCDP$1(s, "Emulation.clearDeviceMetricsOverride"), await sendCDP$1(s, "Emulation.setTouchEmulationEnabled", { enabled: !1 }), delete e.emulation.viewport;
    return;
  }
  const o = parseViewport(t);
  if (!o)
    throw new Error(
      `Invalid viewport "${t}". Use WxH or WxHxDPR with optional ",mobile", ",touch", ",landscape" (e.g. 390x844x3,mobile,touch).`
    );
  await sendCDP$1(s, "Emulation.setDeviceMetricsOverride", {
    width: o.width,
    height: o.height,
    deviceScaleFactor: o.dpr,
    mobile: o.mobile,
    screenOrientation: o.landscape ? { type: "landscapePrimary", angle: 90 } : { type: "portraitPrimary", angle: 0 }
  }), await sendCDP$1(s, "Emulation.setTouchEmulationEnabled", {
    enabled: o.touch,
    ...o.touch ? { maxTouchPoints: 5 } : {}
  }), e.emulation.viewport = t;
}, applyGeolocation = async (e, t) => {
  const s = e.tabId;
  if (t === "") {
    await sendCDP$1(s, "Emulation.clearGeolocationOverride"), delete e.emulation.geolocation;
    return;
  }
  const [o, n] = t.split(",").map((a) => Number(a.trim()));
  if (!Number.isFinite(o) || !Number.isFinite(n))
    throw new Error(`Invalid geolocation "${t}". Use "lat,lng".`);
  await sendCDP$1(s, "Emulation.setGeolocationOverride", { latitude: o, longitude: n, accuracy: 1 }), e.emulation.geolocation = t;
}, handleEmulate = async (e) => {
  const t = e, s = await sessionForCapture(e, "Emulation"), o = s.tabId, n = s.emulation;
  if (typeof t.viewport == "string" && await applyViewport(s, t.viewport), typeof t.userAgent == "string" && (await sendCDP$1(o, "Emulation.setUserAgentOverride", { userAgent: t.userAgent }), t.userAgent === "" ? delete n.userAgent : n.userAgent = t.userAgent), t.colorScheme !== void 0) {
    const a = t.colorScheme === "dark" || t.colorScheme === "light" ? t.colorScheme : "";
    await sendCDP$1(o, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: a }] }), a === "" ? delete n.colorScheme : n.colorScheme = a;
  }
  if (typeof t.geolocation == "string" && await applyGeolocation(s, t.geolocation), t.networkConditions !== void 0) {
    const a = NETWORK_CONDITIONS[t.networkConditions];
    if (!a)
      throw new Error(
        `Unknown networkConditions "${t.networkConditions}". Use Offline, Slow 3G, Fast 3G, Slow 4G, Fast 4G or none.`
      );
    await sendCDP$1(o, "Network.emulateNetworkConditions", a), t.networkConditions === "none" ? delete n.networkConditions : n.networkConditions = t.networkConditions;
  }
  if (typeof t.cpuThrottlingRate == "number") {
    const a = Math.max(1, t.cpuThrottlingRate);
    await sendCDP$1(o, "Emulation.setCPUThrottlingRate", { rate: a }), a === 1 ? delete n.cpuThrottlingRate : n.cpuThrottlingRate = a;
  }
  return { success: !0, state: { ...n } };
}, fallbackMouse = async (e, t, s, o, n) => {
  await api$6.scripting.executeScript({
    target: { tabId: e },
    func: (a, r, i, c) => {
      const d = c === "right" ? 2 : c === "middle" ? 1 : 0, m = document.elementsFromPoint(a, r).find((u) => !u.closest("wolffish-overlay")) ?? document.body, l = (u) => {
        m.dispatchEvent(
          new MouseEvent(u, {
            bubbles: !0,
            cancelable: !0,
            clientX: a,
            clientY: r,
            button: d,
            view: window
          })
        );
      };
      if (i === "down") return l("mousedown");
      if (i === "up") return l("mouseup");
      if (i === "contextmenu")
        return l("mousedown"), l("mouseup"), l("contextmenu");
      l("mousedown"), l("mouseup"), l("click"), i === "dblclick" && (l("mousedown"), l("mouseup"), l("click"), l("dblclick"));
    },
    args: [t, s, o, n],
    world: "MAIN"
  });
}, handleMouseMove = async (e) => {
  const { x: t, y: s } = e, o = await tabOf(e), n = getSession(o);
  return n ? (assertNoDialog(n), await cdpMove(n, t, s), { success: !0 }) : (virtualCursor.set(o, { x: t, y: s }), postCursor(o, t, s, !0), { success: !0 });
}, handleMouseClick = async (e) => {
  const t = e, s = t.button ?? "left", o = t.double ?? !1, n = await tabOf(e), a = getSession(n);
  if (a) {
    assertNoDialog(a);
    const { x: d, y: m } = await resolveTargetPoint(n, t, { scroll: !0 });
    return await sleep$1(gaussianDelay(50, 150)), await cdpMove(a, d, m), await cdpClick(a, d, m, s, o), { success: !0, x: d, y: m, trusted: !0 };
  }
  const { x: r, y: i } = await resolveTargetPoint(n, t, { scroll: !0 });
  return await fallbackMouse(n, r, i, s === "right" ? "contextmenu" : o ? "dblclick" : "click", s), virtualCursor.set(n, { x: r, y: i }), postCursor(n, r, i, !0), { success: !0, x: r, y: i, trusted: !1 };
}, handleMouseDown = async (e) => {
  const t = e, s = t.button ?? "left", o = await tabOf(e), n = getSession(o);
  if (n) {
    assertNoDialog(n);
    const { x: i, y: c } = await resolveTargetPoint(o, t, { scroll: !0 });
    return await cdpMove(n, i, c), await cdpPress(n, i, c, s, 1), { success: !0, x: i, y: c, trusted: !0 };
  }
  const { x: a, y: r } = await resolveTargetPoint(o, t, { scroll: !0 });
  return await fallbackMouse(o, a, r, "down", s), virtualCursor.set(o, { x: a, y: r }), postCursor(o, a, r, !0), { success: !0, x: a, y: r, trusted: !1 };
}, handleMouseUp = async (e) => {
  const t = e, s = t.button ?? "left", o = await tabOf(e), n = getSession(o);
  if (n) {
    assertNoDialog(n);
    const { x: i, y: c } = await resolveTargetPoint(o, t, { scroll: !1 });
    return await cdpRelease(n, i, c, s, 1), n.cursor = { x: i, y: c }, { success: !0, x: i, y: c, trusted: !0 };
  }
  const { x: a, y: r } = await resolveTargetPoint(o, t, { scroll: !1 });
  return await fallbackMouse(o, a, r, "up", s), virtualCursor.set(o, { x: a, y: r }), { success: !0, x: a, y: r, trusted: !1 };
}, handleMouseDrag = async (e) => {
  const t = e, s = await tabOf(e), o = getSession(s), n = "Drag requires from_uid/to_uid, sourceSelector/targetSelector, or startX/startY and endX/endY", a = await resolveTargetPoint(
    s,
    { uid: t.from_uid, selector: t.sourceSelector, x: t.startX, y: t.startY },
    { scroll: !0, missingError: n }
  ), r = await resolveTargetPoint(
    s,
    { uid: t.to_uid, selector: t.targetSelector, x: t.endX, y: t.endY },
    { scroll: !0, missingError: n }
  );
  return o ? (assertNoDialog(o), await cdpMove(o, a.x, a.y), await cdpPress(o, a.x, a.y, "left", 1), await sleep$1(gaussianDelay(60, 140)), await cdpMove(o, r.x, r.y, !0), await sleep$1(gaussianDelay(60, 140)), await cdpRelease(o, r.x, r.y, "left", 1), { success: !0, x: r.x, y: r.y, trusted: !0 }) : (await api$6.scripting.executeScript({
    target: { tabId: s },
    func: (i, c, d, m) => {
      const l = (R, A) => document.elementsFromPoint(R, A).find((b) => !b.closest("wolffish-overlay")) ?? document.body, u = l(i, c), g = l(d, m), f = (R, A, b, I) => {
        I.dispatchEvent(
          new MouseEvent(R, { bubbles: !0, cancelable: !0, clientX: A, clientY: b, button: 0, view: window })
        );
      };
      f("mousedown", i, c, u), f("mousemove", Math.round((i + d) / 2), Math.round((c + m) / 2), g), f("mousemove", d, m, g), f("mouseup", d, m, g);
    },
    args: [a.x, a.y, r.x, r.y],
    world: "MAIN"
  }), virtualCursor.set(s, { x: r.x, y: r.y }), postCursor(s, r.x, r.y, !0), { success: !0, x: r.x, y: r.y, trusted: !1 });
}, api$5 = globalThis.chrome, sleep = (e) => new Promise((t) => setTimeout(t, e)), navigationStarted = async (e, t) => {
  var n, a, r, i;
  let s = !1;
  const o = (c) => {
    c.tabId === e && c.frameId === 0 && (s = !0);
  };
  (a = (n = api$5.webNavigation) == null ? void 0 : n.onCommitted) == null || a.addListener(o);
  try {
    const c = await api$5.tabs.get(e).catch(() => null);
    if (c && (c.status === "loading" || t && c.url && c.url !== t) || (await sleep(ACTION_NAV_START_MS), s)) return !0;
    const d = await api$5.tabs.get(e).catch(() => null);
    return !!d && (d.status === "loading" || !!t && !!d.url && d.url !== t);
  } finally {
    (i = (r = api$5.webNavigation) == null ? void 0 : r.onCommitted) == null || i.removeListener(o);
  }
}, settleNavigation = async (e) => {
  const t = Date.now() + ACTION_NAV_SETTLE_MAX_MS;
  let s = null;
  for (; Date.now() < t; ) {
    if (s = await api$5.tabs.get(e).catch(() => null), !s) return null;
    if (s.status === "complete") return s;
    await sleep(100);
  }
  return s;
}, mutationCounterInPage = () => {
  const e = window;
  if (e.__wfMutationObserver) return e.__wfMutations ?? 0;
  const t = document.body ?? document.documentElement;
  if (!t) return 0;
  e.__wfMutations = 0;
  const s = new MutationObserver((o) => {
    e.__wfMutations = (e.__wfMutations ?? 0) + o.length;
  });
  return s.observe(t, { childList: !0, subtree: !0, attributes: !0, characterData: !0 }), e.__wfMutationObserver = s, 0;
}, readMutations = async (e) => {
  var o;
  const s = (o = (await api$5.scripting.executeScript({ target: { tabId: e }, func: mutationCounterInPage, world: "MAIN" }).catch(() => []))[0]) == null ? void 0 : o.result;
  return typeof s == "number" ? s : 0;
}, domQuietInPage = (e, t) => new Promise((s) => {
  const o = document.body ?? document.documentElement;
  if (!o) return s(!1);
  let n = !1, a = null;
  const r = () => {
    c.disconnect(), a && clearTimeout(a), clearTimeout(d), s(n);
  }, i = () => {
    a && clearTimeout(a), a = setTimeout(r, e);
  }, c = new MutationObserver(() => {
    n = !0, i();
  });
  c.observe(o, { childList: !0, subtree: !0, attributes: !0, characterData: !0 });
  const d = setTimeout(r, t);
  i();
}), domSettled = async (e) => {
  var s;
  return ((s = (await api$5.scripting.executeScript({
    target: { tabId: e },
    func: domQuietInPage,
    args: [ACTION_DOM_QUIET_MS, ACTION_DOM_QUIET_MAX_MS]
  }).catch(() => []))[0]) == null ? void 0 : s.result) === !0;
}, captureBefore = async (e) => {
  try {
    const t = await api$5.tabs.get(e).catch(() => null);
    return { url: (t == null ? void 0 : t.url) ?? "", mutations: await readMutations(e) };
  } catch {
    return { url: "", mutations: 0 };
  }
}, waitAfterAction = async (e, t) => {
  try {
    if (await navigationStarted(e, (t == null ? void 0 : t.url) ?? "")) {
      const a = await settleNavigation(e);
      return a ? { navigated: { url: a.url ?? "", title: a.title ?? "" } } : {};
    }
    const s = await domSettled(e), o = await readMutations(e);
    return { domChanged: s || t !== void 0 && o > t.mutations };
  } catch {
    return {};
  }
}, api$4 = globalThis.chrome, WOLFFISH_GROUP_TITLE = "Wolffish", WOLFFISH_GROUP_COLOR = "blue", KEY_WORKSPACES = "wf:workspaces", DEFAULT_SESSION = "_", MAX_SESSIONS = 32, PRUNE_GRACE_MS = 10 * 6e4, stateArea$1 = () => api$4.storage.session ?? api$4.storage.local, readAll = async () => {
  try {
    const e = await stateArea$1().get(KEY_WORKSPACES), t = e == null ? void 0 : e[KEY_WORKSPACES];
    return t && typeof t == "object" ? t : {};
  } catch {
    return {};
  }
}, writeAll = async (e) => {
  try {
    await stateArea$1().set({ [KEY_WORKSPACES]: e });
  } catch {
  }
};
let chain = Promise.resolve();
const mutate = (e) => {
  const t = async () => {
    const o = await readAll(), n = await e(o);
    return await writeAll(o), n;
  }, s = chain.then(t, t);
  return chain = s.then(
    () => {
    },
    () => {
    }
  ), s;
}, sessionKey = (e) => (e ?? "").trim() || DEFAULT_SESSION, groupAlive = async (e) => !api$4.tabGroups || typeof e != "number" ? !1 : api$4.tabGroups.get(e).then(() => !0).catch(() => !1), tabAlive = async (e) => typeof e != "number" ? !1 : api$4.tabs.get(e).then(() => !0).catch(() => !1), prune = async (e) => {
  const t = Date.now();
  for (const [o, n] of Object.entries(e))
    t - (n.at ?? 0) < PRUNE_GRACE_MS || await groupAlive(n.groupId) || await tabAlive(n.tabId) || delete e[o];
  const s = Object.keys(e);
  s.length <= MAX_SESSIONS || s.sort((o, n) => (e[o].at ?? 0) - (e[n].at ?? 0)).slice(0, s.length - MAX_SESSIONS).forEach((o) => delete e[o]);
}, entryFor = async (e, t) => {
  const s = sessionKey(t);
  return e[s] ? e[s].at = Date.now() : (await prune(e), e[s] = { at: Date.now() }), e[s];
}, formatLabel = (e) => {
  const t = ((e == null ? void 0 : e.emoji) ?? "").trim(), s = ((e == null ? void 0 : e.text) ?? "").trim();
  return t && s ? `${t} ${s}` : t || s || WOLFFISH_GROUP_TITLE;
}, paintGroup = async (e, t) => {
  if (api$4.tabGroups)
    try {
      await api$4.tabGroups.update(e, { title: formatLabel(t), color: WOLFFISH_GROUP_COLOR });
    } catch {
    }
}, groupTab = async (e, t) => {
  if (!(!api$4.tabGroups || !api$4.tabs.group)) {
    if (await groupAlive(e.groupId))
      try {
        await api$4.tabs.group({ groupId: e.groupId, tabIds: [t] }), await paintGroup(e.groupId, e.label);
        return;
      } catch {
        e.groupId = void 0;
      }
    try {
      const s = await api$4.tabs.get(t), o = await api$4.tabs.group({ tabIds: [t], createProperties: { windowId: s.windowId } });
      e.groupId = o, await paintGroup(o, e.label);
    } catch (s) {
      e.groupId = void 0, log("tab groups unavailable:", s instanceof Error ? s.message : String(s));
    }
  }
}, getWorkspaceGroupIds = async () => {
  if (!api$4.tabGroups) return [];
  const e = await readAll(), t = [...new Set(Object.values(e).map((o) => o.groupId))], s = [];
  for (const o of t)
    await groupAlive(o) && s.push(o);
  return s;
}, isWorkspaceTab = async (e) => typeof e.groupId != "number" || e.groupId < 0 ? !1 : (await getWorkspaceGroupIds()).includes(e.groupId), adoptTab = async (e, t) => mutate(async (s) => {
  const o = await entryFor(s, t);
  o.tabId = e, await groupTab(o, e);
}), openWorkspaceTab = async ({ url: e, active: t = !0, session: s } = {}) => mutate(async (o) => {
  const n = await entryFor(o, s), r = (await api$4.tabs.create({ url: e || "about:blank", active: t })).id;
  return n.tabId = r, await groupTab(n, r), r;
}), ensureWorkspaceTab = async (e) => mutate(async (t) => {
  const s = await entryFor(t, e);
  if (await tabAlive(s.tabId)) return s.tabId;
  const n = (await api$4.tabs.create({ url: "about:blank", active: !0 })).id;
  return s.tabId = n, await groupTab(s, n), n;
}), peekWorkspaceTab = async (e) => {
  const s = (await readAll())[sessionKey(e)];
  return s && await tabAlive(s.tabId) ? s.tabId : null;
}, rememberWorkspaceTab = async (e, t) => {
  const s = await api$4.tabs.get(e).catch(() => null);
  return !s || !await isWorkspaceTab(s) ? !1 : (await mutate(async (o) => {
    const n = await entryFor(o, t);
    n.tabId = e;
  }), !0);
}, getActivityLabel = async (e, t) => {
  const s = await readAll();
  if (t) {
    const i = s[sessionKey(t)];
    if (i != null && i.label) return i.label;
  }
  const o = await api$4.tabs.get(e).catch(() => null), n = Object.values(s), r = (o && typeof o.groupId == "number" && o.groupId >= 0 ? n.find((i) => i.groupId === o.groupId) : void 0) ?? n.find((i) => i.tabId === e);
  return (r == null ? void 0 : r.label) ?? null;
}, setActivity = async (e, t) => mutate(async (s) => {
  var r, i;
  const o = await entryFor(s, t), n = { emoji: ((r = e.emoji) == null ? void 0 : r.trim()) || void 0, text: ((i = e.text) == null ? void 0 : i.trim()) || void 0 };
  o.label = n;
  const a = await groupAlive(o.groupId);
  return a && await paintGroup(o.groupId, n), { title: formatLabel(n), applied: a };
}), api$3 = globalThis.chrome, IDLE_ALARM = "wolffish-overlay-idle", pillMode = (e) => e === "input" ? "working" : "reading", inUse = /* @__PURE__ */ new Map(), lastCursor = /* @__PURE__ */ new Map();
let enabled = !0;
const stateArea = () => api$3.storage.session ?? api$3.storage.local, persist = () => {
  const e = {};
  for (const [t, s] of inUse) e[String(t)] = s;
  stateArea().set({ [STORAGE_KEY_INUSE]: e }).catch(() => {
  });
}, readEnabled = async () => {
  try {
    return (await api$3.storage.local.get([STORAGE_KEY_OVERLAY_ENABLED]))[STORAGE_KEY_OVERLAY_ENABLED] !== !1;
  } catch {
    return !0;
  }
}, initOverlayDriver = async () => {
  enabled = await readEnabled();
  try {
    const e = await stateArea().get([STORAGE_KEY_INUSE]), t = (e == null ? void 0 : e[STORAGE_KEY_INUSE]) ?? {};
    for (const [s, o] of Object.entries(t)) inUse.set(Number(s), o);
  } catch {
  }
};
api$3.storage.onChanged.addListener((e, t) => {
  if (!(t !== "local" || !(STORAGE_KEY_OVERLAY_ENABLED in e)) && (enabled = e[STORAGE_KEY_OVERLAY_ENABLED].newValue !== !1, log(`Overlay ${enabled ? "enabled" : "disabled"}`), !enabled))
    for (const s of inUse.keys()) post(s, { type: "overlay", op: "hide" }, !0);
});
const setOverlayEnabled = async (e) => {
  await api$3.storage.local.set({ [STORAGE_KEY_OVERLAY_ENABLED]: e }).catch(() => {
  }), enabled = e;
}, isOverlayEnabled = () => enabled, post = async (e, t, s = !1) => {
  if (!(!enabled && !s))
    try {
      await ensureContentScriptInjected(e), await api$3.tabs.sendMessage(e, {
        source: "service-worker",
        target: "content-script",
        payload: t
      });
    } catch {
    }
}, pillText = async (e, t) => {
  const s = await getActivityLabel(e, t), o = ((s == null ? void 0 : s.emoji) ?? "").trim(), n = ((s == null ? void 0 : s.text) ?? "").trim();
  if (!(!o && !n))
    return [o, n].filter(Boolean).join(" ");
}, markTabInUse = async (e, t, s) => {
  const o = inUse.get(e);
  inUse.set(e, { at: Date.now(), kind: t }), persist(), api$3.alarms.create(IDLE_ALARM, { delayInMinutes: OVERLAY_IDLE_ALARM_MINUTES }), enabled && (o && o.kind === t || await post(e, { type: "overlay", op: "pill", mode: pillMode(t), text: await pillText(e, s) }));
}, clearTab = async (e) => {
  inUse.delete(e), lastCursor.delete(e), persist(), await post(e, { type: "overlay", op: "hide" }, !0);
};
api$3.alarms.onAlarm.addListener((e) => {
  if (e.name !== IDLE_ALARM) return;
  const t = Date.now();
  for (const [s, o] of [...inUse])
    t - o.at > OVERLAY_IDLE_MS && clearTab(s);
  inUse.size > 0 && api$3.alarms.create(IDLE_ALARM, { delayInMinutes: OVERLAY_IDLE_ALARM_MINUTES });
});
api$3.tabs.onRemoved.addListener((e) => {
  inUse.delete(e), lastCursor.delete(e), persist();
});
var k, B;
(B = (k = api$3.webNavigation) == null ? void 0 : k.onCompleted) == null || B.addListener(async (e) => {
  if (e.frameId !== 0 || !enabled) return;
  const t = inUse.get(e.tabId);
  if (!t || Date.now() - t.at > OVERLAY_IDLE_MS) return;
  await post(e.tabId, {
    type: "overlay",
    op: "pill",
    mode: pillMode(t.kind),
    text: await pillText(e.tabId)
  });
  const s = lastCursor.get(e.tabId);
  s && await post(e.tabId, {
    type: "overlay",
    op: "cursor",
    x: s.x,
    y: s.y,
    kind: s.kind ?? "pointer",
    label: s.label,
    animate: !1
  });
});
const overlayDriver = {
  beforeCapture: async (e) => {
    await post(e, { type: "overlay", op: "capture_hide" });
  },
  afterCapture: async (e) => {
    await post(e, { type: "overlay", op: "capture_show" });
  },
  cursor: async (e, t, s, o, n) => {
    lastCursor.set(e, { x: t, y: s, kind: o, label: n }), await post(e, {
      type: "overlay",
      op: "cursor",
      x: t,
      y: s,
      kind: o ?? "pointer",
      label: n,
      animate: !0
    });
  },
  pulse: async (e) => {
    await post(e, { type: "overlay", op: "pulse" });
  },
  target: async (e, t) => {
    await post(e, { type: "overlay", op: "target", rect: t });
  }
}, api$2 = globalThis.chrome, sendCDP = async (e, t, s = {}) => api$2.debugger.sendCommand({ tabId: e }, t, s), findInertElement = async (e) => {
  var s;
  return (s = (await api$2.scripting.executeScript({
    target: { tabId: e },
    func: () => {
      const o = /* @__PURE__ */ new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "DETAILS", "SUMMARY"]), n = [], a = document.querySelectorAll("div, span, p, section, article, li, td, th, h1, h2, h3, h4, h5, h6");
      for (let r = 0; r < a.length && n.length < 30; r++) {
        const i = a[r], c = i.getBoundingClientRect();
        c.width < 10 || c.height < 10 || c.top < 0 || c.left < 0 || c.bottom > window.innerHeight || c.right > window.innerWidth || o.has(i.tagName) || i.closest("a, button, input, select, textarea, label") || i.getAttribute("role") === "button" || i.getAttribute("role") === "link" || i.onclick || i.getAttribute("onclick") || n.push({
          x: Math.round(c.left + c.width / 2),
          y: Math.round(c.top + c.height / 2)
        });
      }
      return n.length === 0 ? null : n[Math.floor(Math.random() * n.length)];
    },
    world: "MAIN"
  }))[0]) == null ? void 0 : s.result;
}, actionRandomPause = {
  name: "random_pause",
  execute: async () => {
    const e = gaussianDelay(800, 2e3);
    return await sleep$1(e), e;
  }
}, actionMicroScroll = {
  name: "micro_scroll",
  execute: async (e) => {
    const { attached: t } = getDebuggerState(), s = gaussianDelay(20, 60), o = Math.random() > 0.5 ? 1 : -1, n = performance.now();
    if (t) {
      const a = getCursorPosition();
      await sendCDP(e, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: a.x || 400,
        y: a.y || 400,
        deltaX: 0,
        deltaY: s * o
      }), await sleep$1(gaussianDelay(200, 500)), Math.random() > 0.4 && await sendCDP(e, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: a.x || 400,
        y: a.y || 400,
        deltaX: 0,
        deltaY: -s * o
      });
    } else
      await api$2.scripting.executeScript({
        target: { tabId: e },
        func: (a, r) => {
          window.scrollBy({ left: 0, top: a * r, behavior: "smooth" });
        },
        args: [s, o],
        world: "MAIN"
      }), await sleep$1(gaussianDelay(200, 500));
    return Math.round(performance.now() - n);
  }
}, actionCursorMove = {
  name: "cursor_move",
  execute: async (e) => {
    const t = performance.now(), s = await findInertElement(e);
    return s ? (await handleMouseMove({ x: s.x, y: s.y }), Math.round(performance.now() - t)) : (await sleep$1(gaussianDelay(500, 1e3)), Math.round(performance.now() - t));
  }
}, actionHoverInert = {
  name: "hover_inert",
  execute: async (e) => {
    const t = performance.now(), s = await findInertElement(e);
    return s ? (await handleMouseMove({ x: s.x, y: s.y }), await sleep$1(gaussianDelay(300, 800)), Math.round(performance.now() - t)) : (await sleep$1(gaussianDelay(300, 800)), Math.round(performance.now() - t));
  }
}, actionVariableScroll = {
  name: "variable_scroll",
  execute: async (e) => {
    const { attached: t } = getDebuggerState(), s = performance.now(), o = gaussianDelay(2, 4);
    for (let n = 0; n < o; n++) {
      const a = gaussianDelay(15, 40);
      if (t) {
        const r = getCursorPosition();
        await sendCDP(e, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: r.x || 400,
          y: r.y || 400,
          deltaX: 0,
          deltaY: a
        });
      } else
        await api$2.scripting.executeScript({
          target: { tabId: e },
          func: (r) => window.scrollBy({ left: 0, top: r, behavior: "smooth" }),
          args: [a],
          world: "MAIN"
        });
      await sleep$1(gaussianDelay(100, 300));
    }
    return Math.round(performance.now() - s);
  }
}, actionScrollBounce = {
  name: "scroll_bounce",
  execute: async (e) => {
    const { attached: t } = getDebuggerState(), s = performance.now(), o = gaussianDelay(80, 200);
    if (t) {
      const n = getCursorPosition();
      await sendCDP(e, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: n.x || 400,
        y: n.y || 400,
        deltaX: 0,
        deltaY: o
      }), await sleep$1(gaussianDelay(500, 1200)), await sendCDP(e, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: n.x || 400,
        y: n.y || 400,
        deltaX: 0,
        deltaY: -o
      });
    } else
      await api$2.scripting.executeScript({
        target: { tabId: e },
        func: (n) => window.scrollBy({ left: 0, top: n, behavior: "smooth" }),
        args: [o],
        world: "MAIN"
      }), await sleep$1(gaussianDelay(500, 1200)), await api$2.scripting.executeScript({
        target: { tabId: e },
        func: (n) => window.scrollBy({ left: 0, top: -n, behavior: "smooth" }),
        args: [o],
        world: "MAIN"
      });
    return await sleep$1(gaussianDelay(200, 400)), Math.round(performance.now() - s);
  }
}, actionIdleDrift = {
  name: "idle_drift",
  execute: async (e) => {
    const { attached: t } = getDebuggerState(), s = performance.now();
    if (!t)
      return await sleep$1(gaussianDelay(1e3, 2e3)), Math.round(performance.now() - s);
    const o = getCursorPosition(), n = gaussianDelay(3, 6);
    for (let a = 0; a < n; a++) {
      const r = gaussianDelay(-5, 5), i = gaussianDelay(-5, 5), c = Math.max(0, o.x + r), d = Math.max(0, o.y + i);
      await sendCDP(e, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: c,
        y: d
      }), await sleep$1(gaussianDelay(200, 400));
    }
    return Math.round(performance.now() - s);
  }
}, actionLongPause = {
  name: "long_pause",
  execute: async () => {
    const e = gaussianDelay(2e3, 5e3);
    return await sleep$1(e), e;
  }
}, POOLS = {
  light: [actionRandomPause, actionMicroScroll],
  moderate: [actionRandomPause, actionMicroScroll, actionCursorMove, actionHoverInert, actionVariableScroll],
  heavy: [
    actionRandomPause,
    actionMicroScroll,
    actionCursorMove,
    actionHoverInert,
    actionVariableScroll,
    actionScrollBounce,
    actionIdleDrift,
    actionLongPause
  ]
}, handleHumanize = async (e) => {
  const t = e.intensity ?? "moderate", s = await resolveTabId(e), o = POOLS[t], n = o[Math.floor(Math.random() * o.length)];
  log(`Humanize (${t}): executing ${n.name}`);
  const a = await n.execute(s);
  return log(`Humanize: ${n.name} completed in ${a}ms`), { action: n.name, duration_ms: a };
}, api$1 = globalThis.chrome, INSTANCE_ID_KEY = "wf:instance-id", detectOS = (e, t) => {
  var o;
  const s = ((o = e.userAgentData) == null ? void 0 : o.platform) ?? "";
  return /mac/i.test(s) || /Mac OS X/.test(t) ? "macOS" : /win/i.test(s) || /Windows NT/.test(t) ? "Windows" : /CrOS/.test(t) ? "ChromeOS" : /android/i.test(s) || /Android/.test(t) ? "Android" : /linux/i.test(s) || /Linux/.test(t) ? "Linux" : s || "";
}, uaVersion = (e, t) => {
  const s = e.match(new RegExp(`${t}/([\\d.]+)`));
  return (s == null ? void 0 : s[1]) ?? "";
}, detectBrand = async (e, t) => {
  var a, r, i, c, d;
  try {
    const m = globalThis.browser, l = await ((r = (a = m == null ? void 0 : m.runtime) == null ? void 0 : a.getBrowserInfo) == null ? void 0 : r.call(a));
    if (l != null && l.name)
      return { browser: l.name.toLowerCase(), browserName: l.name, browserVersion: l.version };
  } catch {
  }
  const s = ((i = e.userAgentData) == null ? void 0 : i.brands) ?? [], o = (m) => s.find((l) => l.brand.toLowerCase().includes(m)), n = [
    { needle: "microsoft edge", slug: "edge", name: "Microsoft Edge" },
    { needle: "opera", slug: "opera", name: "Opera" },
    { needle: "brave", slug: "brave", name: "Brave" },
    { needle: "vivaldi", slug: "vivaldi", name: "Vivaldi" },
    { needle: "google chrome", slug: "chrome", name: "Google Chrome" }
  ];
  for (const { needle: m, slug: l, name: u } of n) {
    const g = o(m);
    if (g) return { browser: l, browserName: u, browserVersion: g.version || uaVersion(t, "Chrome") };
  }
  try {
    if (await ((d = (c = e.brave) == null ? void 0 : c.isBrave) == null ? void 0 : d.call(c)))
      return { browser: "brave", browserName: "Brave", browserVersion: uaVersion(t, "Chrome") };
  } catch {
  }
  return /Edg\//.test(t) ? { browser: "edge", browserName: "Microsoft Edge", browserVersion: uaVersion(t, "Edg") } : /OPR\//.test(t) ? { browser: "opera", browserName: "Opera", browserVersion: uaVersion(t, "OPR") } : /Firefox\//.test(t) ? { browser: "firefox", browserName: "Firefox", browserVersion: uaVersion(t, "Firefox") } : o("chromium") || /Chrome\//.test(t) ? { browser: "chromium", browserName: "Chromium", browserVersion: uaVersion(t, "Chrome") } : { browser: "browser", browserName: "Browser", browserVersion: "" };
}, getProfileEmail = async () => {
  var e;
  try {
    const t = api$1 == null ? void 0 : api$1.identity, s = await ((e = t == null ? void 0 : t.getProfileUserInfo) == null ? void 0 : e.call(t, { accountStatus: "ANY" }));
    return (s == null ? void 0 : s.email) ?? "";
  } catch {
    return "";
  }
}, getInstanceId = async () => {
  try {
    const s = (await api$1.storage.local.get([INSTANCE_ID_KEY]))[INSTANCE_ID_KEY];
    if (typeof s == "string" && s) return s;
  } catch {
  }
  const e = crypto.randomUUID();
  try {
    await api$1.storage.local.set({ [INSTANCE_ID_KEY]: e });
  } catch {
  }
  return e;
};
let cached = null;
const getBrowserIdentity = async () => {
  if (cached) return cached;
  const e = navigator, t = e.userAgent ?? "", [s, o, n] = await Promise.all([
    getInstanceId(),
    detectBrand(e, t),
    getProfileEmail()
  ]);
  return cached = { instanceId: s, ...o, os: detectOS(e, t), profileEmail: n }, cached;
}, sessionOf = (e) => {
  const t = e == null ? void 0 : e[SESSION_PARAM];
  return typeof t == "string" && t ? t : void 0;
}, api = globalThis.chrome;
setTabFallback(ensureWorkspaceTab);
let connectionStatus = "disconnected", connectionPort = DEFAULT_PORT;
const RECONNECT_ALARM = "wolffish-reconnect";
let ws = null, heartbeatTimer = null;
const stopHeartbeat = () => {
  heartbeatTimer !== null && (clearInterval(heartbeatTimer), heartbeatTimer = null);
}, startHeartbeat = () => {
  stopHeartbeat(), heartbeatTimer = setInterval(() => {
    (ws == null ? void 0 : ws.readyState) === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" }));
  }, HEARTBEAT_INTERVAL_MS);
}, setStatus = (e) => {
  connectionStatus = e, log(`Connection status: ${e}`), api.runtime.sendMessage({ type: "status_update", status: e, port: connectionPort }).catch(() => {
  });
}, scheduleReconnect = () => {
  api.alarms.create(RECONNECT_ALARM, { delayInMinutes: RECONNECT_ALARM_MINUTES });
};
api.alarms.onAlarm.addListener((e) => {
  e.name === RECONNECT_ALARM && connectionStatus !== "connected" && connectWebSocket(connectionPort);
});
const connectWebSocket = async (e) => {
  ws && (ws.onopen = null, ws.onclose = null, ws.onerror = null, ws.onmessage = null, (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) && ws.close(), ws = null), connectionPort = e;
  try {
    await fetch(`http://localhost:${e}`, { mode: "no-cors" });
  } catch {
    setStatus("disconnected"), scheduleReconnect();
    return;
  }
  setStatus("connecting"), log(`Connecting to ws://localhost:${e}`), ws = new WebSocket(`ws://localhost:${e}`), ws.onopen = () => {
    setStatus("connected"), api.alarms.clear(RECONNECT_ALARM), startHeartbeat(), log("Connected");
    const t = api.runtime.getManifest();
    Promise.all([getBrowserIdentity().catch(() => null), readBridgeToken()]).then(([s, o]) => {
      sendToServer({
        type: "extension_info",
        version: t.version,
        extensionId: api.runtime.id,
        bridgeToken: o,
        overlayEnabled: isOverlayEnabled(),
        ...s ?? {}
      }), sendToServer({ type: "get_conversations" });
    });
  }, ws.onclose = () => {
    setStatus("disconnected"), stopHeartbeat(), log("Disconnected"), scheduleReconnect();
  }, ws.onerror = () => {
    log("WebSocket error");
  }, ws.onmessage = (t) => {
    try {
      const s = JSON.parse(t.data);
      if (s.type === "pong") return;
      if (s.type === "event") {
        handleWolffishEvent(s);
        return;
      }
      if (s.id && s.type) {
        handleCommand(s);
        return;
      }
    } catch (s) {
      logError("Failed to parse WebSocket message", s);
    }
  };
}, readBridgeToken = async () => {
  try {
    const e = await fetch(api.runtime.getURL(BRIDGE_TOKEN_FILE));
    if (!e.ok) return null;
    const t = await e.json();
    return typeof t.token == "string" && t.token ? t.token : null;
  } catch {
    return null;
  }
}, sendToServer = (e) => {
  (ws == null ? void 0 : ws.readyState) === WebSocket.OPEN && ws.send(JSON.stringify(e));
}, waitForTabSettled = (e, t, s) => new Promise((o) => {
  var u, g;
  let n = !1, a = !1;
  const r = () => {
    var f, R;
    clearTimeout(l), clearInterval(m), (R = (f = api.webNavigation) == null ? void 0 : f.onCompleted) == null || R.removeListener(d);
  }, i = (f) => {
    n || (n = !0, r(), o(f));
  }, c = async () => {
    const f = await api.tabs.get(e).catch(() => null);
    f && ((f.status === "loading" || f.url && f.url !== t) && (a = !0), f.status === "complete" && a && i(f));
  }, d = (f) => {
    f.tabId === e && f.frameId === 0 && (a = !0, c());
  };
  (g = (u = api.webNavigation) == null ? void 0 : u.onCompleted) == null || g.addListener(d);
  const m = setInterval(() => void c(), 100), l = setTimeout(() => {
    api.tabs.get(e).then(i).catch(() => i(null));
  }, s);
}), handleNavigate = async (e) => {
  const { url: t, waitUntil: s, newTab: o } = e, n = o ? await openWorkspaceTab({ session: sessionOf(e) }) : await resolveTabId(e), a = await api.tabs.get(n).catch(() => null), r = (a == null ? void 0 : a.url) ?? "";
  await api.tabs.update(n, { url: t });
  const c = await waitForTabSettled(n, r, COMMAND_TIMEOUT_MS) ?? await api.tabs.get(n).catch(() => null);
  if (s && (!c || c.status !== "complete"))
    throw new Error(`Navigation timed out waiting for '${s}'`);
  return { url: (c == null ? void 0 : c.url) || t, title: (c == null ? void 0 : c.title) || "", tabId: n };
}, handleBack = async (e) => {
  const t = await resolveTabId(e);
  return await api.scripting.executeScript({
    target: { tabId: t },
    func: () => history.back()
  }), { success: !0 };
}, handleForward = async (e) => {
  const t = await resolveTabId(e);
  return await api.scripting.executeScript({
    target: { tabId: t },
    func: () => history.forward()
  }), { success: !0 };
}, handleReload = async (e) => {
  const { hard: t } = e, s = await resolveTabId(e);
  return await api.tabs.reload(s, { bypassCache: t ?? !1 }), { success: !0 };
}, handleTabsList = async (e) => {
  const { windowId: t } = e, s = t !== void 0 ? { windowId: t } : {}, o = await api.tabs.query(s), n = await getWorkspaceGroupIds();
  return {
    tabs: o.map((a) => ({
      id: a.id,
      url: a.url || "",
      title: a.title || "",
      active: a.active,
      pinned: a.pinned,
      windowId: a.windowId,
      groupId: a.groupId,
      wolffish: typeof a.groupId == "number" && n.includes(a.groupId)
    }))
  };
}, handleTabOpen = async (e) => {
  const { url: t, active: s } = e, o = await openWorkspaceTab({ url: t, active: s ?? !0, session: sessionOf(e) }), n = await api.tabs.get(o).catch(() => null);
  return {
    tabId: o,
    url: (n == null ? void 0 : n.pendingUrl) || (n == null ? void 0 : n.url) || t || ""
  };
}, handleTabClose = async (e) => {
  const { tabId: t } = e;
  return await api.tabs.remove(t), { success: !0 };
}, handleTabSwitch = async (e) => {
  const { tabId: t } = e;
  return await api.tabs.update(t, { active: !0 }), await rememberWorkspaceTab(t, sessionOf(e)), { success: !0 };
}, handleTabDuplicate = async (e) => {
  const { tabId: t } = e, s = await api.tabs.duplicate(t);
  if (!s)
    throw new Error(`Failed to duplicate tab ${t}`);
  return await adoptTab(s.id, sessionOf(e)), { tabId: s.id };
}, handleTabMove = async (e) => {
  const { tabId: t, index: s, windowId: o } = e, n = { index: s };
  return o !== void 0 && (n.windowId = o), await api.tabs.move(t, n), { success: !0 };
}, handleWindowsList = async () => ({
  windows: (await api.windows.getAll({ populate: !0 })).map((t) => {
    var s;
    return {
      id: t.id,
      focused: t.focused,
      tabs: ((s = t.tabs) == null ? void 0 : s.length) ?? 0,
      type: t.type || "normal",
      state: t.state || "normal"
    };
  })
}), handleWindowOpen = async (e) => {
  var i, c;
  const { url: t, incognito: s, width: o, height: n } = e, a = {};
  t !== void 0 && (a.url = t), s !== void 0 && (a.incognito = s), o !== void 0 && (a.width = o), n !== void 0 && (a.height = n);
  const r = await api.windows.create(a);
  return { windowId: r.id, tabId: (c = (i = r.tabs) == null ? void 0 : i[0]) == null ? void 0 : c.id };
}, handleWindowClose = async (e) => {
  const { windowId: t } = e;
  return await api.windows.remove(t), { success: !0 };
}, handleWindowResize = async (e) => {
  const { windowId: t, width: s, height: o, left: n, top: a, state: r } = e, i = {};
  return s !== void 0 && (i.width = s), o !== void 0 && (i.height = o), n !== void 0 && (i.left = n), a !== void 0 && (i.top = a), r !== void 0 && (i.state = r), await api.windows.update(t, i), { success: !0 };
}, handleScreenshot = async (e) => {
  const { format: t, quality: s, fullPage: o, selector: n, uid: a } = e, r = await resolveTabId(e);
  if (hasSession(r))
    return handleCDPScreenshot({ ...e, tabId: r });
  if (o || n || a)
    throw new Error("Full-page and element screenshots need the debugger. Call ext_debugger_attach first.");
  const i = t === "jpeg" ? "jpeg" : "png", c = { format: i };
  i === "jpeg" && s !== void 0 && (c.quality = s);
  let d = await api.tabs.get(r);
  d.active || (await api.tabs.update(r, { active: !0 }), await new Promise((R) => setTimeout(R, 150)), d = await api.tabs.get(r)), await overlayHooks.beforeCapture(r).catch(() => {
  });
  let m;
  try {
    m = await api.tabs.captureVisibleTab(d.windowId, c);
  } finally {
    overlayHooks.afterCapture(r).catch(() => {
    });
  }
  const l = await api.scripting.executeScript({
    target: { tabId: r },
    func: () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
    world: "MAIN"
  }).then((R) => {
    var A;
    return (A = R[0]) == null ? void 0 : A.result;
  }).catch(() => {
  }), u = (l == null ? void 0 : l.w) ?? 0, g = (l == null ? void 0 : l.h) ?? 0, f = (l == null ? void 0 : l.dpr) ?? 1;
  return {
    image: m,
    width: Math.round(u * f),
    height: Math.round(g * f),
    cssWidth: u,
    cssHeight: g,
    dpr: f,
    mode: "visible"
  };
}, handlePdf = async (e) => {
  if (isFirefox())
    throw new Error("PDF generation is not supported on Firefox");
  const t = await resolveTabId(e);
  await api.debugger.attach({ tabId: t }, "1.3");
  try {
    return { data: (await api.debugger.sendCommand({ tabId: t }, "Page.printToPDF", {})).data };
  } finally {
    await api.debugger.detach({ tabId: t }).catch(() => {
    });
  }
}, handleCookiesGet = async (e) => {
  const { domain: t, name: s } = e, o = { domain: t };
  return s !== void 0 && (o.name = s), {
    cookies: (await api.cookies.getAll(o)).map((a) => ({
      name: a.name,
      value: a.value,
      domain: a.domain,
      path: a.path,
      expires: a.expirationDate || -1,
      httpOnly: a.httpOnly,
      secure: a.secure
    }))
  };
}, handleCookiesSet = async (e) => {
  const { url: t, name: s, value: o, domain: n, path: a, expires: r, httpOnly: i, secure: c } = e, d = { url: t, name: s, value: o };
  return n !== void 0 && (d.domain = n), a !== void 0 && (d.path = a), r !== void 0 && (d.expirationDate = r), i !== void 0 && (d.httpOnly = i), c !== void 0 && (d.secure = c), await api.cookies.set(d), { success: !0 };
}, handleCookiesRemove = async (e) => {
  const { url: t, name: s } = e;
  return await api.cookies.remove({ url: t, name: s }), { success: !0 };
}, handleDownload = async (e) => {
  const { url: t, filename: s, waitMs: o } = e, n = { url: t };
  s !== void 0 && (n.filename = s);
  const a = await api.downloads.download(n), r = Number.isFinite(o) ? Math.max(0, o) : 6e4;
  return r === 0 ? { downloadId: a, state: "in_progress" } : new Promise((i) => {
    let c = !1;
    const d = (g) => {
      c || (c = !0, clearTimeout(u), api.downloads.onChanged.removeListener(l), i(g));
    }, m = async () => {
      const [g] = await api.downloads.search({ id: a }).catch(() => []);
      g && (g.state === "complete" ? d({ downloadId: a, state: "complete", filename: g.filename }) : g.state === "interrupted" && d({ downloadId: a, state: "interrupted", error: g.error ?? "interrupted" }));
    }, l = (g) => {
      g.id === a && m();
    };
    api.downloads.onChanged.addListener(l);
    const u = setTimeout(() => d({ downloadId: a, state: "in_progress" }), r);
    m();
  });
}, handleExecuteJs = async (params) => {
  var e;
  const { code, world } = params, tabId = await resolveTabId(params);
  if (hasSession(tabId))
    return handleCDPExecuteJs({ ...params, tabId });
  const results = await api.scripting.executeScript({
    target: { tabId },
    func: (source) => eval(source),
    args: [code],
    world: world || "MAIN"
  });
  return { result: (e = results[0]) == null ? void 0 : e.result };
}, handleWaitForNavigation = async (e) => {
  const { timeout: t } = e, s = await resolveTabId(e), o = t ?? COMMAND_TIMEOUT_MS, n = await api.tabs.get(s).then((a) => a.url || "").catch(() => "");
  return new Promise((a) => {
    let r = !1;
    const i = (l, u) => {
      r || (r = !0, clearTimeout(c), api.webNavigation.onCompleted.removeListener(d), api.tabs.onUpdated.removeListener(m), a({ url: l, title: u }));
    }, c = setTimeout(() => {
      api.tabs.get(s).then((l) => i(l.url || "", l.title || "")).catch(() => i(n, ""));
    }, o), d = (l) => {
      l.tabId === s && l.frameId === 0 && api.tabs.get(s).then((u) => i(u.url || l.url, u.title || "")).catch(() => i(l.url, ""));
    }, m = (l, u) => {
      l === s && u.url && u.url !== n && api.tabs.get(s).then((g) => i(g.url || u.url, g.title || "")).catch(() => i(u.url, ""));
    };
    api.webNavigation.onCompleted.addListener(d), api.tabs.onUpdated.addListener(m);
  });
}, handleWait = async (e) => {
  const t = e, s = t.timeout_ms ?? t.timeout ?? t.ms, o = t.type ?? (t.selector ? "selector" : "timeout");
  if (o === "navigation")
    return handleWaitForNavigation({ timeout: s, tabId: t.tabId });
  if (o === "selector" || o === "network_idle") {
    if (o === "selector" && !t.selector)
      throw new Error("selector is required for type=selector");
    const r = await resolveTabId(t);
    await ensureContentScriptInjected(r);
    const i = {
      id: generateId(),
      type: o === "selector" ? WolffishCommands.BROWSER_WAIT_FOR : WolffishCommands.BROWSER_WAIT_FOR_NETWORK_IDLE,
      params: o === "selector" ? { selector: t.selector, timeout: s, visible: t.visible, tabId: r } : { timeout: s, tabId: r }
    }, c = await sendToContentScript(r, {
      source: "service-worker",
      target: "content-script",
      payload: i
    });
    if (!(c != null && c.success))
      throw new Error((c == null ? void 0 : c.error) ?? `${o} wait failed`);
    return c.data;
  }
  const n = Number(s), a = Number.isFinite(n) && n > 0 ? n : 0;
  return await new Promise((r) => setTimeout(r, a)), { waited: a };
}, handleNotify = async (e) => {
  const { title: t, message: s, iconUrl: o } = e;
  return { notificationId: await api.notifications.create("", {
    type: "basic",
    title: t,
    message: s,
    iconUrl: o || api.runtime.getURL("icon-128.png")
  }) };
}, handleSetActivity = async (e) => {
  const { emoji: t, text: s } = e;
  return setActivity({ emoji: t, text: s }, sessionOf(e));
}, handleGetUrl = async (e) => {
  const t = await resolveTabId(e), s = await api.tabs.get(t);
  return { url: s.url || "", title: s.title || "" };
}, relayToContentScript = async (e, t) => {
  const s = await resolveTabId(t);
  await ensureContentScriptInjected(s);
  const o = await sendToContentScript(s, {
    source: "service-worker",
    target: "content-script",
    payload: { id: generateId(), type: e, params: t }
  });
  if (!(o != null && o.success)) throw new Error((o == null ? void 0 : o.error) ?? `${e} failed`);
  return o.data;
}, doctorTabId = async (e) => {
  const t = e.tabId;
  if (typeof t == "number" && await api.tabs.get(t).catch(() => null)) return t;
  const s = await peekWorkspaceTab(sessionOf(e));
  if (s !== null) return s;
  const [o] = await api.tabs.query({ active: !0, currentWindow: !0 }).catch(() => []);
  return typeof (o == null ? void 0 : o.id) == "number" ? o.id : null;
}, handleDoctor = async (e) => {
  const t = api.runtime.getManifest(), s = async (l, u) => {
    try {
      return await l();
    } catch {
      return u;
    }
  }, o = await s(
    () => {
      var l;
      return ((l = api.permissions) == null ? void 0 : l.contains({ origins: ["<all_urls>"] })) ?? Promise.resolve(null);
    },
    null
  ), n = await s(
    () => {
      var l, u;
      return ((u = (l = api.extension) == null ? void 0 : l.isAllowedIncognitoAccess) == null ? void 0 : u.call(l)) ?? Promise.resolve(null);
    },
    null
  ), a = await s(
    () => {
      var l, u;
      return ((u = (l = api.extension) == null ? void 0 : l.isAllowedFileSchemeAccess) == null ? void 0 : u.call(l)) ?? Promise.resolve(null);
    },
    null
  ), r = await s(
    async () => {
      var l, u;
      return await ((u = (l = api.notifications) == null ? void 0 : l.getPermissionLevel) == null ? void 0 : u.call(l)) ?? null;
    },
    null
  ), i = await s(
    async () => {
      var l, u;
      return await ((u = (l = api.management) == null ? void 0 : l.getSelf) == null ? void 0 : u.call(l)) ?? null;
    },
    null
  ), c = await s(
    async () => {
      var l, u;
      return await ((u = (l = api.debugger) == null ? void 0 : l.getTargets) == null ? void 0 : u.call(l)) ?? [];
    },
    []
  );
  let d = null, m = !1;
  try {
    const l = await doctorTabId(e);
    if (l === null) throw new Error("no tab to probe");
    const u = await api.tabs.get(l).catch(() => null);
    try {
      await api.scripting.executeScript({ target: { tabId: l }, func: () => !0 }), d = { tabId: l, ok: !0, url: u == null ? void 0 : u.url };
    } catch (g) {
      const f = g instanceof Error ? g.message : String(g);
      m = /policy|ExtensionSettings|blocked by/i.test(f), d = { tabId: l, ok: !1, error: f, url: u == null ? void 0 : u.url };
    }
  } catch {
  }
  return {
    extension: {
      id: api.runtime.id,
      version: t.version,
      manifestPermissions: t.permissions ?? [],
      hostPermissions: t.host_permissions ?? []
    },
    siteAccessAllUrls: o,
    incognitoAllowed: n,
    fileSchemeAllowed: a,
    notifications: r,
    installType: (i == null ? void 0 : i.installType) ?? null,
    enabled: (i == null ? void 0 : i.enabled) ?? null,
    mayDisable: (i == null ? void 0 : i.mayDisable) ?? null,
    apis: {
      debugger: typeof api.debugger < "u",
      tabGroups: typeof api.tabGroups < "u",
      sidePanel: typeof api.sidePanel < "u",
      scripting: typeof api.scripting < "u",
      downloads: typeof api.downloads < "u"
    },
    debuggerAttachedTabs: c.filter((l) => l.attached && typeof l.tabId == "number").map((l) => l.tabId),
    scriptable: d,
    policyBlocked: m,
    overlayEnabled: isOverlayEnabled()
  };
}, handleFileUpload = async (e) => {
  const { filePaths: t } = e;
  await sessionsReady;
  const s = await resolveTabId(e);
  if (t && t.length > 0) {
    if (!hasSession(s))
      throw new Error(
        "Uploading by file path needs the debugger. Call ext_debugger_attach first, or pass files as base64 content."
      );
    return handleCDPFileUpload({ ...e, tabId: s });
  }
  return relayToContentScript(WolffishCommands.BROWSER_FILE_UPLOAD, { ...e, tabId: s });
}, SERVICE_WORKER_HANDLERS = {
  [WolffishCommands.BROWSER_NAVIGATE]: handleNavigate,
  [WolffishCommands.BROWSER_BACK]: handleBack,
  [WolffishCommands.BROWSER_FORWARD]: handleForward,
  [WolffishCommands.BROWSER_RELOAD]: handleReload,
  [WolffishCommands.BROWSER_TABS_LIST]: handleTabsList,
  [WolffishCommands.BROWSER_TAB_OPEN]: handleTabOpen,
  [WolffishCommands.BROWSER_TAB_CLOSE]: handleTabClose,
  [WolffishCommands.BROWSER_TAB_SWITCH]: handleTabSwitch,
  [WolffishCommands.BROWSER_TAB_DUPLICATE]: handleTabDuplicate,
  [WolffishCommands.BROWSER_TAB_MOVE]: handleTabMove,
  [WolffishCommands.BROWSER_WINDOWS_LIST]: handleWindowsList,
  [WolffishCommands.BROWSER_WINDOW_OPEN]: handleWindowOpen,
  [WolffishCommands.BROWSER_WINDOW_CLOSE]: handleWindowClose,
  [WolffishCommands.BROWSER_WINDOW_RESIZE]: handleWindowResize,
  [WolffishCommands.BROWSER_SCREENSHOT]: handleScreenshot,
  [WolffishCommands.BROWSER_PDF]: handlePdf,
  [WolffishCommands.BROWSER_COOKIES_GET]: handleCookiesGet,
  [WolffishCommands.BROWSER_COOKIES_SET]: handleCookiesSet,
  [WolffishCommands.BROWSER_COOKIES_REMOVE]: handleCookiesRemove,
  [WolffishCommands.BROWSER_DOWNLOAD]: handleDownload,
  [WolffishCommands.BROWSER_EXECUTE_JS]: handleExecuteJs,
  [WolffishCommands.BROWSER_WAIT]: handleWait,
  [WolffishCommands.BROWSER_WAIT_FOR_NAVIGATION]: handleWaitForNavigation,
  [WolffishCommands.BROWSER_NOTIFY]: handleNotify,
  [WolffishCommands.BROWSER_SET_ACTIVITY]: handleSetActivity,
  [WolffishCommands.BROWSER_GET_URL]: handleGetUrl,
  [WolffishCommands.DEBUGGER_ATTACH]: handleDebuggerAttach,
  [WolffishCommands.DEBUGGER_DETACH]: handleDebuggerDetach,
  [WolffishCommands.DEBUGGER_STATUS]: handleDebuggerStatus,
  [WolffishCommands.BROWSER_MOUSE_MOVE]: handleMouseMove,
  [WolffishCommands.BROWSER_MOUSE_CLICK]: handleMouseClick,
  [WolffishCommands.BROWSER_MOUSE_DOWN]: handleMouseDown,
  [WolffishCommands.BROWSER_MOUSE_UP]: handleMouseUp,
  [WolffishCommands.BROWSER_MOUSE_DRAG]: handleMouseDrag,
  [WolffishCommands.HUMANIZE]: handleHumanize,
  [WolffishCommands.BROWSER_FILE_UPLOAD]: handleFileUpload,
  // CDP-only observation: each answers with a deterministic "needs the
  // debugger" error when the resolved tab has no session.
  [WolffishCommands.BROWSER_LIST_NETWORK_REQUESTS]: handleListNetworkRequests,
  [WolffishCommands.BROWSER_GET_NETWORK_REQUEST]: handleGetNetworkRequest,
  [WolffishCommands.BROWSER_LIST_CONSOLE_MESSAGES]: handleListConsoleMessages,
  [WolffishCommands.BROWSER_HANDLE_DIALOG]: handleHandleDialog,
  [WolffishCommands.BROWSER_EMULATE]: handleEmulate,
  [WolffishCommands.BROWSER_DOCTOR]: handleDoctor
}, CDP_HANDLERS = {
  [WolffishCommands.BROWSER_CLICK]: handleCDPClick,
  [WolffishCommands.BROWSER_TYPE]: handleCDPType,
  [WolffishCommands.BROWSER_SCROLL]: handleCDPScroll,
  [WolffishCommands.BROWSER_HOVER]: handleCDPHover,
  [WolffishCommands.BROWSER_KEYPRESS]: handleCDPKeypress,
  // The v2 pairs: an accessibility-tree snapshot and uid-addressed actions
  // through CDP, each with a DOM twin in the content script for Firefox and
  // for pages the debugger cannot attach to.
  [WolffishCommands.BROWSER_TAKE_SNAPSHOT]: handleCDPTakeSnapshot,
  [WolffishCommands.BROWSER_RESOLVE_UID]: handleCDPResolveUid,
  [WolffishCommands.BROWSER_FIND]: handleCDPFind,
  [WolffishCommands.BROWSER_FILL]: handleCDPFill,
  [WolffishCommands.BROWSER_FILL_FORM]: handleCDPFillForm,
  [WolffishCommands.BROWSER_SET_VALUE]: handleCDPSetValue,
  [WolffishCommands.BROWSER_GET_VALUE]: handleCDPGetValue,
  [WolffishCommands.BROWSER_GET_ATTRIBUTE]: handleCDPGetAttribute,
  [WolffishCommands.BROWSER_FOCUS]: handleCDPFocus,
  [WolffishCommands.BROWSER_SELECT]: handleCDPSelect
}, sendResponseToServer = (e) => {
  sendToServer(e);
}, commandKind = (e) => INPUT_COMMANDS.has(e) ? "input" : READ_COMMANDS.has(e) ? "read" : null, TAB_AGNOSTIC = /* @__PURE__ */ new Set([
  WolffishCommands.BROWSER_TABS_LIST,
  WolffishCommands.BROWSER_WINDOWS_LIST,
  WolffishCommands.BROWSER_COOKIES_GET,
  WolffishCommands.BROWSER_COOKIES_SET,
  WolffishCommands.BROWSER_COOKIES_REMOVE,
  WolffishCommands.BROWSER_NOTIFY,
  WolffishCommands.BROWSER_DOWNLOAD,
  WolffishCommands.BROWSER_SET_ACTIVITY,
  WolffishCommands.DEBUGGER_STATUS,
  WolffishCommands.BROWSER_DOCTOR
]), handleCommand = async (e) => {
  var s, o;
  log("←", e.type, e.params);
  const t = typeof e.session == "string" ? e.session.trim() : "";
  e.params = t ? { ...e.params ?? {}, [SESSION_PARAM]: t } : e.params ?? {};
  try {
    let n;
    const a = commandKind(e.type);
    let r = null;
    if (TAB_AGNOSTIC.has(e.type) || (r = await resolveTabId(e.params).catch(() => null)), r !== null && DIALOG_BLOCKED_COMMANDS.has(e.type)) {
      const c = dialogOpenError(r);
      if (c) {
        sendResponseToServer(makeErrorResponse(e.id, c)), log("→", e.type, "blocked by dialog");
        return;
      }
    }
    r !== null && a && markTabInUse(r, a, t || void 0);
    const i = r !== null && INPUT_COMMANDS.has(e.type) ? await captureBefore(r) : void 0;
    if (SERVICE_WORKER_COMMANDS.has(e.type)) {
      const c = SERVICE_WORKER_HANDLERS[e.type];
      if (!c)
        n = makeErrorResponse(e.id, `No handler for command: ${e.type}`);
      else {
        const d = await withTimeout(c(e.params));
        n = makeResponse(e.id, await decorate(e.type, r, d, i));
      }
    } else if (CONTENT_SCRIPT_COMMANDS.has(e.type)) {
      if (r !== null && hasSession(r) && DEBUGGER_ROUTABLE_COMMANDS.has(e.type)) {
        const m = CDP_HANDLERS[e.type];
        if (m)
          try {
            const l = await withTimeout(m({ ...e.params, tabId: r }));
            n = makeResponse(e.id, await decorate(e.type, r, l, i)), log("→", e.type, "success (CDP)"), sendResponseToServer(n);
            return;
          } catch (l) {
            const u = l instanceof Error ? l.message : String(l);
            if (typeof ((s = e.params) == null ? void 0 : s.uid) == "string" || typeof ((o = e.params) == null ? void 0 : o.from_uid) == "string") {
              sendResponseToServer(makeErrorResponse(e.id, u)), log("→", e.type, "CDP error (uid target, no fallback):", u);
              return;
            }
            log("CDP fallback:", e.type, u);
          }
      }
      const c = r ?? await resolveTabId(e.params);
      await ensureContentScriptInjected(c);
      const d = await withTimeout(
        sendToContentScript(c, {
          source: "service-worker",
          target: "content-script",
          payload: e
        })
      );
      n = (d == null ? void 0 : d.success) === !0 ? makeResponse(e.id, await decorate(e.type, c, d.data, i)) : d;
    } else
      n = makeErrorResponse(e.id, `Unknown command: ${e.type}`);
    log("→", e.type, n.success ? "success" : n.error), sendResponseToServer(n);
  } catch (n) {
    const a = n instanceof Error ? n.message : String(n), r = makeErrorResponse(e.id, a);
    log("→", e.type, "error:", r.error), sendResponseToServer(r);
  }
}, decorate = async (e, t, s, o) => {
  if (t === null || !INPUT_COMMANDS.has(e)) return s;
  const n = await waitAfterAction(t, o);
  return !n.navigated && n.domChanged === void 0 ? s : s && typeof s == "object" && !Array.isArray(s) ? { ...s, ...n } : s;
}, CACHE_MAX_CONVERSATIONS = 50, CACHE_MAX_EVENTS = 500, cache = {
  saveConversations(e) {
    const t = e.slice(0, CACHE_MAX_CONVERSATIONS);
    api.storage.local.set({ "wf:conversations": t }).catch(() => {
    });
  },
  saveActive(e) {
    api.storage.local.set({ "wf:active": e }).catch(() => {
    });
  },
  saveEvents(e, t) {
    const s = t.slice(0, CACHE_MAX_EVENTS);
    api.storage.local.set({ [`wf:events:${e}`]: s }).catch(() => {
    });
  },
  async loadAll() {
    try {
      const e = await api.storage.local.get(["wf:conversations", "wf:active"]), t = e["wf:conversations"] ?? [], s = e["wf:active"] ?? null;
      let o = [];
      return s && (o = (await api.storage.local.get([`wf:events:${s}`]))[`wf:events:${s}`] ?? []), { conversations: t, active: s, events: o };
    } catch {
      return { conversations: [], active: null, events: [] };
    }
  },
  async loadEvents(e) {
    try {
      return (await api.storage.local.get([`wf:events:${e}`]))[`wf:events:${e}`] ?? [];
    } catch {
      return [];
    }
  }
};
let cachedEvents = [], cachedConversations = [], activeConversationId = null, activeConversationTitle = null, cacheRestored = !1;
const handleWolffishEvent = (e) => {
  if (e.event === "port_update") {
    const { port: t } = e.data;
    log(`Port update received: ${t}`), wolffishConnectionStorage.set({ port: t });
    return;
  }
  if (e.event === "overlay_config") {
    const { enabled: t } = e.data;
    log(`Overlay switch from app: ${t}`), setOverlayEnabled(t !== !1);
    return;
  }
  if (e.event === "extension_reload") {
    log("Received reload command from Wolffish"), api.runtime.reload();
    return;
  }
  if (e.event === "events_sync") {
    const t = e.data;
    activeConversationId = t.conversationId, activeConversationTitle = t.title ?? null, cachedEvents = (t.events ?? []).slice().reverse(), cache.saveActive(activeConversationId), cache.saveEvents(activeConversationId, cachedEvents), api.runtime.sendMessage({ payload: { event: "events_sync", data: e.data } }).catch(() => {
    });
    return;
  }
  if (e.event === "event_logged") {
    const t = e.data;
    cachedEvents.unshift(t), activeConversationId && cache.saveEvents(activeConversationId, cachedEvents), api.runtime.sendMessage({ payload: { event: "event_logged", data: t } }).catch(() => {
    });
    return;
  }
  if (e.event === "conversations_list") {
    cachedConversations = e.data, cache.saveConversations(cachedConversations), api.runtime.sendMessage({ payload: { event: "conversations_list", data: e.data } }).catch(() => {
    });
    for (const t of cachedConversations)
      sendToServer({ type: "get_conversation_events", conversationId: t.conversationId });
    return;
  }
  if (e.event === "conversation_events") {
    const t = e.data;
    cache.saveEvents(t.conversationId, (t.events ?? []).slice().reverse()), api.runtime.sendMessage({ payload: { event: "conversation_events", data: t } }).catch(() => {
    });
    return;
  }
};
api.runtime.onMessage.addListener((e, t, s) => {
  if (e.type === "get_connection_status") {
    const o = ws && ws.readyState === WebSocket.OPEN ? "connected" : ws && ws.readyState === WebSocket.CONNECTING ? "connecting" : "disconnected";
    return o !== connectionStatus && (connectionStatus = o), s({ status: connectionStatus, port: connectionPort }), !0;
  }
  if (e.type === "get_events")
    return sendToServer({ type: "get_conversations" }), cachedConversations.length > 0 || activeConversationId ? s({
      events: cachedEvents,
      conversations: cachedConversations,
      activeConversation: activeConversationId,
      activeConversationTitle
    }) : cache.loadAll().then((o) => {
      cachedConversations = o.conversations, activeConversationId = o.active, cachedEvents = o.events, s({
        events: cachedEvents,
        conversations: cachedConversations,
        activeConversation: activeConversationId,
        activeConversationTitle
      }), api.runtime.sendMessage({ payload: { event: "conversations_list", data: cachedConversations } }).catch(() => {
      });
    }), !0;
  if (e.type === "get_conversation_events" && e.conversationId) {
    const o = e.conversationId;
    return sendToServer({ type: "get_conversation_events", conversationId: o }), cache.loadEvents(o).then((n) => {
      cachedEvents = n, api.runtime.sendMessage({ payload: { event: "conversation_events", data: { conversationId: o, events: n } } }).catch(() => {
      }), s({ events: n });
    }), !0;
  }
  return !1;
});
const startConnection = async () => {
  connectionPort = (await wolffishConnectionStorage.get().catch(() => ({ port: DEFAULT_PORT }))).port, connectWebSocket(connectionPort);
};
api.runtime.onInstalled.addListener(async () => {
  log("Extension installed"), api.sidePanel && api.sidePanel.setPanelBehavior({ openPanelOnActionClick: !0 }), await startConnection();
});
api.runtime.onStartup.addListener(async () => {
  log("Extension started"), api.sidePanel && api.sidePanel.setPanelBehavior({ openPanelOnActionClick: !0 }), await startConnection();
});
wolffishConnectionStorage.subscribe(() => {
  const e = wolffishConnectionStorage.getSnapshot();
  e && e.port !== connectionPort && (log(`Port changed to ${e.port}`), api.alarms.clear(RECONNECT_ALARM), connectWebSocket(e.port));
});
cache.loadAll().then((e) => {
  cacheRestored || (cachedConversations = e.conversations, activeConversationId = e.active, cachedEvents = e.events, cacheRestored = !0, log(`Cache restored: ${e.conversations.length} conversations, ${e.events.length} events`));
}).catch(() => {
});
overlayHooks.beforeCapture = overlayDriver.beforeCapture;
overlayHooks.afterCapture = overlayDriver.afterCapture;
overlayHooks.cursor = overlayDriver.cursor;
overlayHooks.pulse = overlayDriver.pulse;
overlayHooks.target = overlayDriver.target;
initOverlayDriver();
startConnection().catch((e) => logError("Failed to start connection:", e));
log("Service worker loaded");

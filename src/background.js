import browser from "webextension-polyfill";
import { writeSiteRule } from "./libs/ruleEditorStorage";
import {
  MSG_FETCH,
  MSG_GET_HTTPCACHE,
  MSG_PUT_HTTPCACHE,
  MSG_TRANS_TOGGLE,
  MSG_TRANS_TOGGLE_ONLY,
  MSG_OPEN_OPTIONS,
  MSG_SAVE_RULE,
  MSG_EDIT_RULE,
  MSG_TRANS_TOGGLE_STYLE,
  MSG_OPEN_TRANBOX,
  MSG_TRANSBOX_TOGGLE,
  MSG_CONTEXT_MENUS,
  MSG_COMMAND_SHORTCUTS,
  MSG_INJECT_JS,
  MSG_INJECT_CSS,
  MSG_UPDATE_CSP,
  MSG_BUILTINAI_DETECT,
  MSG_BUILTINAI_TRANSLATE,
  CMD_TOGGLE_TRANSLATE,
  CMD_TOGGLE_TRANSLATE_ONLY,
  CMD_TOGGLE_STYLE,
  CMD_OPEN_OPTIONS,
  CMD_OPEN_TRANBOX,
  CMD_TOGGLE_TRANBOX,
  CMD_OPEN_SEPARATE_WINDOW,
  CMD_PAGE_ACTION_OPEN_OPTIONS,
  CMD_PAGE_ACTION_SHOW_POPUP,
  CLIENT_THUNDERBIRD,
  MSG_SET_LOGLEVEL,
  MSG_CLEAR_CACHES,
  MSG_OPEN_SEPARATE_WINDOW,
  MSG_FIT_SEPARATE_WINDOW,
  MSG_UPDATE_SEPARATE_WINDOW_BOUNDS,
  SEPARATE_WINDOW_CONTENT_WIDTH,
  STOKEY_SEPARATE_WINDOW,
  PORT_STREAM_FETCH,
  MSG_UPDATE_ICON,
  MSG_SHA256,
  MSG_GET_FRAME_ID,
  MSG_VALIDATE_DOCUMENT,
} from "./config";
import {
  getSettingWithDefault,
  tryInitDefaultData,
  runDataMigration,
} from "./libs/storage";
import { trySyncSettingAndRules } from "./libs/sync";
import { fetchHandle, fetchStreamNative } from "./libs/fetch";
import { tryClearCaches, getHttpCache, putHttpCache } from "./libs/cache";
import { sendTabMsg } from "./libs/msg";
import { trySyncAllSubRules } from "./libs/subRules";
import { saveRule } from "./libs/rules";
import { getCurTabId } from "./libs/msg";
import { injectInlineJsBg, injectInternalCss } from "./libs/injector";
import { kissLog, logger } from "./libs/log";
import { chromeDetect, chromeTranslate } from "./libs/builtinAI";
import { sha256 } from "./libs/utils";
import { installStorageCoordinator } from "./libs/storageCoordination";
import { isCurrentPopupDocument } from "./libs/popupDocument";
import { getPageActionIconPath } from "./libs/pageActionIcon";

globalThis.__KISS_CONTEXT__ = "background";
installStorageCoordinator();

let openingOptionsPage = null;

/**
 * Open the extension settings with the native API when available.
 * Fall back to a new tab when the native API is unavailable or fails.
 * Concurrent callers share the operation and receive its success status.
 */
function openOptionsPage() {
  if (openingOptionsPage) return openingOptionsPage;

  openingOptionsPage = Promise.resolve()
    .then(async () => {
      if (typeof browser.runtime.openOptionsPage === "function") {
        try {
          await browser.runtime.openOptionsPage();
          return true;
        } catch (err) {
          kissLog("open options page with runtime API", err);
        }
      }

      try {
        await browser.tabs.create({
          url: browser.runtime.getURL("options.html"),
        });
        return true;
      } catch (err) {
        kissLog("open options page in new tab", err);
        return false;
      }
    })
    .finally(() => {
      openingOptionsPage = null;
    });

  return openingOptionsPage;
}

// 地址栏按钮图标 (Firefox page_action) 借用 TWP - Translate Web Pages 的行为：
// 未翻译时是黑白单色 SVG，翻译激活后才切换为彩色，见 applyPageActionIcon()。
// 字形与配色来源 public/THIRD_PARTY_NOTICES.md (MPL-2.0)。

/**
 * 根据前台翻译的激活状态更新浏览器插件栏图标。
 * @param {boolean} isActive 翻译器是否激活 (是否处于高亮彩色状态)
 * @param {number} tabId 目标标签页 ID
 */
async function updateIcon(isActive, tabId) {
  const suffix = isActive ? "_active" : "";
  const path = {
    16: `images/logo16${suffix}.png`,
    32: `images/logo32${suffix}.png`,
    48: `images/logo48${suffix}.png`,
    128: `images/logo128${suffix}.png`,
    192: `images/logo192${suffix}.png`,
  };
  try {
    // 兼容 MV3 (browser.action) 和 MV2 (browser.browserAction) 规范下的 Firefox 和 Chrome
    if (browser.action) {
      await browser.action.setIcon({ path, tabId });
    } else {
      await browser.browserAction.setIcon({ path, tabId });
    }
  } catch (err) {
    kissLog("updateIcon error", err);
  }

  // 同步地址栏按钮 (Firefox page_action) 的图标：
  // 记录该标签页的翻译状态后，按 TWP 行为重设黑白/彩色 SVG 图标
  if (Number.isInteger(tabId)) {
    pageActionIconState.set(tabId, isActive);
  }
  await applyPageActionIcon(tabId);
}

// 各标签页的翻译激活状态，用于页面加载或主题明暗变化时重建地址栏图标
const pageActionIconState = new Map();

/**
 * 读取浏览器当前的暗色主题状态（与 TWP 一致，使用 prefers-color-scheme）。
 * 后台脚本在不支持 matchMedia 的环境（如 Chrome Service Worker）中回落为亮色。
 * @returns {boolean} 是否处于暗色主题
 */
function isPageActionDarkScheme() {
  try {
    return (
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: dark)").matches
    );
  } catch (err) {
    return false;
  }
}

/**
 * 按翻译状态与主题明暗重设地址栏按钮图标。
 * @param {number} tabId 目标标签页 ID
 * @returns {Promise<void>}
 */
async function applyPageActionIcon(tabId) {
  if (!Number.isInteger(tabId) || !browser.pageAction?.setIcon) return;
  try {
    await browser.pageAction.setIcon({
      tabId,
      path: getPageActionIconPath(
        pageActionIconState.get(tabId) === true,
        isPageActionDarkScheme()
      ),
    });
  } catch (err) {
    logger.debug("applyPageActionIcon error", err);
  }
}

/**
 * 主题明暗变化后为所有标签页重建地址栏图标（对齐 TWP 的 updateIconInAllTabs）。
 * @returns {Promise<void>}
 */
async function refreshPageActionIcons() {
  if (!browser.pageAction?.setIcon || !browser.tabs?.query) return;
  try {
    const tabs = await browser.tabs.query({});
    await Promise.all(tabs.map((tab) => applyPageActionIcon(tab?.id)));
  } catch (err) {
    logger.debug("refreshPageActionIcons error", err);
  }
}

/**
 * 在火狐地址栏中显示扩展按钮 (page_action)。
 * 地址栏按钮默认隐藏，manifest 的 show_matches 只能覆盖普通网页，
 * 此处对指定标签页显式展示，保证其与工具栏按钮一样随时可见。
 * @param {number} tabId 目标标签页 ID
 * @returns {Promise<void>}
 */
async function showPageAction(tabId) {
  if (!Number.isInteger(tabId) || !browser.pageAction?.show) return;
  try {
    await browser.pageAction.show(tabId);
    // 展示的同时刷新图标，保证亮/暗主题与翻译状态始终正确
    await applyPageActionIcon(tabId);
  } catch (err) {
    // 部分特权页面不允许展示地址栏按钮，此处仅记录调试信息
    logger.debug("showPageAction error", err);
  }
}

/**
 * 为浏览器中已打开的所有标签页显示地址栏按钮。
 * 在扩展安装/升级及浏览器启动时调用，覆盖已存在的标签页。
 * @returns {Promise<void>}
 */
async function showPageActionForAllTabs() {
  if (!browser.pageAction?.show || !browser.tabs?.query) return;
  try {
    const tabs = await browser.tabs.query({});
    await Promise.all(tabs.map((tab) => showPageAction(tab?.id)));
  } catch (err) {
    logger.debug("showPageActionForAllTabs error", err);
  }
}

// 新标签页创建及页面跳转时补显地址栏按钮，
// 覆盖 show_matches 匹配不到的特权页面 (about:* 等)，与工具栏按钮行为保持一致。
browser.tabs?.onCreated?.addListener?.((tab) => showPageAction(tab?.id));
browser.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
  if (changeInfo?.status !== "loading") return;
  // 整页跳转后翻译状态复位，地址栏图标回到黑白（未翻译）态
  pageActionIconState.delete(tabId);
  showPageAction(tabId);
});
browser.tabs?.onRemoved?.addListener?.((tabId) => {
  pageActionIconState.delete(tabId);
});

/**
 * 地址栏按钮点击：左键（button 0）直接切换当前页双语翻译（对齐 TWP 点击即翻译）；
 * 中键（button 1）打开翻译弹窗——pageAction.onClicked 的 EventManager 声明了
 * inputHandling，是 Firefox 认可的“用户输入处理器”，这里调用 openPopup() 必定满足
 * 手势要求，是右键菜单入口手势不足时的可靠替代。
 * page_action 未配置 popup，因此点击会派发到此；扩展选项入口在右键菜单中。
 */
browser.pageAction?.onClicked?.addListener?.((tab, clickInfo) => {
  if (clickInfo?.button === 1) {
    openPageActionPopup(tab?.id);
    return;
  }
  sendTabMsg(MSG_TRANS_TOGGLE, undefined, undefined, tab?.id);
});

// “显示翻译弹窗”失败原因的展示定时器（key: tabId）
const pageActionTitleTimers = new Map();

/**
 * 还原地址栏按钮的悬停提示为 manifest 默认标题。
 * @param {number} tabId 目标标签页 ID
 * @returns {Promise<void>}
 */
async function restorePageActionTitle(tabId) {
  const timer = pageActionTitleTimers.get(tabId);
  if (!timer) return;
  clearTimeout(timer);
  pageActionTitleTimers.delete(tabId);
  try {
    await browser.pageAction.setTitle({
      tabId,
      title: browser.i18n.getMessage("toggle_translate") || "",
    });
  } catch (err) {
    logger.debug("restore pageAction title error", err);
  }
}

/**
 * 展示“显示翻译弹窗”的失败原因：写入后台日志，并把地址栏按钮的悬停提示
 * 临时改为错误信息（8 秒后自动还原），鼠标放到图标上即可看到，无需打开控制台。
 * @param {number} tabId 目标标签页 ID
 * @param {string} reason 失败原因
 * @returns {Promise<void>}
 */
async function showPageActionPopupError(tabId, reason) {
  kissLog("openPageActionPopup failed:", reason);
  if (!Number.isInteger(tabId) || !browser.pageAction?.setTitle) return;
  try {
    await browser.pageAction.setTitle({ tabId, title: `⚠ ${reason}` });
    const previous = pageActionTitleTimers.get(tabId);
    if (previous) clearTimeout(previous);
    pageActionTitleTimers.set(
      tabId,
      setTimeout(() => restorePageActionTitle(tabId), 8000)
    );
  } catch (err) {
    logger.debug("showPageActionPopupError error", err);
  }
}

/**
 * 打开“翻译弹窗”（锚点在地址栏按钮上）。
 *
 * 关键约束（Firefox）：pageAction.openPopup() 在 schema 层要求 requireUserInput，
 * 调用瞬间会检查 windowUtils.isHandlingUserInput（ExtensionCommon.sys.mjs 的
 * callAsyncFunction）；该标记只在触发本次点击的**同步调用栈**内为真。因此
 * setPopup → openPopup → 恢复 setPopup 三步必须与 TWP 一样在同一 tick 内同步完成，
 * 任何 await / setTimeout 都会丢掉用户手势并抛
 * "may only be called from a user input handler"。
 * @param {number} tabId 目标标签页 ID
 * @returns {void}
 */
function openPageActionPopup(tabId) {
  if (!Number.isInteger(tabId) || !browser.pageAction?.setPopup) return;

  // 1) 挂上 popup（不 await：底层同步执行，紧随其后的 openPopup 能读到该值）
  try {
    Promise.resolve(
      browser.pageAction.setPopup({ tabId, popup: "popup.html" })
    ).catch((err) => logger.debug("setPopup popup.html error", err));
  } catch (err) {
    logger.debug("setPopup popup.html error", err);
  }

  // 2) 同步弹出：必须留在当前用户输入调用栈内
  let openPromise = null;
  if (browser.pageAction?.openPopup) {
    try {
      openPromise = Promise.resolve(browser.pageAction.openPopup());
    } catch (err) {
      openPromise = Promise.reject(err);
    }
  }

  // 3) 同步恢复空 popup，保证后续左键仍是直接翻译（TWP resetPageAction 的顺序）
  try {
    Promise.resolve(browser.pageAction.setPopup({ tabId, popup: "" })).catch(
      (err) => logger.debug("reset pageAction popup error", err)
    );
  } catch (err) {
    logger.debug("reset pageAction popup error", err);
  }

  if (!openPromise) {
    showPageActionPopupError(tabId, "pageAction.openPopup unavailable");
    return;
  }

  openPromise
    .then(() => restorePageActionTitle(tabId))
    .catch((err) =>
      showPageActionPopupError(tabId, String(err?.message || err))
    );
}

// 浏览器明暗主题切换时重建地址栏图标（TWP 同样监听该事件重设图标颜色）
try {
  if (typeof matchMedia === "function") {
    const schemeQuery = matchMedia("(prefers-color-scheme: dark)");
    if (typeof schemeQuery.addEventListener === "function") {
      schemeQuery.addEventListener("change", refreshPageActionIcons);
    } else if (typeof schemeQuery.addListener === "function") {
      schemeQuery.addListener(refreshPageActionIcons);
    }
  }
} catch (err) {
  logger.debug("listen color scheme change error", err);
}

// declarativeNetRequest 动态规则的起始 ID 段，避免 ID 冲突
const CSP_RULE_START_ID = 1;
const ORI_RULE_START_ID = 10000;

/**
 * 从一个 URL 或域名字符串中提取可注册域名 (registrable domain, 即 eTLD+1)。
 * 例如 "https://dict.youdao.com/xxx" -> "youdao.com"。
 * 用于 DNR 的 excludedInitiatorDomains，使其能匹配目标站点的所有子域名页面。
 * @param {string} input URL 或域名（可不带协议）
 * @returns {string} 可注册域名；解析失败时返回空字符串
 */
function getRegistrableDomain(input) {
  try {
    const hostname = new URL(
      /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`
    ).hostname;
    const labels = hostname.split(".").filter(Boolean);
    // 取最后两段作为可注册域名（足以覆盖有道等常见翻译源场景）
    return labels.length <= 2 ? hostname : labels.slice(-2).join(".");
  } catch (err) {
    kissLog("getRegistrableDomain error", err);
    return "";
  }
}
// 需要从 HTTP 响应头中移除的 CSP (Content-Security-Policy) 键名，用以允许加载第三方翻译接口脚本/发送翻译请求
const CSP_REMOVE_HEADERS = [
  `content-security-policy`,
  `content-security-policy-report-only`,
  `x-webkit-csp`,
  `x-content-security-policy`,
];

// 独立窗口 (TranBox 独立窗口模式) 的全局状态变量
let separateWindowId = null; // 当前已打开窗口的 ID
let lastKnownBounds = null; // 缓存窗口最后一次有效的屏幕位置坐标与大小
let separateWindowFitPending = false; // Whether a default-sized window still needs content fitting.
let separateWindowFitSize = null;
let separateWindowBoundsRevision = 0;
let separateWindowBoundsRead = 0;

// Start near the expected content size to reduce visible resizing during rendering.
// MSG_FIT_SEPARATE_WINDOW adjusts the initial height after layout.
// Subsequent resizing uses the full window without a fixed content width cap.
const SEPARATE_WINDOW_CHROME_ALLOWANCE = 24;
const DEFAULT_SEPARATE_WINDOW_BOUNDS = {
  left: 100,
  top: 100,
  width: SEPARATE_WINDOW_CONTENT_WIDTH + SEPARATE_WINDOW_CHROME_ALLOWANCE,
  height: 720,
};

/**
 * Center a new window over the last focused browser window.
 *
 * Fixed coordinates can place it on the wrong monitor. The background service
 * worker has no screen object, so use the focused window's bounds instead.
 *
 * @param {{width: number, height: number}} bounds Desired window size.
 * @returns {Promise<{left: number, top: number}|null>} Centered coordinates, if available.
 */
async function centerOnFocusedWindow({ width, height }) {
  try {
    const focused = await browser.windows.getLastFocused();
    if (
      !focused ||
      typeof focused.left !== "number" ||
      typeof focused.top !== "number" ||
      typeof focused.width !== "number" ||
      typeof focused.height !== "number"
    ) {
      return null;
    }

    return {
      left: Math.round(focused.left + (focused.width - width) / 2),
      top: Math.round(focused.top + (focused.height - height) / 2),
    };
  } catch (err) {
    kissLog("center separate window", err);
    return null;
  }
}

/**
 * Fit the separate window to its rendered content.
 *
 * Content height depends on language, browser zoom, and system font size.
 * The page measures its layout after opening and sends the required bounds.
 *
 * Fit only when opened with default bounds, preserving any saved user size.
 *
 * @param {Object} args Measured size including window chrome, and available screen bounds.
 * @returns {Promise<void>}
 */
async function fitSeparateWindow(args) {
  if (!separateWindowFitPending || separateWindowId === null) return;

  const { width, height, availWidth, availHeight, availLeft, availTop } =
    args || {};
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  const windowId = separateWindowId;
  const initialSize = separateWindowFitSize;
  separateWindowFitPending = false;

  // Leave room around the screen edges and taskbar.
  const maxWidth = Number.isFinite(availWidth) ? availWidth - 40 : Infinity;
  const maxHeight = Number.isFinite(availHeight) ? availHeight - 80 : Infinity;
  const nextWidth = Math.round(Math.max(360, Math.min(width, maxWidth)));
  const nextHeight = Math.round(Math.max(320, Math.min(height, maxHeight)));

  try {
    const win = await browser.windows.get(windowId);
    // Preserve windows that are no longer in their normal state.
    if (windowId !== separateWindowId || !win || win.state !== "normal") return;
    // A resize can arrive before this request or while its window read is pending.
    if (!initialSize || initialSize !== separateWindowFitSize) return;
    if (
      Math.round(win.width) !== initialSize.width ||
      Math.round(win.height) !== initialSize.height
    ) {
      cacheSeparateWindowBounds(win);
      return;
    }

    const nextBounds = {
      width: nextWidth,
      height: nextHeight,
    };
    // Widening a new window can move its right or bottom edge off-screen.
    // Use the measured screen origin to support monitors with negative offsets.
    if (Number.isFinite(availLeft) && Number.isFinite(availWidth)) {
      nextBounds.left = Math.round(
        Math.max(
          availLeft + 20,
          Math.min(win.left, availLeft + availWidth - nextWidth - 20)
        )
      );
    }
    if (Number.isFinite(availTop) && Number.isFinite(availHeight)) {
      nextBounds.top = Math.round(
        Math.max(
          availTop + 40,
          Math.min(win.top, availTop + availHeight - nextHeight - 40)
        )
      );
    }
    // Bounds events from our own update must not count as a user resize.
    separateWindowFitSize = null;
    const boundsRevision = separateWindowBoundsRevision;
    const updatedWindow = await browser.windows.update(windowId, nextBounds);
    if (boundsRevision === separateWindowBoundsRevision) {
      cacheSeparateWindowBounds(updatedWindow);
    } else if (windowId === separateWindowId) {
      await updateCacheFromActual(windowId);
    }
    kissLog("Separate window fitted to content", { nextWidth, nextHeight });
  } catch (err) {
    kissLog("fit separate window", err);
  }
}

// Cache the actual browser result even when onBoundsChanged is unavailable.
function cacheSeparateWindowBounds(win) {
  if (!win || win.id !== separateWindowId) return;
  if (win.state && win.state !== "normal") {
    separateWindowFitPending = false;
    separateWindowFitSize = null;
    return;
  }
  if (
    win.state !== "normal" ||
    ![win.left, win.top, win.width, win.height].every(Number.isFinite)
  ) {
    return;
  }
  if (
    separateWindowFitSize &&
    (Math.round(win.width) !== separateWindowFitSize.width ||
      Math.round(win.height) !== separateWindowFitSize.height)
  ) {
    separateWindowFitPending = false;
    separateWindowFitSize = null;
  }
  lastKnownBounds = {
    left: Math.round(win.left),
    top: Math.round(win.top),
    width: Math.round(win.width),
    height: Math.round(win.height),
  };
  separateWindowBoundsRevision += 1;
}

/**
 * 将独立窗口的位置及宽高数据持久化保存到 storage.local 中。
 * @param {Object} bounds 坐标大小数据
 */
async function persistSeparateWindowBounds(bounds) {
  if (!bounds) return;
  try {
    await browser.storage.local.set({ [STOKEY_SEPARATE_WINDOW]: bounds });
    kissLog("Final separate window bounds saved to storage", bounds);
  } catch (err) {
    kissLog("Save separate window bounds error", err);
  }
}

/**
 * 读取上次保存的窗口位置与大小，启动/聚焦翻译独立窗口。
 */
async function openSeparateWindowWithSavedBounds() {
  try {
    // REVIEW: 窗口单例机制。若窗口已存在且被创建过，则通过查询所有窗口状态直接聚焦，避免重复创建
    if (separateWindowId !== null) {
      const allWindows = await browser.windows.getAll();
      const existingWin = allWindows.find((w) => w.id === separateWindowId);
      if (existingWin) {
        await browser.windows.update(separateWindowId, { focused: true });
        kissLog("Separate window is ready");
        return existingWin;
      }
    }

    const stored = await browser.storage.local.get(STOKEY_SEPARATE_WINDOW);
    const saved = stored && stored[STOKEY_SEPARATE_WINDOW];
    const bounds = Object.assign(
      {},
      DEFAULT_SEPARATE_WINDOW_BOUNDS,
      saved || {}
    );

    // Center and fit only on the first opening, preserving saved user bounds.
    if (!saved) {
      const centered = await centerOnFocusedWindow(bounds);
      if (centered) Object.assign(bounds, centered);
    }

    const win = await browser.windows.create({
      url: "popup.html#tranbox",
      type: "popup", // 以弹出窗口（无地址栏、无工具栏）形式创建
      left: Math.round(bounds.left),
      top: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      focused: true,
    });

    separateWindowId = win.id;
    lastKnownBounds = {
      left: win.left,
      top: win.top,
      width: win.width,
      height: win.height,
    };
    // Use the browser's actual creation size, which can differ from the request.
    // Repeated initial bounds and position-only changes still allow fitting.
    separateWindowFitPending = !saved;
    separateWindowFitSize = saved
      ? null
      : { width: Math.round(win.width), height: Math.round(win.height) };

    return win;
  } catch (err) {
    kissLog("open separate window error", err);
  }
}

/**
 * 从实际的窗口实例中同步并更新内存缓存的坐标尺寸。
 * @param {number} windowId 窗口 ID
 */
async function updateCacheFromActual(windowId) {
  const read = ++separateWindowBoundsRead;
  const revision = separateWindowBoundsRevision;
  try {
    const win = await browser.windows.get(windowId);
    if (read !== separateWindowBoundsRead || windowId !== separateWindowId)
      return;
    if (revision !== separateWindowBoundsRevision) {
      // Another update may have cached an older snapshot while this read was
      // pending. Read again instead of dropping the only notification of a move.
      return updateCacheFromActual(windowId);
    }
    cacheSeparateWindowBounds(win);
  } catch (e) {
    // 忽略窗口已被关闭时的查询异常
  }
}

/**
 * 监听窗口焦点切换事件 (用于兼容不支持 boundsChanged 的 Firefox)
 */
browser.windows?.onFocusChanged?.addListener?.(async (windowId) => {
  if (separateWindowId !== null) {
    await updateCacheFromActual(separateWindowId);
  }
});

/**
 * 监听窗口大小及位置移动变化。
 * 此时只实时更新内存中的 lastKnownBounds 缓存，不频繁写入 Storage，防止 Storage API 限频报错。
 */
browser.windows?.onBoundsChanged?.addListener?.((win) => {
  cacheSeparateWindowBounds(win);
});

/**
 * 监听窗口关闭事件。
 * 在独立窗口彻底销毁后，才将最终的 lastKnownBounds 写入磁盘（Storage.local）中持久化，
 * 并释放全局引用。该时机设计得非常好，能极大节约 IO 开销。
 */
browser.windows?.onRemoved?.addListener?.(async (windowId) => {
  if (windowId === separateWindowId) {
    const bounds = lastKnownBounds;
    separateWindowId = null;
    lastKnownBounds = null;
    separateWindowFitPending = false;
    separateWindowFitSize = null;
    await persistSeparateWindowBounds(bounds);
  }
});

/**
 * 动态增删及配置右键快捷菜单。
 * @param {number} contextMenuType 菜单类型标识 (1: 简易模式, 2: 完整模式)
 */
async function addContextMenus(contextMenuType = 1) {
  try {
    // 添加右键菜单前，务必先全部清空，防止因为重复添加相同 ID 菜单导致插件崩溃
    await browser.contextMenus.removeAll();
  } catch (err) {
    kissLog("remove contextMenus", err);
  }

  // 地址栏按钮 (page_action) 的右键菜单：左键已改为直接翻译，
  // 右键提供“显示翻译弹窗”与“打开扩展选项”两个入口。
  // page_action 仅 Firefox 在 manifest 中声明（Chrome MV3 已移除该 API），故按 API 存在性创建。
  if (browser.pageAction?.onClicked) {
    browser.contextMenus.create({
      id: CMD_PAGE_ACTION_SHOW_POPUP,
      title: browser.i18n.getMessage("page_action_show_popup"),
      contexts: ["page_action"],
    });
    browser.contextMenus.create({
      id: CMD_PAGE_ACTION_OPEN_OPTIONS,
      title: browser.i18n.getMessage("open_options"),
      contexts: ["page_action"],
    });
  }

  switch (contextMenuType) {
    case 1:
      // 简易模式：仅提供“双语对照翻译”与“翻译所选文本”
      browser.contextMenus.create({
        id: CMD_TOGGLE_TRANSLATE,
        title: browser.i18n.getMessage("toggle_translate"),
        contexts: ["page"],
      });
      browser.contextMenus.create({
        id: CMD_OPEN_TRANBOX,
        title: browser.i18n.getMessage("translate_selection"),
        contexts: ["selection"],
      });
      break;
    case 2:
      // 完整模式：额外提供“仅显示翻译”、样式切换、打开独立翻译面板以及进入选项设置页
      browser.contextMenus.create({
        id: CMD_TOGGLE_TRANSLATE,
        title: browser.i18n.getMessage("toggle_translate"),
        contexts: ["page", "selection"],
      });
      browser.contextMenus.create({
        id: CMD_TOGGLE_TRANSLATE_ONLY,
        title: browser.i18n.getMessage("toggle_translate_only"),
        contexts: ["page", "selection"],
      });
      browser.contextMenus.create({
        id: CMD_TOGGLE_STYLE,
        title: browser.i18n.getMessage("toggle_style"),
        contexts: ["page", "selection"],
      });
      browser.contextMenus.create({
        id: CMD_OPEN_TRANBOX,
        title: browser.i18n.getMessage("open_tranbox"),
        contexts: ["page", "selection"],
      });
      browser.contextMenus.create({
        id: "options_separator",
        type: "separator",
        contexts: ["page", "selection"],
      });
      browser.contextMenus.create({
        id: CMD_OPEN_OPTIONS,
        title: browser.i18n.getMessage("open_options"),
        contexts: ["page", "selection"],
      });
      break;
    default:
  }
}

/**
 * 动态更新浏览器的 CSP (Content Security Policy) 和跨域 Origin 修改策略。
 * 利用 Chrome MV3 declarativeNetRequest (DNR) 动态配置规则，
 * 实现“剥离第三方 CSP 限制”和“伪装 Origin 请求头以绕过跨域防护”的能力。
 * @param {Object} params
 * @param {Array<string>|string} params.csplist 需移除 CSP 响应头的域名规则列表
 * @param {Array<string>|string} params.orilist 需伪装 Origin 请求头的请求过滤列表
 */
async function updateCspRules({ csplist, orilist }) {
  try {
    // 1. 获取当前所有已注册的动态 DNR 规则
    const oldRules = await browser.declarativeNetRequest.getDynamicRules();

    const rulesToAdd = [];
    const idsToRemove = [];

    // 2. 构造并处理 CSP 移除过滤规则
    if (csplist !== undefined) {
      let processedCspList = csplist;
      if (typeof processedCspList === "string") {
        processedCspList = processedCspList
          .split(/\n|,/)
          .map((url) => url.trim())
          .filter(Boolean);
      }

      // 获取所有属于 CSP 段的旧规则 ID，准备予以清理
      const oldCspRuleIds = oldRules
        .filter(
          (rule) => rule.id >= CSP_RULE_START_ID && rule.id < ORI_RULE_START_ID
        )
        .map((rule) => rule.id);
      idsToRemove.push(...oldCspRuleIds);

      // 为每个目标 url 分配新的规则 ID 并构造 removeHeaders 行动
      const newCspRules = processedCspList.map((url, index) => ({
        id: CSP_RULE_START_ID + index,
        action: {
          type: "modifyHeaders",
          responseHeaders: CSP_REMOVE_HEADERS.map((header) => ({
            operation: "remove",
            header,
          })),
        },
        condition: {
          urlFilter: url,
          resourceTypes: ["main_frame", "sub_frame"],
        },
      }));
      rulesToAdd.push(...newCspRules);
    }

    // 3. 构造并处理 Origin 请求头重写伪装规则
    if (orilist !== undefined) {
      let processedOriList = orilist;
      if (typeof processedOriList === "string") {
        processedOriList = processedOriList
          .split(/\n|,/)
          .map((url) => url.trim())
          .filter(Boolean);
      }

      // 获取所有属于 Origin 修改段的旧规则 ID，准备清理
      const oldOriRuleIds = oldRules
        .filter((rule) => rule.id >= ORI_RULE_START_ID)
        .map((rule) => rule.id);
      idsToRemove.push(...oldOriRuleIds);

      // 将发往特定翻译源的 xmlhttprequest 请求的 Origin 修改为目标源域名，伪装成同源请求
      const newOriRules = processedOriList.map((url, index) => {
        const condition = {
          urlFilter: url,
          resourceTypes: ["xmlhttprequest"],
        };

        // 仅对“非目标站点本身”的页面发起的请求伪装 Origin。
        // 否则会篡改用户在目标站点（如有道）自身页面上发出的请求的 Origin，
        // 反而触发该站点的跨域校验失败 (CORS AllowOriginMismatch)。详见 issue #759。
        const initiatorDomain = getRegistrableDomain(url);
        if (initiatorDomain) {
          condition.excludedInitiatorDomains = [initiatorDomain];
        }

        return {
          id: ORI_RULE_START_ID + index,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "set", value: url },
            ],
          },
          condition,
        };
      });
      rulesToAdd.push(...newOriRules);
    }

    // REVIEW: 批量更新 DNR 规则。在部分不支持 MV3 动态规则的旧浏览器（如旧版 Firefox）中可能会抛错，
    // 在 catch 中已做了捕获处理，能够保障基础功能的正常工作，但无法去除 CSP 限制。
    if (idsToRemove.length > 0 || rulesToAdd.length > 0) {
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: idsToRemove,
        addRules: rulesToAdd,
      });
    }
  } catch (err) {
    kissLog("update csp rules", err);
  }
}

/**
 * 在 Thunderbird (雷鸟邮件客户端) 中注册脚本，实现邮件正文区域的注入翻译。
 */
async function registerMsgDisplayScript() {
  await messenger.messageDisplayScripts.register({
    js: [{ file: "/content.js" }],
  });
}

/**
 * 适配并转换当前浏览器的 UI 显示语言，映射为本项目支持的语言键名。
 * @returns {Promise<string>} 本项目识别的语言简写 (zh_TW / zh / ja / ko / en)
 */
async function getUiLanguage() {
  try {
    const lang = await browser.i18n.getUILanguage();

    if (lang === "zh-TW") {
      return "zh_TW";
    } else if (lang.startsWith("zh")) {
      return "zh";
    } else if (["ja", "ko", "ru"].includes(lang.substring(0, 2))) {
      return lang.substring(0, 2);
    } else {
      return "en";
    }
  } catch (err) {
    kissLog("get UI language error", err);
    return "en";
  }
}

/**
 * 监听扩展安装/升级事件 (onInstalled)。
 * 此时触发数据库默认初始化、右键菜单生成、CSP 网络过滤器注册、以及拉取网络订阅规则。
 */
browser.runtime.onInstalled.addListener(async (details) => {
  const uiLang = await getUiLanguage();
  await tryInitDefaultData(uiLang);
  if (details?.reason === "update") {
    await runDataMigration();
  }

  // 在 Thunderbird 场景下注册特定的邮件脚本
  if (process.env.REACT_APP_CLIENT === CLIENT_THUNDERBIRD) {
    registerMsgDisplayScript();
  }

  const { contextMenuType, csplist, orilist, subrulesList } =
    await getSettingWithDefault();

  addContextMenus(contextMenuType);
  updateCspRules({ csplist, orilist });
  trySyncAllSubRules({ subrulesList });
  // 新装/升级后为已打开的标签页补显地址栏按钮
  showPageActionForAllTabs();
});

/**
 * 监听浏览器/扩展启动事件 (onStartup)。
 * 此时从本地恢复日志级别、清空不需要的翻译长缓存、重建右键菜单，并与云端同步设置、本地规则与订阅规则。
 */
browser.runtime.onStartup.addListener(async () => {
  const {
    clearCache,
    contextMenuType,
    subrulesList,
    csplist,
    orilist,
    logLevel,
  } = await getSettingWithDefault();

  logger.setLevel(logLevel);

  if (clearCache) {
    tryClearCaches();
  }

  if (process.env.REACT_APP_CLIENT === CLIENT_THUNDERBIRD) {
    registerMsgDisplayScript();
  }

  // REVIEW: 针对“Firefox 重启后菜单消失”的系统 Bug，此处在启动时必须重新添加一次 addContextMenus
  addContextMenus(contextMenuType);

  updateCspRules({ csplist, orilist });
  trySyncSettingAndRules();
  trySyncAllSubRules({ subrulesList });
  // 浏览器重启后为恢复的标签页补显地址栏按钮
  showPageActionForAllTabs();
});

/**
 * 辅助函数：向前台当前活动标签页的所有框架 (Frames) 中注入指定的 JS 脚本或样式逻辑。
 * @param {Function} func 待注入的函数
 * @param {*} args 传递给注入函数的入参
 */
const injectToCurrentTab = async (func, args) => {
  const tabId = await getCurTabId();
  return browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: func,
    args: [args],
    world: "MAIN", // 运行在前台页面的真实主环境 (MAIN world)，而非隔离环境 (ISOLATED)
  });
};

// 后台消息指令与对应处理器映射表
const messageHandlers = {
  [MSG_GET_FRAME_ID]: (_args, sender) =>
    Number.isInteger(sender?.frameId) ? sender.frameId : undefined,
  [MSG_VALIDATE_DOCUMENT]: (args, sender) =>
    isCurrentPopupDocument(sender?.tab?.id, args),
  [MSG_FETCH]: (args) => fetchHandle(args), // 跨域请求代理
  [MSG_GET_HTTPCACHE]: (args) => getHttpCache(args), // 读取翻译 HTTP 缓存
  [MSG_PUT_HTTPCACHE]: (args) => putHttpCache(args), // 存入翻译 HTTP 缓存
  [MSG_SHA256]: ({ text = "", salt = "" } = {}) => sha256(text, salt), // 代算缓存签名
  [MSG_OPEN_OPTIONS]: () => openOptionsPage(), // 打开设置选项页
  [MSG_SAVE_RULE]: (args) => saveRule(args), // 写入/保存规则
  [MSG_EDIT_RULE]: (args) => writeSiteRule(args),
  [MSG_INJECT_JS]: (args) => injectToCurrentTab(injectInlineJsBg, args), // 注入 JS 代码到前台
  [MSG_INJECT_CSS]: (args) => injectToCurrentTab(injectInternalCss, args), // 注入 CSS 样式到前台
  [MSG_UPDATE_CSP]: (args) => updateCspRules(args), // 触发 CSP 重写规则变更
  [MSG_CONTEXT_MENUS]: (args) => addContextMenus(args), // 切换右键菜单样式
  [MSG_COMMAND_SHORTCUTS]: () => browser.commands.getAll(), // 获取 manifest 注册的所有快捷键
  [MSG_BUILTINAI_DETECT]: (args) => chromeDetect(args), // 触发 Chrome 127+ 内置 Gemini AI 语言检测
  [MSG_BUILTINAI_TRANSLATE]: (args) => chromeTranslate(args), // 触发 Chrome 内置 AI 翻译接口
  [MSG_SET_LOGLEVEL]: (args) => logger.setLevel(args), // 修改运行时的日志记录等级
  [MSG_CLEAR_CACHES]: () => tryClearCaches(), // 清空翻译缓存
  [MSG_OPEN_SEPARATE_WINDOW]: () => openSeparateWindowWithSavedBounds(), // 打开独立翻译小窗口
  [MSG_FIT_SEPARATE_WINDOW]: (args) => fitSeparateWindow(args), // Fit the separate window to its content.
  [MSG_UPDATE_SEPARATE_WINDOW_BOUNDS]: (args) =>
    args?.windowId === separateWindowId
      ? updateCacheFromActual(args.windowId)
      : undefined,
  [MSG_UPDATE_ICON]: (args, sender) => updateIcon(args, sender?.tab?.id), // 变更页面的插件高亮图标
};

/**
 * 注册全局统一的 runtime.onMessage 消息通道监听器。
 */
browser.runtime.onMessage.addListener(async ({ action, args }, sender) => {
  const handler = messageHandlers[action];
  if (!handler) {
    throw new Error(`Message action is unavailable: ${action}`);
  }

  // 执行对应的处理器并回传结果给发送方 (Content Script / Popup)
  return handler(args, sender);
});

/**
 * 监听浏览器系统快捷键事件 (browser.commands)。
 * 用户在 manifest 中声明的快捷键按下时，后台直接将对应的翻译指令广播给前台 content 脚本。
 */
browser.commands?.onCommand?.addListener?.((command) => {
  switch (command) {
    case CMD_TOGGLE_TRANSLATE:
      sendTabMsg(MSG_TRANS_TOGGLE);
      break;
    case CMD_TOGGLE_TRANSLATE_ONLY:
      sendTabMsg(MSG_TRANS_TOGGLE_ONLY);
      break;
    case CMD_OPEN_TRANBOX:
      sendTabMsg(MSG_OPEN_TRANBOX);
      break;
    case CMD_TOGGLE_TRANBOX:
      sendTabMsg(MSG_TRANSBOX_TOGGLE);
      break;
    case CMD_TOGGLE_STYLE:
      sendTabMsg(MSG_TRANS_TOGGLE_STYLE);
      break;
    case CMD_OPEN_OPTIONS:
      openOptionsPage();
      break;
    case CMD_OPEN_SEPARATE_WINDOW:
      if (messageHandlers[MSG_OPEN_SEPARATE_WINDOW]) {
        messageHandlers[MSG_OPEN_SEPARATE_WINDOW]();
      }
      break;
    default:
  }
});

/**
 * 监听全局右键菜单的点击项。
 * 触发时，通过 Chrome 消息管道将对应指令转发给用户所点击页面的前台 Content Script。
 */
browser?.contextMenus?.onClicked?.addListener?.(
  ({ menuItemId, selectionText }, tab) => {
    switch (menuItemId) {
      case CMD_TOGGLE_TRANSLATE:
        sendTabMsg(MSG_TRANS_TOGGLE);
        break;
      case CMD_TOGGLE_TRANSLATE_ONLY:
        sendTabMsg(MSG_TRANS_TOGGLE_ONLY);
        break;
      case CMD_TOGGLE_STYLE:
        sendTabMsg(MSG_TRANS_TOGGLE_STYLE);
        break;
      case CMD_OPEN_TRANBOX:
        sendTabMsg(MSG_OPEN_TRANBOX, { text: selectionText });
        break;
      case CMD_TOGGLE_TRANBOX:
        sendTabMsg(MSG_TRANSBOX_TOGGLE);
        break;
      case CMD_OPEN_OPTIONS:
        openOptionsPage();
        break;
      case CMD_PAGE_ACTION_SHOW_POPUP:
        openPageActionPopup(tab?.id); // 右键“显示翻译弹窗”
        break;
      case CMD_PAGE_ACTION_OPEN_OPTIONS:
        openOptionsPage(); // 地址栏按钮右键菜单项
        break;
      default:
    }
  }
);

/**
 * 专门处理 SSE/翻译大模型的流式数据请求通道。
 * 使用 for-await 逐帧读取流式 chunk，通过 port.postMessage 实时推送到前台，避免 onMessage 一次性通信无法传输流数据的限制。
 * @param {Port} port 专属长连接通信端口
 * @param {Object} args 流式请求参数 (包含接口 input, fetch 配置 init 等)
 */
async function handleStreamFetch(port, args) {
  const { input, init, opts } = args;
  const controller = new AbortController();
  let disconnected = false;
  const handleDisconnect = () => {
    disconnected = true;
    // 前台 Port 断开代表调用方已停止消费流，必须同步中止后台 fetch。
    controller.abort();
  };
  port.onDisconnect.addListener(handleDisconnect);

  try {
    for await (const chunk of fetchStreamNative(input, init, {
      httpTimeout: opts.httpTimeout,
      signal: controller.signal,
    })) {
      if (disconnected) break;
      // 实时向发送端传送当前收到的流式增量文本块
      port.postMessage({ type: "delta", data: chunk });
    }
    // 只有 Port 仍连接时才发送完成信号，避免断开后继续 postMessage。
    if (!disconnected) {
      port.postMessage({ type: "done" });
    }
  } catch (error) {
    // 过滤用户主动取消导致的 AbortError，保留真正的上游请求错误。
    if (error.name !== "AbortError") {
      if (!disconnected) {
        port.postMessage({ type: "error", error: error.message });
      }
    }
  } finally {
    port.onDisconnect.removeListener?.(handleDisconnect);
  }
}

/**
 * 监听 runtime.onConnect 连接事件。
 * 筛选流式专属端口名 PORT_STREAM_FETCH，监听 start 开始指令并启动 handleStreamFetch 异步流处理程序。
 */
browser.runtime.onConnect.addListener((port) => {
  if (port.name === PORT_STREAM_FETCH) {
    port.onMessage.addListener((message) => {
      if (message.action === "start") {
        handleStreamFetch(port, message.args);
      }
    });
  }
});

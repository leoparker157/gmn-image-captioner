// Gemini Image Captioner - Background Service Worker
// Handles Context Menu and Network Proxy (CORS bypass)

const MENU_ID = "gic-caption-image";

function toOriginPattern(rawUrl) {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}/*`;
  } catch (_) {
    return null;
  }
}

function containsOrigins(origins) {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins }, (granted) => {
      resolve(Boolean(granted) && !chrome.runtime.lastError);
    });
  });
}

function requestOrigins(origins) {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins }, (granted) => {
      resolve(Boolean(granted) && !chrome.runtime.lastError);
    });
  });
}

async function ensureHostAccessForUrls(urls, interactive) {
  const patterns = Array.from(new Set((urls || [])
    .map(toOriginPattern)
    .filter(Boolean)));

  if (!patterns.length) return true;

  // Request immediately inside user-gesture handlers to avoid losing gesture
  // through async permission checks.
  if (interactive) {
    return requestOrigins(patterns);
  }

  const missing = [];
  for (const pattern of patterns) {
    const has = await containsOrigins([pattern]);
    if (!has) missing.push(pattern);
  }

  if (!missing.length) return true;
  return false;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Caption with GMN",
    contexts: ["image"]
  });
});

async function ensureInjected(tabId) {
  try {
    // Try to ping the tab with a short timeout.
    const pingPromise = chrome.tabs.sendMessage(tabId, { action: "ping" });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 300));
    await Promise.race([pingPromise, timeoutPromise]);
  } catch (err) {
    // Connection failed or timed out, inject scripts
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"]
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tabId },
      files: ["styles.css"]
    });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  await ensureHostAccessForUrls([tab?.url], true);
  await ensureInjected(tab.id);
  chrome.tabs.sendMessage(tab.id, {
    action: "open_ui"
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_ID) {
    await ensureHostAccessForUrls([info?.srcUrl, info?.pageUrl || tab?.url], true);
    await ensureInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, {
      action: "context_menu_clicked",
      srcUrl: info.srcUrl,
      pageUrl: info.pageUrl || tab?.url || ""
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "proxy_fetch") {
    handleProxyFetch(request, sender, sendResponse);
    return true; // Keep channel open for async response
  }
  if (request.action === "proxy_gemini") {
    handleProxyGemini(request, sendResponse);
    return true;
  }
  if (request.action === "proxy_gemini_upload_file") {
    handleProxyGeminiUploadFile(request, sendResponse);
    return true;
  }
});

function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf(',') < 0) {
    throw new Error('Invalid data URL');
  }
  const parts = dataUrl.split(',');
  const meta = parts[0] || '';
  const b64 = parts[1] || '';
  const mimeMatch = meta.match(/^data:([^;]+);base64$/i);
  const mimeType = (mimeMatch && mimeMatch[1]) ? mimeMatch[1] : 'application/octet-stream';
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getApexHost(hostname) {
  const parts = String(hostname || '').split('.').filter(Boolean);
  if (parts.length < 2) return '';
  return parts.slice(-2).join('.');
}

function buildRefererCandidates(requestUrl, pageReferer) {
  const out = [];
  const seen = new Set();

  function pushCandidate(ref) {
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    out.push(ref);
  }

  function pushFromUrl(raw) {
    if (!raw) return;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      pushCandidate(u.href);
      pushCandidate(u.origin + '/');
      const apex = getApexHost(u.hostname);
      if (apex) pushCandidate(u.protocol + '//' + apex + '/');
    } catch (_) {
      // Ignore invalid URLs.
    }
  }

  pushFromUrl(pageReferer);
  pushFromUrl(requestUrl);
  return out;
}

async function fetchWithTemporaryRefererRule(url, referer, fetchOptions) {
  if (!chrome.declarativeNetRequest) {
    return fetch(url, fetchOptions);
  }

  let refererUrl;
  try {
    refererUrl = new URL(referer);
  } catch (_) {
    return fetch(url, fetchOptions);
  }

  const ruleId = Math.floor(Math.random() * 900000) + 100000;
  const dynamicRule = {
    id: ruleId,
    priority: 100,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'referer', operation: 'set', value: refererUrl.href },
        { header: 'origin', operation: 'set', value: refererUrl.origin }
      ]
    },
    condition: {
      regexFilter: '^' + escapeRegex(url) + '$',
      resourceTypes: ['xmlhttprequest', 'image', 'other']
    }
  };

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [dynamicRule],
      removeRuleIds: [ruleId]
    });
    return await fetch(url, fetchOptions);
  } finally {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [],
        removeRuleIds: [ruleId]
      });
    } catch (_) {
      // Best-effort cleanup.
    }
  }
}

async function handleProxyFetch(request, sender, sendResponse) {
  const hasAccess = await ensureHostAccessForUrls([request.url], false);
  if (!hasAccess) {
    sendResponse({
      success: false,
      error: 'No host permission for image origin. Right-click the image and select "Caption with GMN" to grant access for this site.'
    });
    return;
  }

  const referer = request.referer || sender?.url || "";
  const accept = request.accept || "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
  const refererCandidates = buildRefererCandidates(request.url, referer);
  const attempts = [];

  for (const ref of refererCandidates) {
    attempts.push({
      method: 'GET',
      credentials: 'include',
      cache: 'no-cache',
      redirect: 'follow',
      headers: {
        'Accept': accept
      },
      forcedReferer: ref,
      referrerPolicy: 'strict-origin-when-cross-origin'
    });

    attempts.push({
      method: 'GET',
      credentials: 'include',
      cache: 'no-cache',
      redirect: 'follow',
      headers: { 'Accept': accept },
      forcedReferer: ref,
      referrer: ref,
      referrerPolicy: 'strict-origin-when-cross-origin'
    });
  }

  attempts.push({
    method: 'GET',
    credentials: 'include',
    cache: 'no-cache',
    redirect: 'follow',
    headers: { 'Accept': accept },
    referrerPolicy: 'no-referrer'
  });

  attempts.push({
    method: 'GET',
    cache: 'no-cache',
    redirect: 'follow',
    headers: { 'Accept': accept },
    referrerPolicy: 'no-referrer'
  });

  let lastError = 'Unknown fetch error';
  for (const opts of attempts) {
    try {
      const { forcedReferer, ...fetchOpts } = opts;
      const response = forcedReferer
        ? await fetchWithTemporaryRefererRule(request.url, forcedReferer, fetchOpts)
        : await fetch(request.url, fetchOpts);
      if (!response.ok) {
        lastError = `HTTP error! status: ${response.status}`;
        continue;
      }

      const blob = await response.blob();
      const mime = (blob.type || '').toLowerCase();
      if (mime.startsWith('image/')) {
        const reader = new FileReader();
        reader.onloadend = () => {
          sendResponse({ success: true, dataUrl: reader.result, mime: blob.type });
        };
        reader.readAsDataURL(blob);
        return;
      }

      lastError = `Host returned non-image: ${blob.type || 'unknown'}`;
    } catch (error) {
      lastError = error.message || String(error);
    }
  }

  sendResponse({ success: false, error: lastError });
}

async function handleProxyGemini(request, sendResponse) {
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload)
    });
    
    const data = await response.json();
    sendResponse({ success: true, data: data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleProxyGeminiUploadFile(request, sendResponse) {
  try {
    const apiKey = String(request.apiKey || '').trim();
    const dataUrl = request.dataUrl;
    const displayName = String(request.displayName || 'gic-image').trim();
    if (!apiKey) {
      sendResponse({ success: false, error: 'Missing Gemini API key' });
      return;
    }

    const blob = dataUrlToBlob(dataUrl);
    const startUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`;

    const startResp = await fetch(startUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(blob.size),
        'X-Goog-Upload-Header-Content-Type': blob.type || 'application/octet-stream'
      },
      body: JSON.stringify({ file: { display_name: displayName } })
    });

    if (!startResp.ok) {
      const errText = await startResp.text();
      sendResponse({ success: false, error: 'Failed to start upload: HTTP ' + startResp.status + ' ' + errText });
      return;
    }

    const uploadUrl = startResp.headers.get('X-Goog-Upload-URL') || startResp.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      sendResponse({ success: false, error: 'Upload URL missing from Gemini upload start response' });
      return;
    }

    const finalizeResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
        'Content-Type': blob.type || 'application/octet-stream'
      },
      body: blob
    });

    if (!finalizeResp.ok) {
      const errText = await finalizeResp.text();
      sendResponse({ success: false, error: 'Failed to upload/finalize file: HTTP ' + finalizeResp.status + ' ' + errText });
      return;
    }

    const data = await finalizeResp.json();
    sendResponse({ success: true, data: data });
  } catch (error) {
    sendResponse({ success: false, error: error.message || String(error) });
  }
}

// Gemini Image Captioner - Background Service Worker
// Handles Context Menu and Network Proxy (CORS bypass)

const MENU_ID = "gic-caption-image";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Caption with GMN",
    contexts: ["image"]
  });
});

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, {
    action: "open_ui"
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) {
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
});

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

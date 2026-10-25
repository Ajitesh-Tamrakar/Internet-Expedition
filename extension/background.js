// ===========================
// PLATFORM DETECTION
// ===========================

function detectPlatform(sender) {
    const url = sender?.tab?.url || "";
    if (url.includes("youtube.com"))   return "youtube";
    if (url.includes("twitter.com") || url.includes("x.com")) return "twitter";
    if (url.includes("linkedin.com"))  return "linkedin";
    if (url.includes("pinterest.com")) return "pinterest";
    return "web";
}

// ===========================
// ENTRY POINT
// ===========================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Received message in background:", message);

    if (message.type !== "SAVE") return false;

    const platform = detectPlatform(sender);
    console.log("Detected platform:", platform);

    // Kick off async work; return true so the channel stays open
    handleSave(platform, message.data, sendResponse);
    return true;
});

// ===========================
// ROUTER
// ===========================

async function handleSave(platform, payload, sendResponse) {
    try {
        switch (platform) {
            case "youtube":
                await handleYouTube(payload, sendResponse);
                break;
            case "twitter":
                await handleGeneric(payload, sendResponse);
                break;
            case "linkedin":
            case "pinterest":
            case "web":
            default:
                await handleGeneric(payload, sendResponse);
                break;
        }
    } catch (err) {
        console.error("handleSave crashed:", err);
        sendResponse({ status: "ERROR", error: err.message });
    }
}

// ===========================
// HANDLERS
// ===========================

async function handleYouTube(payload, sendResponse) {
    // YouTube was already working — plain JSON POST, no media download
    await postJSON("http://127.0.0.1:8080/capture/save/", payload, sendResponse);
}

async function handleGeneric(payload, sendResponse) {
    await postJSON("http://127.0.0.1:8080/capture/save/", payload, sendResponse);
}

// ===========================
// FETCH HELPERS
// ===========================

async function postJSON(url, payload, sendResponse) {
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (response.ok) {
            console.log("JSON POST success:", data);
            sendResponse({ status: "OK", data });
        } else {
            console.error("Backend error:", response.status, data);
            sendResponse({ status: "ERROR", code: response.status, error: data });
        }
    } catch (err) {
        console.error("postJSON failed:", err);
        sendResponse({ status: "FETCH_ERROR", error: err.message });
    }
}

// ===========================
// CONTEXT MENU
// ===========================

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id:       "bookmark-save-web",
        title:    "Save to Bookmark",
        contexts: ["page", "selection"],
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "bookmark-save-web") return;

    chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 80 }, (dataUrl) => {
        if (chrome.runtime.lastError) {
            // C5: capture can legitimately fail (disallowed page type, rate limit). Not an
            // error worth surfacing to the user — just proceed without a screenshot.
            dataUrl = null;
        }
        chrome.tabs.sendMessage(tab.id, {
            type: "CAPTURE_WEB",
            selectionText: info.selectionText || null,
            screenshot_base64: dataUrl || null,
        });
    });
});

// ===========================
// MEDIA DOWNLOADER
// ===========================

async function downloadMedia(url) {
    try {
        console.log("Downloading:", url);
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.blob();
    } catch (err) {
        console.error("Download failed:", err);
        return null;
    }
}

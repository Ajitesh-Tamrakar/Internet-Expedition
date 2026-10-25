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
// ATTACH NOTE
// ===========================

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (message.type !== "ATTACH_NOTE") return false;

    const { bookmark_id, note } = message.data || {};
    if (!bookmark_id || !note) return false;

    fetch(`http://127.0.0.1:8080/retrieve/bookmarks/${bookmark_id}/note/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
    }).catch((err) => console.error("ATTACH_NOTE failed:", err));

    return false; // fire-and-forget
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
                // NOTE: handleTwitter (FormData + blob upload) is intentionally NOT
                // used yet. The backend capture view only parses JSON (json.loads on
                // request.body) and has no file/image storage, so multipart POSTs 400.
                // Two more changes are needed before switching: (1) backend multipart +
                // media storage, (2) fix handleTwitter to read
                // payload.platform_specific_data.images (not payload.images).
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

async function handleTwitter(payload, sendResponse) {
    // Download images the extension can reach (pbs.twimg.com — no auth needed).
    // Videos are HLS streams; we pass tweetUrl and let the backend use yt-dlp.
    const formData = new FormData();
    formData.append("tweet_data", JSON.stringify(payload));

    if (payload.images?.length) {
        console.group("Downloading tweet images");

        for (let i = 0; i < payload.images.length; i++) {
            const blob = await downloadMedia(payload.images[i]);
            if (blob) {
                formData.append("images", blob, `image_${i}.jpg`);
                console.log(`image_${i}:`, blob.size, blob.type);
            } else {
                console.warn(`image_${i} download failed, skipping`);
            }
        }

        console.groupEnd();
    }

    await postFormData("http://127.0.0.1:8080/capture/save/", formData, sendResponse);
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
            sendResponse({
                status: "ERROR",
                code: response.status,
                error: data,
                setupRequired: response.status === 503 && !!data?.message,
                message: data?.message,
            });
        }
    } catch (err) {
        console.error("postJSON failed:", err);
        sendResponse({ status: "FETCH_ERROR", error: err.message });
    }
}

async function postFormData(url, formData, sendResponse) {
    try {
        // Do NOT set Content-Type manually — browser sets it with the boundary
        const response = await fetch(url, {
            method: "POST",
            body: formData,
        });

        const data = await response.json();

        if (response.ok) {
            console.log("FormData POST success:", data);
            sendResponse({ status: "OK", data });
        } else {
            console.error("Backend error:", response.status, data);
            sendResponse({
                status: "ERROR",
                code: response.status,
                error: data,
                setupRequired: response.status === 503 && !!data?.message,
                message: data?.message,
            });
        }
    } catch (err) {
        console.error("postFormData failed:", err);
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
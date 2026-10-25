/* ===========================
   SAVED-STATE HELPER (shared, duplicated per content script)
=========================== */

function bmSetState(btn, next, message) { // 'saving' | 'saved' | 'error'
    if (!btn) return;
    btn.classList.remove("bm-saving", "bm-saved", "bm-error");
    const label = btn.querySelector(".bm-label");
    if (next === "saving") btn.classList.add("bm-saving");
    if (next === "error") {
        // reset aria back to the idle/unsaved announcement — otherwise a failure
        // after a prior success leaves aria-pressed="true"/"Saved" under a red stroke
        btn.classList.add("bm-error");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", message || "Save to Bookmark");
        if (label) label.textContent = "Save";
    }
    if (next === "saved") {
        btn.classList.add("bm-saved");
        btn.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-label", "Saved to Bookmark");
        if (label) label.textContent = "Saved";
        btn.classList.remove("bm-pulse");
        void btn.offsetWidth; // reflow so the pulse can replay
        btn.classList.add("bm-pulse");
    }
}

function injectSaveButton() {

    // Prevent duplicates
    if (document.querySelector(".my-save-btn-wrapper")) {
        return;
    }

    // Find Share button wrapper
    const shareWrapper = document.querySelector(
        '#top-level-buttons-computed yt-button-view-model'
    );

    if (!shareWrapper) {
        return;
    }

    // Clone Share button
    const saveWrapper = shareWrapper.cloneNode(true);
    console.log("SAVE WRAPPER:", saveWrapper);
    console.log("SAVE WRAPPER HTML:", saveWrapper.innerHTML);

    saveWrapper.classList.add("my-save-btn-wrapper");

    // Change text
    const text = saveWrapper.querySelector(
        '.ytSpecButtonShapeNextButtonTextContent'
    );

    if (text) {
        text.textContent = "Save";
    }

    // Replace icon
    const iconWrapper = saveWrapper.querySelector(".ytIconWrapperHost");

    console.log("ICON WRAPPER:", iconWrapper);

    if (iconWrapper) {
        iconWrapper.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" style="display:block">
            <path class="bm-ribbon" d="M6 3.5C6 2.67 6.67 2 7.5 2h9c.83 0 1.5.67 1.5 1.5v18l-7-4.5-7 4.5v-18z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none" />
            <circle class="bm-dot" cx="12" cy="9" r="1.7" fill="#EF9F27" />
        </svg>`;
    }
    // Find actual button
    const btn = saveWrapper.querySelector("button");

    const channel = document.querySelector(
        'ytd-video-owner-renderer ytd-channel-name a'
    );

    if (btn) {

        btn.setAttribute("aria-label", "Save");

        // Replace button to remove YouTube listeners
        const newBtn = btn.cloneNode(true);

        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.classList.add("bm-btn", "bm-btn--youtube");
        newBtn.setAttribute("aria-pressed", "false");

        // Your click event
        newBtn.addEventListener("click", () => {

            const videoUrl = window.location.href;
            const title = document.title;

            const author = channel
                ? channel.textContent.trim()
                : '';

            const authorLink = channel
                ? channel.href
                : '';

            const mandatory_fields = {
                source_url: videoUrl,
                platform: 'youtube',
                content_type: 'video',
                capture_method: 'Platform_injection',
            };

            const platform_specific_data = {
                title: title,
                author: author,
                author_link: authorLink,
            };

            const data = {
                mandatory_fields,
                platform_specific_data
            };

            console.log('capturedData', data);

            bmSetState(newBtn, "saving");
            chrome.runtime.sendMessage({ type: "SAVE", data }, (response) => {
                if (!chrome.runtime.lastError && response?.status === "OK") {
                    bmSetState(newBtn, "saved");
                    window.bmShowConfirmation(response.data?.bookmark_id);
                } else if (response?.setupRequired) {
                    bmSetState(newBtn, "error");
                    window.bmShowSetupRequired(response.message);
                } else {
                    bmSetState(newBtn, "error", window.bmErrorMessage(response));
                    window.bmShowError(response);
                }
            });
        });
    }

    // Add after Share button
    shareWrapper.after(saveWrapper);

    console.log("Save button injected");
}

// Observe page changes
const observer = new MutationObserver(() => {
    injectSaveButton();
});

// Start observer
observer.observe(document.body, {
    childList: true,
    subtree: true
});

// Initial run
injectSaveButton();
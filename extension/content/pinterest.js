const BUTTON_CLASS = "my-pinterest-save-btn";

console.log("[PINTEREST-EXT] Loaded");

/* ===========================
   SAVED-STATE HELPER (shared, duplicated per content script)
=========================== */

function bmSetState(btn, next) { // 'saving' | 'saved' | 'error'
    if (!btn) return;
    btn.classList.remove("bm-saving", "bm-saved", "bm-error");
    const label = btn.querySelector(".bm-label");
    if (next === "saving") btn.classList.add("bm-saving");
    if (next === "error") {
        // reset aria back to the idle/unsaved announcement — otherwise a failure
        // after a prior success leaves aria-pressed="true"/"Saved" under a red stroke
        btn.classList.add("bm-error");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", "Save to Bookmark");
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

/* ===========================
   EXTRACT PIN
=========================== */

function extractPin(pin) {
    const img = pin.querySelector("img");

    const link =
        pin.querySelector('a[href*="/pin/"]');

    const mandatory_fields = {
        source_url: link?.href || "",
        platform: "pinterest",
        content_type: {
            'image': true,
            'video': false,
            'text': true,
        },
        capture_method: 'platform_injection',
    };

    const platform_specific_data = {
        pin_id: pin.dataset.testPinId || "",
        image_url: img?.src || "",
        image_srcset: img?.srcset || "",
        alt_text: img?.alt || ""
    };

    console.log("[PINTEREST-EXT] Extracted Pin Data", {
        mandatory_fields,
        platform_specific_data
    });
    return {        
        mandatory_fields,
        platform_specific_data
    };
}

/* ===========================
   BUTTON CLICK
=========================== */

function onButtonClick(event, pin) {
    event.preventDefault();
    event.stopPropagation();

    const btn = event.currentTarget;
    const payload = extractPin(pin);

    console.group("📌 Sending Pin Payload");
    console.log(payload);
    console.log(JSON.stringify(payload, null, 2));
    console.groupEnd();

    bmSetState(btn, "saving");

    chrome.runtime.sendMessage({ type: "SAVE", data: payload }, (response) => {
        console.group("📨 Response From Background");
        console.log(response);
        if (chrome.runtime.lastError) {
            console.error("Runtime Error:", chrome.runtime.lastError);
        }
        console.groupEnd();
        bmSetState(btn, response?.status === "OK" ? "saved" : "error");
        if (response?.status === "OK") {
            window.bmShowConfirmation(response.data?.bookmark_id);
        }
    });
}
/* ===========================
   ADD BUTTON
=========================== */

function addButton(pin) {
    if (!pin) return;

    if (pin.querySelector(`.${BUTTON_CLASS}`)) {
        return;
    }

    const btn = document.createElement("button");

    btn.className = "my-pinterest-save-btn bm-btn bm-btn--pinterest";
    btn.type = "button";
    btn.setAttribute("aria-label", "Save to Bookmark");
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = `
        <span class="bm-icon-wrap">
            <svg viewBox="0 0 24 24" width="15" height="15">
                <path class="bm-ribbon" d="M6 3.5C6 2.67 6.67 2 7.5 2h9c.83 0 1.5.67 1.5 1.5v18l-7-4.5-7 4.5v-18z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none" />
                <circle class="bm-dot" cx="12" cy="9" r="1.7" fill="#EF9F27" />
            </svg>
        </span>`;

    // instance positioning only — bottom-left, clear of Pinterest's own top-right Save pill
    Object.assign(btn.style, {
        position: "absolute",
        bottom: "8px",
        left: "8px",
        zIndex: "999999"
    });

    btn.addEventListener("click", (e) =>
        onButtonClick(e, pin)
    );

    pin.style.position = "relative";
    pin.appendChild(btn);

    console.log(
        "[PINTEREST-EXT] Button added",
        pin.dataset.testPinId
    );
}

/* ===========================
   SCAN PINS
=========================== */

function scanPins() {
    const pins =
        document.querySelectorAll(
            '[data-test-id="pin"]'
        );

    if (!pins.length) {
        return;
    }

    pins.forEach(addButton);
}

/* ===========================
   WAIT FOR PINTEREST
=========================== */

let started = false;

const bootstrap = setInterval(() => {
    const pins =
        document.querySelectorAll(
            '[data-test-id="pin"]'
        );

    console.log(
        "[PINTEREST-EXT] Pins currently:",
        pins.length
    );

    if (!pins.length) {
        return;
    }

    if (!started) {
        started = true;

        console.log(
            "[PINTEREST-EXT] Pinterest feed detected"
        );

        scanPins();

        setInterval(scanPins, 2000);
    }

    clearInterval(bootstrap);

}, 1000);
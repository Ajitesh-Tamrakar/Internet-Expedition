(function () {
    const AUTO_DISMISS_MS = 3000;
    const ERROR_DISMISS_MS = 10000;

    let overlayEl = null;
    let hideTimer = null;
    let hideDeadline = null;
    let hidePausedRemaining = null;

    function buildOverlay() {
        const root = document.createElement("div");
        root.id = "bm-confirmation-toast";
        root.className = "bm-toast";
        root.innerHTML = `
            <div class="bm-panel bm-active" data-panel="confirmation">
                <div class="bm-drain-track"><div class="bm-drain-fill"></div></div>
                <div class="conf-inner">
                    <div class="conf-head">
                        <svg width="14" height="14" viewBox="0 0 24 24" style="flex:0 0 auto">
                            <path d="M6 3.5C6 2.67 6.67 2 7.5 2h9c.83 0 1.5.67 1.5 1.5v18l-7-4.5-7 4.5v-18z" fill="#ef9f27" stroke="#ef9f27" stroke-width="1.4" stroke-linejoin="round"/>
                            <circle cx="12" cy="9" r="1.7" fill="#0a0a0b"/>
                        </svg>
                        <span class="conf-title">Saved</span>
                        <button class="bm-close" type="button" aria-label="Dismiss">×</button>
                    </div>
                    <div class="conf-status">Indexing in background…</div>
                    <div class="conf-url"></div>
                </div>
            </div>
            <div class="bm-panel" data-panel="error">
                <div class="conf-inner">
                    <div class="conf-head">
                        <svg width="14" height="14" viewBox="0 0 24 24" style="flex:0 0 auto">
                            <path d="M12 2L1 21h22L12 2z" fill="none" stroke="#e5484d" stroke-width="1.6" stroke-linejoin="round"/>
                            <path d="M12 9v5" stroke="#e5484d" stroke-width="1.8" stroke-linecap="round"/>
                            <circle cx="12" cy="17" r="1" fill="#e5484d"/>
                        </svg>
                        <span class="conf-title">Couldn't save</span>
                        <button class="bm-close" type="button" aria-label="Dismiss">×</button>
                    </div>
                    <div class="error-msg"></div>
                    <div class="error-actions"></div>
                </div>
            </div>
        `;
        document.body.appendChild(root);

        overlayEl = root;

        attachListeners(root);

        return root;
    }

    function getOverlay() {
        if (overlayEl && document.body.contains(overlayEl)) return overlayEl;
        return buildOverlay();
    }

    function restartDrain(toast) {
        const fill = toast.querySelector(".bm-drain-fill");
        if (!fill) return;
        fill.classList.remove("bm-draining");
        void fill.offsetWidth; // reflow — required to restart a finished CSS animation
        fill.classList.add("bm-draining");
        fill.style.animationPlayState = "";
    }

    function dismiss(toast) {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        hidePausedRemaining = null;
        toast.classList.remove("bm-open");
    }

    function scheduleHide(toast, ms) {
        if (hideTimer) clearTimeout(hideTimer);
        hideDeadline = Date.now() + ms;
        hideTimer = setTimeout(() => {
            hideTimer = null;
            dismiss(toast);
        }, ms);
    }

    function pauseHide() {
        if (!hideTimer) return;
        clearTimeout(hideTimer);
        hideTimer = null;
        hidePausedRemaining = Math.max(0, hideDeadline - Date.now());
    }

    function resumeHide(toast) {
        if (hidePausedRemaining == null) return;
        const remaining = hidePausedRemaining;
        hidePausedRemaining = null;
        scheduleHide(toast, remaining);
    }

    function attachListeners(toast) {
        if (toast.dataset.bmWired) return;
        toast.dataset.bmWired = "1";

        toast.addEventListener("mouseenter", () => {
            if (toast.querySelector('[data-panel="error"].bm-active')) pauseHide();
        });
        toast.addEventListener("mouseleave", () => {
            if (toast.querySelector('[data-panel="error"].bm-active')) resumeHide(toast);
        });

        toast.querySelectorAll(".bm-close").forEach((btn) => {
            btn.addEventListener("click", () => dismiss(toast));
        });
    }

    window.bmShowConfirmation = function (bookmarkId) {
        const toast = getOverlay();

        toast.querySelector(".conf-url").textContent =
            location.hostname + (document.title ? " · " + document.title : "");

        toast.querySelectorAll(".bm-panel").forEach((p) => {
            p.classList.toggle("bm-active", p.dataset.panel === "confirmation");
        });
        toast.style.height = "";

        toast.classList.add("bm-open");
        restartDrain(toast);

        scheduleHide(toast, AUTO_DISMISS_MS);
    };

    window.bmErrorMessage = function (response) {
        if (!response || response.status === "FETCH_ERROR") {
            return "Couldn't save this — check your connection and try again.";
        }
        if (response.code === 400) {
            return "This page couldn't be read.";
        }
        return "Something went wrong saving this. It wasn't saved.";
    };

    window.bmShowError = function (response) {
        const toast = getOverlay();

        const message = window.bmErrorMessage(response);
        const isFetchError = !response || response.status === "FETCH_ERROR";
        const isInvalidPayload = !isFetchError && response.code === 400;

        toast.querySelector(".error-msg").textContent = message;

        const actions = toast.querySelector(".error-actions");
        actions.innerHTML = "";

        if (!isFetchError && !isInvalidPayload) {
            const detail = typeof response.error === "string"
                ? response.error
                : (response.error?.error || JSON.stringify(response.error || {}));
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "error-copy-btn";
            btn.textContent = "Copy details";
            btn.addEventListener("click", () => {
                navigator.clipboard.writeText(detail).catch(() => {});
                btn.textContent = "Copied";
                setTimeout(() => { btn.textContent = "Copy details"; }, 1500);
            });
            actions.appendChild(btn);
        }

        toast.querySelectorAll(".bm-panel").forEach((p) => {
            p.classList.toggle("bm-active", p.dataset.panel === "error");
        });
        toast.style.height = "";

        toast.classList.add("bm-open");
        scheduleHide(toast, ERROR_DISMISS_MS);
    };
})();

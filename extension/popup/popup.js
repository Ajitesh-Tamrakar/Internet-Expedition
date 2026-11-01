// Internet Expedition — popup (contract §10: structure and layout).
//
// popup.html defines BOTH views statically; this file's only §10 job is
// deciding which one is visible.
//
// TEMPORARY STATE — replaced in §11: the real view comes from the
// worker, which owns all authentication (contract §4/§7):
//   on open  → USER (doubles as the session check):
//              {status:"OK", user} = signed in · {status:"UNAUTHENTICATED"} = signed out
//   live     → the worker's `session_state` storage write (the C2
//              chrome.storage.onChanged broadcast) re-renders an open popup.
// §11 swaps the temporary constant below for that wiring.
//
// To verify the two layouts in §10: flip TEMP_SESSION_STATE between
// "signed_out" and "signed_in" and reopen the popup.
//
// No bus messages, no fetch, no token or cookie access live here — the
// popup never talks to the backend directly (that is §11 onward, through
// the worker).

const SESSION_STATES = {
    SIGNED_IN: "signed_in",
    SIGNED_OUT: "signed_out",
};

// The temporary hardcoded state (replaced in §11).
const TEMP_SESSION_STATE = SESSION_STATES.SIGNED_IN;

// The profile tooltip's name. §10: the temporary placeholder — §13
// replaces it with the real name from the worker's USER response
// (first_name + last_name, falling back to display, then email).
const TEMP_PROFILE_NAME = "User";

const signedInView = document.getElementById("view-signed-in");
const signedOutView = document.getElementById("view-signed-out");
const profileTooltip = document.getElementById("profile-tooltip");

function render(state) {
    signedInView.hidden = state !== SESSION_STATES.SIGNED_IN;
    signedOutView.hidden = state !== SESSION_STATES.SIGNED_OUT;
}

// The script tag sits after both views in popup.html, so the elements
// exist when this runs.
profileTooltip.textContent = TEMP_PROFILE_NAME;
render(TEMP_SESSION_STATE);

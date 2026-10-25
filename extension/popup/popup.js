document.addEventListener("DOMContentLoaded", () => {
  chrome.tabs.create({ url: "http://localhost:8081" });
  window.close();
});

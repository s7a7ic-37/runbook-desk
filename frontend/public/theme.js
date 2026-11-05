// Apply before page content to avoid a light flash at night.
(function () {
  function updateTheme() {
    const hour = new Date().getHours();
    const theme = hour >= 19 || hour < 7 ? "dark" : "light";
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      window.dispatchEvent(new Event("themechange"));
    }
  }
  updateTheme();
  setInterval(updateTheme, 60000);
  document.addEventListener("visibilitychange", updateTheme);
  window.addEventListener("focus", updateTheme);
})();

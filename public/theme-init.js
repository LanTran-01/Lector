// Runs before first paint (blocking <script> in <head>) so the saved theme doesn't flash.
try {
  var s = JSON.parse(localStorage.getItem("lector.settings") || "{}");
  if (s.theme === "light" || s.theme === "dark") document.documentElement.dataset.theme = s.theme;
  if (s.dimPages === false) document.documentElement.dataset.dimPages = "off";
} catch (e) {}

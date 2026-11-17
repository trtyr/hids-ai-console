/* 主题初始化：在页面绘制前设置 data-theme，避免首屏闪白。 */
(function () {
  "use strict";

  var KEY = "hids-theme";
  var root = document.documentElement;

  function readStored() {
    try {
      return localStorage.getItem(KEY);
    } catch (error) {
      return null;
    }
  }

  function systemTheme() {
    if (!window.matchMedia) return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  var initial = readStored();
  if (initial !== "light" && initial !== "dark") initial = systemTheme();
  root.setAttribute("data-theme", initial);

  function sync() {
    var light = root.getAttribute("data-theme") === "light";
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    Array.prototype.forEach.call(toggles, function (button) {
      var label = light ? "切换到深色模式" : "切换到浅色模式";
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      var text = button.querySelector("[data-theme-label]");
      if (text) text.textContent = light ? "深色" : "浅色";
    });
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch (error) {
      /* 本地存储不可用时仅切换当前页面 */
    }
    sync();
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-theme-toggle]");
    if (!button) return;
    apply(root.getAttribute("data-theme") === "light" ? "dark" : "light");
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sync);
  } else {
    sync();
  }
})();

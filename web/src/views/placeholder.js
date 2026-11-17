// 未实现页的占位。样式沿用设计稿 overview.html 的 `.placeholder`（:441-451）：
// 居中、标题 + 一行说明，不加按钮也不假装有数据（D003：接口没给就不补）。
//
// 用法：页面模块（web/pages/*.js）在 `render(content)` 里把它塞进内容区。
// 六张页面卡（P002-T002…T007）接手时，把这里换成真实渲染，别的文件不用动。

/**
 * @param {string} label 页面名（总览 / 告警 / …）
 * @returns {HTMLElement}
 */
export function mountPlaceholder(label) {
  const host = document.createElement('div');
  host.className = 'placeholder';
  host.innerHTML = `
    <div>
      <h2>${label}尚未接入</h2>
      <p>这一页还没有接后端接口。</p>
    </div>`;
  return host;
}

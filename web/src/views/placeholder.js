// 未实现页的占位。样式沿用设计稿 overview.html 的 `.placeholder`（:441-451）：
// 居中、标题 + 一行说明，不加按钮也不假装有数据（D003：接口没给就不补）。

/**
 * @param {{ label: string }} route
 * @returns {HTMLElement}
 */
export function mountPlaceholder(route) {
  const host = document.createElement('div');
  host.className = 'placeholder';
  host.innerHTML = `
    <div>
      <h2>${route.label}尚未接入</h2>
      <p>这一页还没有接后端接口。</p>
    </div>`;
  return host;
}

// 页面：知识库
// 本卡（P002-T001）只留位：壳与路由已经接好，内容还是占位。
// 接后端时只改这个文件的 render()，不要改壳、路由或别的页面。

import { mountPlaceholder } from '../src/views/placeholder.js';

export const page = {
  id: 'knowledge',
  title: '知识库',
  navLabel: '知识库',
  /**
   * @param {HTMLElement} content 内容区容器（壳提供的空 div）
   * @param {{ params: string[] }} _context 路由参数（分隔符后的段，如告警详情 id）
   */
  render(content, _context) {
    content.replaceChildren(mountPlaceholder('知识库'));
  },
};

// 登录视图。布局与文案来自设计稿 index.html（左品牌栏 + 右 396px 卡片）。
// 数据来源：形态 B，提交走 src/session.js 的 probeSession（GET /api/session）。
// 稿里的演示账号（DEMO 常量、卡片下方那行标注、本地比对）整段没有搬过来——凭据只能来自用户输入。

const BRAND_MARK = `
  <svg class="brand-mark" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
    <path d="M14 2.6 24 8.3v11.4L14 25.4 4 19.7V8.3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
    <path d="M9.4 11.4h9.2M9.4 14.6h9.2M11 17.8h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".85" />
  </svg>`;

// 左侧攻击链路底图：稿 index.html 的内联 SVG，原样搬（只做气质，不承载信息）
const TOPOLOGY = `
  <svg class="topology" viewBox="0 0 720 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <g fill="none" stroke="currentColor" stroke-width="1" opacity=".2">
      <circle cx="470" cy="640" r="300" opacity=".5" />
      <circle cx="470" cy="640" r="196" opacity=".7" />
      <path d="M150 250 250 330M250 330 210 460M250 330 360 420M360 420 420 560M420 560 560 620M560 620 600 760M600 760 470 800" />
      <path d="M210 460 420 560" stroke-dasharray="4 6" opacity=".8" />
      <path d="M360 420 560 620" stroke-dasharray="4 6" opacity=".8" />
      <path d="M420 560 470 800" stroke-dasharray="4 6" opacity=".8" />
      <path d="M470 640 660 560" opacity=".4" />
    </g>
    <g fill="currentColor" opacity=".5">
      <circle cx="150" cy="250" r="3" />
      <circle cx="250" cy="330" r="4" />
      <circle cx="210" cy="460" r="3" />
      <circle cx="360" cy="420" r="5" />
      <circle cx="420" cy="560" r="3.5" />
      <circle cx="560" cy="620" r="6" />
      <circle cx="600" cy="760" r="3" />
      <circle cx="470" cy="800" r="4" />
    </g>
    <g fill="none" stroke="currentColor" stroke-width="1" opacity=".3">
      <circle cx="560" cy="620" r="14" />
      <circle cx="360" cy="420" r="11" />
    </g>
  </svg>`;

const TEMPLATE = `
<div class="page">
  <aside class="brand-panel">
    ${TOPOLOGY}
    <div class="brand">
      ${BRAND_MARK}
      <span class="brand-name">HIDS</span>
      <span class="brand-sep" aria-hidden="true"></span>
      <span class="brand-sub">AI 研判平台</span>
    </div>
    <div class="brand-mid">
      <p class="statement">告警是起点，<br />结论才是答案。</p>
    </div>
    <div class="brand-foot">
      <span>仅限授权人员使用</span>
    </div>
  </aside>

  <main class="auth">
    <section class="card" aria-labelledby="login-title">
      <h1 id="login-title">登录</h1>

      <div class="banner" data-role="banner" role="alert" aria-live="assertive" hidden>
        <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true" style="--od-icon-size:14px">
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M8 4.9v3.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          <circle cx="8" cy="11.2" r="0.9" fill="currentColor" />
        </svg>
        <span class="banner-body">
          <strong data-role="banner-title">登录失败</strong>
          <span class="banner-text" data-role="banner-text"></span>
        </span>
      </div>

      <form data-role="form" novalidate>
        <div class="field">
          <div class="field-head">
            <label for="username">账号</label>
          </div>
          <input id="username" name="username" type="text" autocomplete="username" spellcheck="false"
                 placeholder="请输入账号" required aria-describedby="username-error" />
          <p class="field-error" id="username-error" data-role="username-error" hidden>请输入账号。</p>
        </div>

        <div class="field">
          <div class="field-head">
            <label for="password">密码</label>
            <button type="button" class="reveal" data-role="reveal" aria-pressed="false" aria-controls="password">
              <svg class="od-icon" viewBox="0 0 20 20" aria-hidden="true" style="--od-icon-size:15px">
                <path d="M1.9 10S5 5 10 5s8.1 5 8.1 5-3.1 5-8.1 5-8.1-5-8.1-5Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                <circle cx="10" cy="10" r="2.3" fill="none" stroke="currentColor" stroke-width="1.3" />
                <path class="eye-slash" d="M3.4 16.6 16.6 3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              </svg>
              <span data-role="reveal-label">显示</span>
            </button>
          </div>
          <input id="password" name="password" type="password" autocomplete="current-password"
                 placeholder="请输入密码" required aria-describedby="password-error" />
          <p class="field-error" id="password-error" data-role="password-error" hidden>请输入密码。</p>
        </div>

        <button class="submit" data-role="submit" type="submit">
          <span class="spinner" data-role="spinner" aria-hidden="true" hidden></span>
          <span data-role="submit-label">登录</span>
        </button>

        <p class="helper">账号由管理员分配，无法登录请联系管理员。</p>
      </form>
    </section>
  </main>
</div>`;

/** 错误 → 横幅文案。kind 来自 SessionError（src/session.js）。 */
export function bannerFor(error) {
  switch (error?.kind) {
    case 'unauthorized':
      return { tone: 'danger', title: '登录失败', text: '账号或密码不正确。' };
    case 'network':
      return { tone: 'warn', title: '无法连接', text: '连不上研判服务，请检查网络或稍后重试。' };
    case 'http':
      return { tone: 'danger', title: '登录失败', text: `服务返回异常（${error.status}），请稍后重试。` };
    default:
      return { tone: 'danger', title: '登录失败', text: '服务返回的会话信息无法识别，请稍后重试。' };
  }
}

/**
 * 挂载登录视图。
 * @param {{
 *   onAuthenticate: (credentials: { user: string, password: string }) => Promise<{ authenticated: true }>,
 *   onSuccess: () => void,
 * }} options
 */
export function mountLogin({ onAuthenticate, onSuccess }) {
  const host = document.createElement('div');
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);

  const form = $('form');
  const userInput = host.querySelector('#username');
  const passInput = host.querySelector('#password');
  const userError = $('username-error');
  const passError = $('password-error');
  const banner = $('banner');
  const bannerTitle = $('banner-title');
  const bannerText = $('banner-text');
  const submit = $('submit');
  const submitLabel = $('submit-label');
  const spinner = $('spinner');
  const reveal = $('reveal');
  const revealLabel = $('reveal-label');

  let submitting = false;

  function showBanner({ tone, title, text }) {
    banner.dataset.tone = tone;
    bannerTitle.textContent = title;
    bannerText.textContent = text;
    banner.hidden = false;
  }

  function clearBanner() {
    banner.hidden = true;
    bannerText.textContent = '';
  }

  function setFieldError(input, errorNode, invalid) {
    if (invalid) {
      input.setAttribute('aria-invalid', 'true');
      errorNode.hidden = false;
    } else {
      input.removeAttribute('aria-invalid');
      errorNode.hidden = true;
    }
  }

  function validateUser() {
    const ok = userInput.value.trim() !== '';
    setFieldError(userInput, userError, !ok);
    return ok;
  }

  function validatePass() {
    const ok = passInput.value !== '';
    setFieldError(passInput, passError, !ok);
    return ok;
  }

  function setSubmitting(busy) {
    submitting = busy;
    submit.disabled = busy;
    spinner.hidden = !busy;
    submitLabel.textContent = busy ? '正在登录…' : '登录';
    form.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  async function submitForm(event) {
    event?.preventDefault();
    if (submitting) return;
    clearBanner();
    const userOk = validateUser();
    const passOk = validatePass();
    if (!userOk) { userInput.focus(); return; }
    if (!passOk) { passInput.focus(); return; }

    setSubmitting(true);
    try {
      await onAuthenticate({ user: userInput.value.trim(), password: passInput.value });
      onSuccess();
    } catch (error) {
      setSubmitting(false);
      const copy = bannerFor(error);
      showBanner(copy);
      passInput.value = '';
      passInput.focus();
    }
  }

  form.addEventListener('submit', submitForm);
  userInput.addEventListener('blur', validateUser);
  passInput.addEventListener('blur', validatePass);
  userInput.addEventListener('input', () => { if (userInput.value.trim()) setFieldError(userInput, userError, false); });
  passInput.addEventListener('input', () => { if (passInput.value) setFieldError(passInput, passError, false); });

  reveal.addEventListener('click', () => {
    const shown = reveal.getAttribute('aria-pressed') === 'true';
    reveal.setAttribute('aria-pressed', shown ? 'false' : 'true');
    passInput.type = shown ? 'password' : 'text';
    revealLabel.textContent = shown ? '显示' : '隐藏';
  });

  // 视图返回后由调用方插进文档；插进去之后再把焦点放到账号框（未挂载的节点 focus() 不生效）
  queueMicrotask(() => { if (userInput.isConnected) userInput.focus(); });

  return { element: host, form };
}

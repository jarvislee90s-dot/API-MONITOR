const { chromium } = require('playwright');
(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    console.log('contexts:', contexts.length);
    const page = contexts[0].pages()[0];
    console.log('page url:', page.url());
    const cookies = await contexts[0].cookies();
    console.log('total cookies:', cookies.length);
    const aliyunCookies = cookies.filter(c => c.domain.includes('aliyun.com') || c.domain.includes('alibaba.com') || c.domain.includes('bailian'));
    console.log('aliyun/bailian cookies:', aliyunCookies.length);
    const cookieStr = aliyunCookies.map(c => c.name + '=' + c.value).join('; ');
    console.log('COOKIE_START');
    console.log(cookieStr);
    console.log('COOKIE_END');
    await browser.close();
  } catch(e) {
    console.error('Error:', e.message);
  }
})();

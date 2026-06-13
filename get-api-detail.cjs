const { chromium } = require('playwright');
(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];
    
    // 监听网络请求，获取详细信息
    page.on('request', request => {
      const url = request.url();
      if (url.includes('queryCodingPlanInstanceInfoV2')) {
        console.log('=== API DETECTED ===');
        console.log('URL:', url);
        console.log('METHOD:', request.method());
        console.log('HEADERS:', JSON.stringify(request.headers()));
        console.log('POST_DATA:', request.postData());
        console.log('===================');
      }
    });
    
    // 刷新页面触发请求
    await page.reload();
    await page.waitForTimeout(8000);
    
    await browser.close();
  } catch(e) {
    console.error('Error:', e.message);
  }
})();

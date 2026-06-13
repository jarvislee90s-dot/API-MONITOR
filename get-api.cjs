const { chromium } = require('playwright');
(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];
    console.log('page url:', page.url());
    
    // ¼àÌýÍøÂçÇëÇó
    page.on('request', request => {
      const url = request.url();
      if (url.includes('coding') || url.includes('plan') || url.includes('quota') || url.includes('subscription') || url.includes('api')) {
        console.log('API_REQUEST:', request.method(), url);
      }
    });
    
    // Ë¢ÐÂÒ³Ãæ´¥·¢ÇëÇó
    await page.reload();
    await page.waitForTimeout(5000);
    
    await browser.close();
  } catch(e) {
    console.error('Error:', e.message);
  }
})();

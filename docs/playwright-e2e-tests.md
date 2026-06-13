# Playwright E2E 测试案例 - 分层供应商账号配置页

## 测试目标
验证"供应商 → 多账号 → 账号配置"的三层工作台功能在真实浏览器环境中正确运行。

## 前置条件
- 已部署 Worker 到 Cloudflare
- 已配置 Supabase 数据库和至少一个供应商账号
- Admin Token 已生成

## 测试场景

### 1. 首页供应商卡片显示
**测试步骤：**
1. 访问 `https://apimonitor.jarvislee90s.workers.dev`
2. 等待页面加载完成
3. 验证每个供应商卡片正确显示：
   - OpenRouter: 状态标签（健康/部分接入/待登录）
   - OpenCode Go: 状态标签
   - 讯飞 MaaS: 状态标签
   - 阿里云百炼: 显示"入口型"标签

**预期结果：**
- 最多 4 个供应商卡片
- 每个卡片包含账号子卡片切换器（如果有多账号）
- 卡片主体显示第一个账号的数据

### 2. 账号子卡片切换
**测试步骤：**
1. 找到有多账号的供应商卡片（如 OpenRouter）
2. 点击第二个账号子卡片
3. 验证卡片主体数据更新

**预期结果：**
- 子卡片高亮状态切换
- 卡片主体的 summary、quotaWindows、links 更新为选中账号数据

### 3. 设置页供应商卡片池
**测试步骤：**
1. 访问 `https://apimonitor.jarvislee90s.workers.dev/#/settings`
2. 输入 Admin Token
3. 验证供应商卡片池：
   - OpenRouter: 显示"已配置"标签
   - 阿里云百炼: 显示"入口型"标签

**预期结果：**
- 卡片池按状态分组显示
- 点击卡片后账号层和配置层更新

### 4. 账号首页显示控制
**测试步骤：**
1. 在设置页选择一个供应商
2. 找到"首页显示账号"列表
3. 点击"停用"按钮
4. 验证账号从启用列表移动到未启用列表
5. 点击"启用"按钮
6. 验证账号返回启用列表

**预期结果：**
- 停用后账号移动到下方列表
- 启用后账号移动到上方列表并显示绿色背景

### 5. 阿里云百炼入口型说明
**测试步骤：**
1. 点击"编辑 阿里云百炼"
2. 验证账号层显示"暂无首页显示账号"
3. 验证配置层显示：
   - 原网页 URL 输入框
   - description 显示"原网页入口"
   - 无凭据字段

**预期结果：**
- 只显示 pageUrl 输入
- 不显示 apiKey/authCookie 等凭据字段

## Playwright 代码示例

```typescript
import { test, expect } from '@playwright/test';

const BASE_URL = 'https://apimonitor.jarvislee90s.workers.dev';
const ADMIN_TOKEN = process.env.ADMIN_SETUP_TOKEN || '';

test.describe('分层供应商账号配置页', () => {
  test('首页显示供应商卡片', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForSelector('.platform-card');
    
    const cards = await page.locator('.platform-card').count();
    expect(cards).toBeGreaterThanOrEqual(1);
    
    // 验证账号切换器存在（如果有多账号）
    const switcher = page.locator('.account-switcher');
    if (await switcher.count() > 0) {
      const chips = await switcher.locator('.account-chip').count();
      expect(chips).toBeGreaterThan(1);
    }
  });

  test('账号子卡片切换', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForSelector('.platform-card');
    
    const switcher = page.locator('.account-switcher').first();
    if (await switcher.count() > 0) {
      const firstChip = switcher.locator('.account-chip').first();
      const secondChip = switcher.locator('.account-chip').nth(1);
      
      await secondChip.click();
      await page.waitForTimeout(500);
      
      // 验证选中状态
      expect(await secondChip.getAttribute('class')).toContain('is-selected');
    }
  });

  test('设置页供应商卡片池', async ({ page }) => {
    await page.goto(`${BASE_URL}/#/settings`);
    
    // 输入 Admin Token
    await page.fill('input[type="password"]', ADMIN_TOKEN);
    await page.click('button:text("保存 Token")');
    
    await page.waitForSelector('.provider-gallery-card');
    
    // 验证 OpenRouter 显示"已配置"
    const openrouter = page.locator('.provider-gallery-card').filter({ hasText: 'OpenRouter' });
    await expect(openrouter).toContainText('已配置');
    
    // 验证阿里云百炼显示"入口型"
    const bailian = page.locator('.provider-gallery-card').filter({ hasText: '阿里云百炼' });
    await expect(bailian).toContainText('入口型');
  });

  test('账号首页显示控制', async ({ page }) => {
    await page.goto(`${BASE_URL}/#/settings`);
    await page.fill('input[type="password"]', ADMIN_TOKEN);
    await page.click('button:text("保存 Token")');
    
    await page.waitForSelector('.homepage-account-item');
    
    // 点击停用按钮
    const disableBtn = page.locator('button:text("停用")').first();
    if (await disableBtn.count() > 0) {
      await disableBtn.click();
      await page.waitForTimeout(500);
      
      // 验证账号移动到未启用列表
      const unenabledItem = page.locator('.homepage-account-item:not(.is-enabled)');
      await expect(unenabledItem).toBeVisible();
    }
  });
});
```

## 运行命令

```powershell
# 安装 Playwright
npm install -D @playwright/test

# 运行测试
npx playwright test tests/e2e/settings-layered.spec.ts

# 带浏览器查看
npx playwright test tests/e2e/settings-layered.spec.ts --headed
```
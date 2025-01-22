import { chromium } from 'playwright';
import { EventEmitter } from 'events';
import logger from '@/lib/logger.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';

export class CloudflareAuth extends EventEmitter {
  private credentials = {
    // cfBm: '',
    userToken: '',
    cookies: '',
    headers: {}
  };

  constructor(private refreshTime = 50 * 60 * 1000) { // 50 minutes
    super();
  }

  async init() {
    try {
      logger.info('Initializing Cloudflare authentication');
      await this.refreshAuth();
      
      setInterval(() => {
        this.refreshAuth().catch(err => {
          logger.error('Auth refresh failed:', err);
        });
      }, this.refreshTime);
      
    } catch (error) {
      logger.error('Cloudflare auth initialization failed:', error);
      throw new APIException(EX.API_REQUEST_FAILED, 'Failed to initialize Cloudflare auth');
    }
  }

  private async refreshAuth() {
    logger.info('Starting browser for auth refresh');
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox']
      }).catch(error => {
        logger.error('Failed to launch browser:', error.message);
        if (error.message.includes('Executable not found')) {
          logger.error('Chromium executable not found. Make sure Playwright is properly installed.');
        }
        throw new APIException(EX.API_REQUEST_FAILED, 
          `Failed to launch browser: ${error.message}. Check if Playwright and its dependencies are properly installed.`);
      });

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        // timezoneId: 'Asia/Shanghai'
      });

      const page = await context.newPage();
      logger.info('Refreshing Cloudflare authentication');

      // Intercepter la requête principale après le bypass Cloudflare
      await page.route('**/*', async (route) => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          // Convertir les headers en objet standard
          const headers = request.headers();
          this.credentials.headers = { ...headers };
        }
        await route.continue();
      });

      await page.goto('https://chat.deepseek.com');
      await page.waitForLoadState('networkidle');

      // Check if not blocked by Cloudflare
      const pageSource = await page.content();
      if (!pageSource.includes('deepseek')) {
        throw new Error('Blocked by Cloudflare');
      }

      const cookies = await context.cookies();
      this.credentials.cookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      
      const cfBm = cookies.find(c => c.name === '__cf_bm');
      if (cfBm) {
        // this.credentials.cfBm = cfBm.value;
        logger.info('Successfully obtained __cf_bm cookie and other cookies');
      } else {
        throw new Error('Failed to get __cf_bm cookie and other cookies');
      }

      const userToken = await page.evaluate(() => localStorage.getItem('userToken'));
      if (userToken) {
        this.credentials.userToken = userToken;
        logger.info('Successfully obtained userToken');
      } else {
        throw new Error('Failed to get userToken');
      }

      this.emit('credentials-updated', this.credentials);

    } catch (error) {
      logger.error('Auth refresh failed:', error);
      throw error;
    } finally {
      if (browser) {
        logger.info('Closing browser');
        await browser.close().catch(err => 
          logger.error('Error closing browser:', err)
        );
      }
    }
  }

  getHeaders() {
    return this.credentials.headers;
  }

  getCookieString() {
    return this.credentials.cookies;
  }

  getUserToken() {
    return this.credentials.userToken;
  }

  updateCookie(name: string, value: string) {
    // Mettre à jour un cookie spécifique
    const cookies = this.credentials.cookies.split('; ');
    const updatedCookies = cookies.map(cookie => {
      const [cookieName] = cookie.split('=');
      if (cookieName === name) {
        return `${name}=${value}`;
      }
      return cookie;
    });
    
    // Si le cookie n'existait pas, l'ajouter
    if (!cookies.some(c => c.startsWith(`${name}=`))) {
      updatedCookies.push(`${name}=${value}`);
    }
    
    this.credentials.cookies = updatedCookies.join('; ');
    
    // Mettre à jour aussi cfBm si c'est le cookie Cloudflare
//     if (name === '__cf_bm') {
//       this.credentials.cfBm = value;
//     }
  }
} 
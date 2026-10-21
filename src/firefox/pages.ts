/**
 * Page/Tab/Window management
 */

import { WebDriver } from 'selenium-webdriver';
import type { BrowsingContext } from 'webdriver-bidi-protocol';
import { CreateType, ReadinessState, type BiDiFacade } from './bidi.js';
import { log, logDebug } from '../utils/logger.js';

const COMMON_URL_SCHEMES = ['http:', 'https:', 'data:', 'blob:', 'file:'];
const PAGES_SANDBOX = 'page-management';
// script.evaluate cannot answer while the content process is busy, so a hung tab must not block the whole tab list
const TITLE_TIMEOUT_MS = 1000;

/**
 * Check if a URL uses a common scheme that supports load events.
 * Non-common schemes = moz-extension:, about:, ...
 */
export function isCommonScheme(url: string): boolean {
  try {
    return COMMON_URL_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * WebDriver BiDi browsingContext.ReadinessState.
 * - "none": return as soon as navigation starts
 * - "interactive": wait for DOMContentLoaded
 * - "complete": wait for the load event, including subresources
 */
export const READINESS_STATES = [...Object.values(ReadinessState)];

export function isReadinessState(value: unknown): value is BrowsingContext.ReadinessState {
  return READINESS_STATES.includes(value as BrowsingContext.ReadinessState);
}

export class PageManagement {
  constructor(
    private driver: WebDriver,
    private getCurrentContextId: () => string | null,
    private setCurrentContextId: (id: string | null) => void,
    private sendBiDiCommand: BiDiFacade['sendCommand']
  ) {}

  /**
   * Navigate to URL using BiDi
   *
   * @param url - Target URL
   * @param waitOverride - Explicit readiness state to wait for. When omitted,
   *   common schemes wait for "interactive" and uncommon schemes do not wait.
   */
  async navigate(url: string, waitOverride?: BrowsingContext.ReadinessState): Promise<void> {
    const contextId = this.getCurrentContextId();
    if (!contextId) {
      throw new Error(`Cannot navigate: no browsing context ID`);
    }

    // Default wait time is "interactive" (DOMContentLoaded).
    // All uncommon schemes use wait time "none".
    // An explicit override is honoured for every scheme: silently downgrading it
    // would discard what the caller asked for with no way to tell.
    const wait =
      waitOverride ?? (isCommonScheme(url) ? ReadinessState.Interactive : ReadinessState.None);

    // Navigate using direct BiDi
    await this.sendBiDiCommand('browsingContext.navigate', {
      context: contextId,
      url,
      wait,
    });

    logDebug(`BiDi navigate (wait:${wait}) to: ${url}`);
    log(`Navigated to: ${url}`);
  }

  /**
   * Navigate back in history
   */
  async navigateBack(): Promise<void> {
    await this.driver.navigate().back();
  }

  /**
   * Navigate forward in history
   */
  async navigateForward(): Promise<void> {
    await this.driver.navigate().forward();
  }

  /**
   * Set viewport size
   */
  async setViewportSize(width: number, height: number): Promise<void> {
    await this.driver.manage().window().setRect({ width, height });
  }

  /**
   * Accept dialog (alert/confirm/prompt)
   * @param promptText - Optional text to enter in prompt dialog
   */
  async acceptDialog(promptText?: string): Promise<void> {
    try {
      const alert = await this.driver.switchTo().alert();
      if (promptText !== undefined) {
        await alert.sendKeys(promptText);
      }
      await alert.accept();
    } catch (error) {
      throw new Error(
        `Failed to accept dialog: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Dismiss dialog (alert/confirm/prompt)
   */
  async dismissDialog(): Promise<void> {
    try {
      const alert = await this.driver.switchTo().alert();
      await alert.dismiss();
    } catch (error) {
      throw new Error(
        `Failed to dismiss dialog: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private cachedTabs: Array<{ actor: string; title: string; url: string }> = [];
  private cachedSelectedIdx: number = 0;
  // Tabs selected before, most recent last, to return to when the selected tab is closed.
  private previousContextIds: string[] = [];

  /**
   * Get all tabs (window handles)
   */
  getTabs(): Array<{ actor: string; title: string; url: string }> {
    return this.cachedTabs;
  }

  /**
   * Get selected tab index
   */
  getSelectedTabIdx(): number {
    return this.cachedSelectedIdx;
  }

  /**
   * Refresh tabs metadata - fetches all top-level browsing contexts and their URLs/titles
   */
  async refreshTabs(): Promise<void> {
    try {
      const { contexts } = await this.sendBiDiCommand('browsingContext.getTree', { maxDepth: 0 });

      this.cachedTabs = await Promise.all(
        contexts.map(async ({ context, url }) => ({
          actor: context,
          title: await this.getTitle(context),
          url: url || 'about:blank',
        }))
      );
      const currentId = this.getCurrentContextId();
      this.cachedSelectedIdx =
        currentId === null
          ? -1
          : Math.max(
              0,
              this.cachedTabs.findIndex((tab) => tab.actor === currentId)
            );
    } catch (error) {
      log(`Error refreshing tabs: ${error instanceof Error ? error.message : String(error)}`);
      // Fallback to single tab
      const currentId = this.getCurrentContextId();
      this.cachedTabs = [
        {
          actor: currentId || '',
          title: 'Current Tab',
          url: '',
        },
      ];
      this.cachedSelectedIdx = 0;
    }
  }

  private async getTitle(context: string): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.sendBiDiCommand('script.evaluate', {
          expression: 'document.title',
          awaitPromise: false,
          target: { context, sandbox: PAGES_SANDBOX },
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out')), TITLE_TIMEOUT_MS);
        }),
      ]);
      if (result.type === 'success' && result.result.type === 'string') {
        return result.result.value || 'Untitled';
      }
      return 'Untitled';
    } catch (error) {
      logDebug(
        `Failed to fetch title of tab ${context}: ${error instanceof Error ? error.message : String(error)}`
      );
      return '(unknown)';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Select tab by index
   */
  async selectTab(index: number): Promise<void> {
    const handle = this.cachedTabs[index]?.actor;
    if (handle) {
      this.rememberPreviousTab(handle);
      await this.driver.switchTo().window(handle);
      this.setCurrentContextId(handle);
      this.cachedSelectedIdx = index;
    }
  }

  /**
   * Create new page (tab)
   */
  async createNewPage(url: string, waitOverride?: BrowsingContext.ReadinessState): Promise<number> {
    const { context } = await this.sendBiDiCommand('browsingContext.create', {
      type: CreateType.Tab,
    });
    this.rememberPreviousTab(context);
    // Dialog handling and tab switching still go through the classic driver.
    await this.driver.switchTo().window(context);
    this.setCurrentContextId(context);
    await this.navigate(url, waitOverride);
    await this.refreshTabs();
    return this.cachedSelectedIdx;
  }

  /**
   * Close tab by index
   */
  async closeTab(index: number): Promise<void> {
    const handle = this.cachedTabs[index]?.actor;
    if (!handle) {
      return;
    }
    // Closing with BiDi does not need to switch to the tab, which would focus it.
    await this.sendBiDiCommand('browsingContext.close', { context: handle });
    this.cachedTabs = this.cachedTabs.filter((tab) => tab.actor !== handle);

    this.previousContextIds = this.previousContextIds.filter((id) =>
      this.cachedTabs.some((tab) => tab.actor === id)
    );

    if (handle === this.getCurrentContextId()) {
      let next: string | null = null;
      for (let previous = this.previousContextIds.pop(); previous; ) {
        try {
          await this.driver.switchTo().window(previous);
          next = previous;
          break;
        } catch (e) {
          logDebug(`Previously selected tab ${previous} is gone`, e);
          previous = this.previousContextIds.pop();
        }
      }
      this.setCurrentContextId(next);
    }
    const currentId = this.getCurrentContextId();
    this.cachedSelectedIdx =
      currentId === null
        ? -1
        : Math.max(
            0,
            this.cachedTabs.findIndex((tab) => tab.actor === currentId)
          );
  }

  private rememberPreviousTab(next: string): void {
    const current = this.getCurrentContextId();
    if (current && current !== next) {
      this.previousContextIds = [
        ...this.previousContextIds.filter((id) => id !== current),
        current,
      ];
    }
  }
}
